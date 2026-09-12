//! Log-pattern alerts.
//!
//! User-defined regex rules are matched against every streamed server log
//! line; a match emits a notification (and therefore a native toast and a
//! webhook via the shared notification path). Rules come from
//! `settings.log_alerts` and are compiled once into a managed state, reloaded
//! whenever settings are saved.
//!
//! A per-(instance, rule) cooldown keeps a repeating error line from
//! spamming the notification center.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use tauri::{AppHandle, Manager};

use crate::config;
use crate::watchdog;

/// Per-rule cooldown: a matching line only notifies once per window.
const COOLDOWN_SECS: u64 = 60;
/// Longest log line excerpt attached to a notification.
const EXCERPT_MAX: usize = 200;

struct CompiledRule {
    id: String,
    name: String,
    regex: Regex,
}

/// Compiled rules + cooldown bookkeeping.
#[derive(Default)]
pub struct LogAlertState {
    rules: Mutex<Vec<CompiledRule>>,
    last_fired: Mutex<HashMap<String, u64>>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Compiles `settings.log_alerts` into the managed state. Invalid regexes are
/// skipped (with a stderr note) so one bad rule can't disable the others.
pub fn reload(app: &AppHandle) {
    let state: tauri::State<'_, LogAlertState> = app.state();
    let mut compiled = Vec::new();
    if let Ok(cfg) = config::load_config(app) {
        for rule in &cfg.settings.log_alerts {
            if !rule.enabled || rule.pattern.trim().is_empty() {
                continue;
            }
            match Regex::new(&rule.pattern) {
                Ok(regex) => compiled.push(CompiledRule {
                    id: if rule.id.is_empty() {
                        rule.pattern.clone()
                    } else {
                        rule.id.clone()
                    },
                    name: if rule.name.trim().is_empty() {
                        rule.pattern.clone()
                    } else {
                        rule.name.clone()
                    },
                    regex,
                }),
                Err(e) => eprintln!("[log-alert] invalid pattern '{}': {e}", rule.pattern),
            }
        }
    }
    {
        // Scope the guard (and its temporary Result) to an inner block so it's
        // dropped before `state`, which the borrow checker otherwise flags.
        let guard = state.rules.lock();
        if let Ok(mut rules) = guard {
            *rules = compiled;
        }
    }
}

/// Checks one line against every rule; emits a notification on a match.
/// Cheap no-op when no rules are configured.
pub fn check(app: &AppHandle, instance_id: &str, line: &str) {
    let state: tauri::State<'_, LogAlertState> = app.state();
    let Ok(rules) = state.rules.lock() else {
        return;
    };
    if rules.is_empty() {
        return;
    }
    let matches: Vec<(String, String)> = rules
        .iter()
        .filter(|rule| rule.regex.is_match(line))
        .map(|rule| (rule.id.clone(), rule.name.clone()))
        .collect();
    drop(rules);
    if matches.is_empty() {
        return;
    }

    let now = now_secs();
    let server_name = config::load_config(app)
        .ok()
        .and_then(|c| c.servers.get(instance_id).map(|s| s.name.clone()))
        .unwrap_or_else(|| instance_id.to_string());

    for (rule_id, rule_name) in matches {
        let key = format!("{instance_id}:{rule_id}");
        {
            let Ok(mut fired) = state.last_fired.lock() else {
                continue;
            };
            // Prune stale entries so the map stays small.
            fired.retain(|_, at| now.saturating_sub(*at) < COOLDOWN_SECS * 10);
            if let Some(at) = fired.get(&key) {
                if now.saturating_sub(*at) < COOLDOWN_SECS {
                    continue;
                }
            }
            fired.insert(key, now);
        }
        let excerpt: String = line.chars().take(EXCERPT_MAX).collect();
        watchdog::notify(
            app,
            "warn",
            &format!("{server_name}: log alert '{rule_name}'"),
            Some(excerpt),
            Some(instance_id),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_match_case_sensitively() {
        let regex = Regex::new("OutOfMemoryError").unwrap();
        assert!(regex.is_match("[12:00:00] java.lang.OutOfMemoryError: Java heap space"));
        assert!(!regex.is_match("outofmemoryerror"));
    }

    #[test]
    fn regex_syntax_is_rust_compatible() {
        // Patterns users commonly paste from other tools still compile.
        assert!(Regex::new(r"(?i)exception|error").is_ok());
        assert!(Regex::new(r"\[Server thread/ERROR\]").is_ok());
    }
}
