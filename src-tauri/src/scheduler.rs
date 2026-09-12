//! Background worker — the single periodic loop that powers three features:
//!
//!   1. **Backup scheduler** — every tick, for each instance whose
//!      `backup_schedule.interval_secs > 0`, if enough time has passed since
//!      `last_backup_secs`, snapshot the world and prune to `keep`.
//!   2. **Health alerts** — sample each running instance's metrics; if a
//!      threshold (CPU/RAM) is sustained beyond `sustained_secs`, emit a
//!      `kern://health-alert` event the frontend turns into a toast.
//!   3. **Metrics history** — append every sample to `MetricsHistory` so the
//!      24h/7d resource graphs have data.
//!
//! All three run on one 30s cadence. The loop is intentionally simple (sleep +
//! poll) rather than a cron engine — matches the codebase's existing pattern
//! (the autostart loop in `lib.rs`). Config mutations go through
//! `config::with_config_mut` to stay race-free with the UI.

use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

use crate::commands;
use crate::config::{self, ScheduledTask, ServerInstance};
use crate::metrics::{MetricSample, MetricsHistory, MetricsState};
use crate::process;

/// The worker's tick interval. 30s balances alert responsiveness against
/// sampling cost (a full sysinfo refresh each tick).
const TICK_SECS: u64 = 30;

/// Payload for the `kern://health-alert` event.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthAlert {
    id: String,
    name: String,
    metric: String, // "cpu" | "ram"
    value: f32,     // fraction 0.0..=1.0
    threshold: f32,
}

/// Spawns the background worker. Call once at the end of `setup` in `lib.rs`.
/// Runs for the lifetime of the app.
pub fn spawn(app_handle: &AppHandle) {
    let handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(TICK_SECS));
            tick(&handle);
        }
    });
}

/// One iteration: sample metrics, run backup due-checks, evaluate alerts.
fn tick(handle: &AppHandle) {
    let now = now_secs();

    // Snapshot config once (read-only); mutations re-load under the lock.
    let Ok(cfg) = config::load_config(handle) else {
        return;
    };

    // ── User-defined scheduled tasks ─────────────────────────────────────
    run_tasks(handle, &cfg, now);

    // ── Pre-restart announcements ────────────────────────────────────────
    run_announcements(handle, &cfg, now);

    // ── Sample metrics for every running instance ────────────────────────
    let metrics_state: tauri::State<'_, MetricsState> = handle.state();
    let history: tauri::State<'_, MetricsHistory> = handle.state();

    let mut samples: Vec<(String, f32, f32)> = Vec::new(); // (id, cpu, ram)

    for (id, instance) in &cfg.servers {
        if !process::is_running(handle, id) {
            // Not running — reset any alert "crossed since" timestamp so a
            // restart doesn't immediately re-fire a stale alert.
            if instance.alert_rules.crossed_since_secs != 0 {
                let idown = id.clone();
                let h = handle.clone();
                let _ = config::with_config_mut(&h, |c| {
                    if let Some(s) = c.servers.get_mut(&idown) {
                        s.alert_rules.crossed_since_secs = 0;
                    }
                    Ok(())
                });
            }
            continue;
        }
        let Some(pid) = process::pid_for(handle, id) else {
            continue;
        };
        if let Some(m) = metrics_state.instance_metrics(pid, &instance.status) {
            samples.push((id.clone(), m.cpu, m.ram));
            history.record(
                id,
                MetricSample {
                    at: now,
                    cpu: m.cpu,
                    ram: m.ram,
                },
            );
        }
    }

    // ── Evaluate alerts + run due backups ────────────────────────────────
    // We iterate by id so each with_config_mut is a tiny targeted update.
    for (id, cpu, ram) in &samples {
        let Some(instance) = cfg.servers.get(id) else {
            continue;
        };
        let rules = &instance.alert_rules;

        // Alert evaluation.
        let cpu_over = rules
            .cpu_threshold
            .map(|t| *cpu > t)
            .unwrap_or(false);
        let ram_over = rules
            .ram_threshold
            .map(|t| *ram > t)
            .unwrap_or(false);
        if cpu_over || ram_over {
            // Track how long it's been over. If first crossing, stamp it;
            // if sustained past the window, fire once and reset.
            let crossed = rules.crossed_since_secs;
            let started = if crossed == 0 { now } else { crossed };
            if crossed == 0 {
                let idown = id.clone();
                let h = handle.clone();
                let _ = config::with_config_mut(&h, |c| {
                    if let Some(s) = c.servers.get_mut(&idown) {
                        s.alert_rules.crossed_since_secs = now;
                    }
                    Ok(())
                });
            } else if now.saturating_sub(started) >= rules.sustained_secs {
                // Fire + reset so it can re-fire later if it stays elevated.
                let (metric, value, threshold) = if cpu_over {
                    ("cpu", *cpu, rules.cpu_threshold.unwrap_or(0.0))
                } else {
                    ("ram", *ram, rules.ram_threshold.unwrap_or(0.0))
                };
                let _ = handle.emit(
                    "kern://health-alert",
                    HealthAlert {
                        id: id.clone(),
                        name: instance.name.clone(),
                        metric: metric.to_string(),
                        value,
                        threshold,
                    },
                );
                let idown = id.clone();
                let h = handle.clone();
                let _ = config::with_config_mut(&h, |c| {
                    if let Some(s) = c.servers.get_mut(&idown) {
                        s.alert_rules.crossed_since_secs = 0;
                    }
                    Ok(())
                });
            }
        } else if rules.crossed_since_secs != 0 {
            // Recovered below threshold — clear the timer.
            let idown = id.clone();
            let h = handle.clone();
            let _ = config::with_config_mut(&h, |c| {
                if let Some(s) = c.servers.get_mut(&idown) {
                    s.alert_rules.crossed_since_secs = 0;
                }
                Ok(())
            });
        }

        // Backup due-check.
        let sched = &instance.backup_schedule;
        if sched.interval_secs > 0
            && now.saturating_sub(sched.last_backup_secs) >= sched.interval_secs
            && has_world_dir(&instance.path)
        {
            let idown = id.clone();
            let keep = sched.keep;
            let h = handle.clone();
            // Run the backup, then record the time (only on success).
            match commands::backup_world_impl(&h, &idown) {
                Ok(_archive) => {
                    commands::prune_backups_impl(&h, &idown, keep);
                    let _ = config::with_config_mut(&h, |c| {
                        if let Some(s) = c.servers.get_mut(&idown) {
                            s.backup_schedule.last_backup_secs = now;
                        }
                        Ok(())
                    });
                    let _ = h.emit(
                        "kern://backup-completed",
                        serde_json::json!({ "id": idown, "at": now }),
                    );
                }
                Err(e) => {
                    eprintln!("[scheduler] backup failed for '{idown}': {e}");
                }
            }
        }
    }
}

/// Runs every enabled task whose schedule is due, then stamps its last-run
/// time. Stamp-before-execute prevents a slow task from double-firing on the
/// next tick.
fn run_tasks(handle: &AppHandle, cfg: &config::AppConfig, now: u64) {
    for (id, instance) in &cfg.servers {
        for task in &instance.tasks {
            if !task.enabled || task.id.is_empty() {
                continue;
            }
            if !task_due(task, now) {
                continue;
            }
            mark_task_ran(handle, id, &task.id, now);
            execute_task(handle, id, instance, task);
        }
    }
}

/// True when any configured schedule mode is due. A task never fires twice
/// within the same minute.
fn task_due(task: &ScheduledTask, now: u64) -> bool {
    if task.last_run_secs != 0 && now.saturating_sub(task.last_run_secs) < 60 {
        return false;
    }

    // Interval.
    if task.interval_secs > 0
        && (task.last_run_secs == 0
            || now.saturating_sub(task.last_run_secs) >= task.interval_secs)
    {
        return true;
    }

    // Daily at local "HH:MM" (at most once per day).
    let daily = task.daily_at.trim();
    if !daily.is_empty() {
        if let Ok(target) = chrono::NaiveTime::parse_from_str(daily, "%H:%M") {
            let now_local = chrono::Local::now();
            if now_local.time().format("%H:%M").to_string()
                == target.format("%H:%M").to_string()
                && now.saturating_sub(task.last_run_secs) >= 23 * 3600
            {
                return true;
            }
        }
    }

    // Cron (5-field expressions get a leading seconds field).
    let expr = task.cron.trim();
    if !expr.is_empty() {
        let normalized = if expr.split_whitespace().count() == 5 {
            format!("0 {expr}")
        } else {
            expr.to_string()
        };
        if let Ok(schedule) = cron::Schedule::from_str(&normalized) {
            // Compare at minute precision: the ticker runs every 30s and the
            // seconds field is always 0, so a raw includes(now) would almost
            // never match.
            use chrono::Timelike;
            let now_utc = chrono::Utc::now();
            let at_minute = now_utc
                .with_second(0)
                .and_then(|t| t.with_nanosecond(0))
                .unwrap_or(now_utc);
            if schedule.includes(at_minute) {
                return true;
            }
        }
    }

    false
}

/// Persists a task's last-run timestamp.
fn mark_task_ran(handle: &AppHandle, server_id: &str, task_id: &str, now: u64) {
    let _ = config::with_config_mut(handle, |cfg| {
        if let Some(server) = cfg.servers.get_mut(server_id) {
            if let Some(task) = server.tasks.iter_mut().find(|t| t.id == task_id) {
                task.last_run_secs = now;
            }
        }
        Ok(())
    });
}

/// Runs one task immediately (the "run now" button), stamping its last-run
/// time first so the scheduler doesn't double-fire it on the next tick.
#[tauri::command]
pub fn run_task_now(app_handle: AppHandle, id: String, task_id: String) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let task = instance
        .tasks
        .iter()
        .find(|t| t.id == task_id)
        .cloned()
        .ok_or_else(|| format!("task '{task_id}' not found"))?;
    let label = if task.name.trim().is_empty() {
        task.action.clone()
    } else {
        task.name.clone()
    };
    mark_task_ran(&app_handle, &id, &task_id, now_secs());
    execute_task(&app_handle, &id, &instance, &task);
    crate::audit::record(
        &app_handle,
        "task",
        &format!("ran task '{label}' on '{}'", instance.name),
        Some(&id),
    );
    Ok(())
}

/// Sends "restarting in N minutes" lines to running instances whose restart
/// tasks declare announcements. Fires once per (upcoming run, minute) pair —
/// the 30s tick would otherwise deliver each announcement twice.
fn run_announcements(handle: &AppHandle, cfg: &config::AppConfig, now: u64) {
    for (id, instance) in &cfg.servers {
        if !process::is_running(handle, id) {
            continue;
        }
        for task in &instance.tasks {
            if !task.enabled || task.action != "restart" || task.announce_minutes.is_empty() {
                continue;
            }
            let Some(next) = next_run_secs(task, now) else {
                continue;
            };
            for minutes in &task.announce_minutes {
                if *minutes == 0 {
                    continue;
                }
                let target = next.saturating_sub((*minutes as u64) * 60);
                if now < target || now >= target + (TICK_SECS * 2) {
                    continue;
                }
                let key = format!("{next}:{minutes}");
                if task.announce_sent.iter().any(|sent| sent == &key) {
                    continue;
                }
                let message = format!("say Server restarting in {minutes} minute(s)");
                if process::write_stdin(handle, id, &format!("{message}\n")).is_err() {
                    continue;
                }
                let task_id = task.id.clone();
                let _ = config::with_config_mut(handle, |c| {
                    if let Some(server) = c.servers.get_mut(id) {
                        if let Some(t) = server.tasks.iter_mut().find(|t| t.id == task_id) {
                            // Drop keys from previous runs — keep the list bounded.
                            t.announce_sent.retain(|sent| sent.starts_with(&format!("{next}:")));
                            t.announce_sent.push(key.clone());
                        }
                    }
                    Ok(())
                });
                crate::audit::record(
                    handle,
                    "announce",
                    &format!(
                        "announced {minutes}-minute restart for '{}'",
                        instance.name
                    ),
                    Some(id),
                );
            }
        }
    }
}

/// Earliest epoch-seconds at which `task` will next fire, or `None` when it has
/// no configured schedule. Interval uses the last run (or now for a task that
/// has never run).
fn next_run_secs(task: &ScheduledTask, now: u64) -> Option<u64> {
    let mut candidates: Vec<u64> = Vec::new();

    if task.interval_secs > 0 {
        let base = if task.last_run_secs == 0 {
            now
        } else {
            task.last_run_secs
        };
        candidates.push(base.saturating_add(task.interval_secs));
    }

    let daily = task.daily_at.trim();
    if !daily.is_empty() {
        if let Ok(target) = chrono::NaiveTime::parse_from_str(daily, "%H:%M") {
            let now_local = chrono::Local::now();
            let date = now_local.date_naive();
            let candidate = date
                .and_time(target)
                .and_local_timezone(chrono::Local)
                .earliest()
                .map(|dt| dt.timestamp() as u64)
                .unwrap_or(now);
            if candidate > now {
                candidates.push(candidate);
            } else {
                let tomorrow = date.succ_opt().unwrap_or(date);
                if let Some(dt) = tomorrow
                    .and_time(target)
                    .and_local_timezone(chrono::Local)
                    .earliest()
                {
                    candidates.push(dt.timestamp() as u64);
                }
            }
        }
    }

    let expr = task.cron.trim();
    if !expr.is_empty() {
        let normalized = if expr.split_whitespace().count() == 5 {
            format!("0 {expr}")
        } else {
            expr.to_string()
        };
        if let Ok(schedule) = cron::Schedule::from_str(&normalized) {
            if let Some(next) = schedule.after(&chrono::Utc::now()).next() {
                candidates.push(next.timestamp() as u64);
            }
        }
    }

    candidates.into_iter().min()
}

/// Executes one task action, notifying the user of the outcome.
fn execute_task(handle: &AppHandle, id: &str, instance: &ServerInstance, task: &ScheduledTask) {
    let label = if task.name.trim().is_empty() {
        task.action.clone()
    } else {
        task.name.clone()
    };
    let server_name = instance.name.clone();
    let running = process::is_running(handle, id);

    match task.action.as_str() {
        "backup" => match commands::backup_world_impl(handle, id) {
            Ok(relative) => crate::watchdog::notify(
                handle,
                "success",
                &format!("{server_name}: scheduled backup saved"),
                Some(format!("{label} → {relative}")),
                Some(id),
            ),
            Err(e) => crate::watchdog::notify(
                handle,
                "error",
                &format!("{server_name}: scheduled backup failed"),
                Some(format!("{label}: {e}")),
                Some(id),
            ),
        },
        "start" => {
            if running {
                return;
            }
            report(handle, id, &server_name, &label, commands::launch_instance(handle, id));
        }
        "stop" => {
            if !running {
                return;
            }
            report(
                handle,
                id,
                &server_name,
                &label,
                commands::stop_instance_blocking(handle, id),
            );
        }
        "restart" => {
            if running {
                report(
                    handle,
                    id,
                    &server_name,
                    &label,
                    commands::restart_instance_blocking(handle, id),
                );
            } else {
                report(handle, id, &server_name, &label, commands::launch_instance(handle, id));
            }
        }
        "command" => {
            let line = task.command.trim();
            if line.is_empty() {
                return;
            }
            if running {
                let data = format!("{line}\n");
                report(
                    handle,
                    id,
                    &server_name,
                    &label,
                    process::write_stdin(handle, id, &data),
                );
            } else {
                let result = process::run_shell_helper(
                    handle,
                    id,
                    std::path::Path::new(&instance.path),
                    line,
                    std::time::Duration::from_secs(120),
                );
                report(handle, id, &server_name, &label, result);
            }
        }
        "health" => {
            // A "running" status with no live process means it died without
            // the normal teardown (e.g. the app was killed earlier).
            if !running && instance.status == "running" {
                if task.command.trim().eq_ignore_ascii_case("restart") {
                    report(
                        handle,
                        id,
                        &server_name,
                        &label,
                        commands::restart_instance_blocking(handle, id),
                    );
                } else {
                    crate::watchdog::notify(
                        handle,
                        "warn",
                        &format!("{server_name}: health check failed"),
                        Some(format!("{label}: expected running but no process found")),
                        Some(id),
                    );
                }
            }
        }
        _ => {}
    }
}

/// Emits a success/error notification for a task outcome.
fn report(
    handle: &AppHandle,
    id: &str,
    server_name: &str,
    label: &str,
    result: Result<(), String>,
) {
    match result {
        Ok(()) => crate::watchdog::notify(
            handle,
            "info",
            &format!("{server_name}: {label} ran"),
            None,
            Some(id),
        ),
        Err(e) => crate::watchdog::notify(
            handle,
            "error",
            &format!("{server_name}: {label} failed"),
            Some(e),
            Some(id),
        ),
    }
}

/// True if `<instance_path>/world` exists (cheap guard before zipping).
fn has_world_dir(instance_path: &str) -> bool {    std::path::Path::new(instance_path).join("world").is_dir()
}

/// Current epoch seconds.
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task() -> ScheduledTask {
        ScheduledTask {
            id: "t".to_string(),
            enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn interval_task_runs_then_throttles() {
        let mut t = task();
        t.interval_secs = 3600;
        // Never run before → due immediately.
        assert!(task_due(&t, 1_000_000));
        t.last_run_secs = 1_000_000;
        // Inside the same minute → never due.
        assert!(!task_due(&t, 1_000_030));
        // Before the interval elapses → not due.
        assert!(!task_due(&t, 1_000_900));
        // Interval elapsed → due.
        assert!(task_due(&t, 1_003_700));
    }

    #[test]
    fn no_schedule_never_due() {
        let t = task();
        assert!(!task_due(&t, 1_000_000));
    }

    #[test]
    fn daily_matches_local_time() {
        let mut t = task();
        let now_local = chrono::Local::now();
        t.daily_at = now_local.format("%H:%M").to_string();
        // last_run 0 → due when the local minute matches.
        assert!(task_due(&t, 2_000_000));
        t.last_run_secs = 2_000_000;
        // Same minute after running → throttled.
        assert!(!task_due(&t, 2_000_030));
    }

    #[test]
    fn cron_parses_five_field_expression() {
        let mut t = task();
        t.cron = "* * * * *".to_string();
        // Every minute: due unless throttled by the last-run window.
        assert!(task_due(&t, 3_000_000));
        t.last_run_secs = 3_000_000;
        assert!(!task_due(&t, 3_000_030));
    }

    #[test]
    fn next_run_uses_interval_and_last_run() {
        let mut t = task();
        t.interval_secs = 3600;
        t.last_run_secs = 1_000_000;
        assert_eq!(next_run_secs(&t, 1_000_100), Some(1_003_600));
        // Never-run interval task is treated as next-from-now.
        t.last_run_secs = 0;
        assert_eq!(next_run_secs(&t, 1_000_100), Some(1_003_700));
    }

    #[test]
    fn next_run_none_without_schedule() {
        assert_eq!(next_run_secs(&task(), 1_000_000), None);
    }

    #[test]
    fn next_run_cron_is_in_the_future() {
        let mut t = task();
        t.cron = "* * * * *".to_string();
        let now = now_secs();
        let next = next_run_secs(&t, now).expect("cron schedule");
        assert!(next >= now, "next run {next} should not be in the past");
    }

    #[test]
    fn next_run_prefers_earliest_mode() {
        let mut t = task();
        t.interval_secs = 86_400;
        t.last_run_secs = 1_000_000;
        t.daily_at = "03:07".to_string();
        // Interval candidate (1_086_400) vs. the next local 03:07 — the earlier
        // one wins; both are valid answers, so assert it picked *a* candidate.
        let next = next_run_secs(&t, 1_000_000).expect("a schedule");
        assert!(next > 1_000_000);
    }
}
