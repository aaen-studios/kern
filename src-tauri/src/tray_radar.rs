//! Live tray radar.
//!
//! Animates the system tray icon as a miniature of the app's matrix radar:
//! one pulsing blip per running server, a sweep whose speed follows aggregate
//! CPU load, and health coloring (green → amber above an instance's alert
//! threshold → crimson blink on faults). Rendered in Rust so it keeps working
//! while the window is hidden in the tray.
//!
//! The driver samples `ProcessRegistry` + `MetricsState` once a second and
//! repaints at a platform cadence (`TICK_MS`). It parks — restoring the static
//! state icon via [`crate::tray::refresh_menu`] — when nothing is running and
//! no fault exists, so an idle kern costs nothing. While animating it owns the
//! icon; `tray::refresh_menu` checks [`is_animating`] before repainting.
//!
//! The renderer (`render_frame`) is pure (no Tauri types) so it is unit
//! tested on every CI platform; the pixel math follows the `polarRadar`
//! blueprint in `documentation/DesignGuide.md` §4.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::config;
use crate::metrics::MetricsState;
use crate::process;

/// Repaint cadence. Windows/macOS tray icons update cheaply; Linux
/// appindicators can flicker on rapid `set_icon`, so they get a slower sweep.
#[cfg(target_os = "linux")]
const TICK_MS: u64 = 1000;
#[cfg(not(target_os = "linux"))]
const TICK_MS: u64 = 250;

/// The renderer assumes this many visual ticks per second for sweep/pulse/blink
/// timing; slower platforms advance several visual ticks per repaint so the
/// motion stays the same speed regardless of cadence.
const VISUAL_FPS: u64 = 4;
const TICK_STEP: u64 = VISUAL_FPS * TICK_MS / 1000;

/// Tray icon raster size. Matches the bundled base icon; the OS downscales.
const ICON_SIZE: u32 = 32;

/// More than this many blips stop being legible at tray scale. Extra servers
/// still appear in the tray menu; the radar shows the first N by id.
const MAX_BLIPS: usize = 12;

/// Sweep advance per visual tick: ~0.44 rad/s idle → ~1.6 rad/s at full load.
const SWEEP_BASE_RAD: f32 = 0.11;
const SWEEP_CPU_RAD: f32 = 0.30;
/// Fraction of the circle behind the beam that still glows.
const TRAIL_FRACTION: f32 = 0.30;
/// Ticks per blip pulse cycle (2s at 4 fps).
const PULSE_TICKS: f32 = 8.0;
/// Gaussian-ish blip glow radius in pixels.
const BLIP_REACH: f32 = 3.0;

const TAU: f32 = std::f32::consts::TAU;

// ── kern palette (src/styles/global.css tokens) ─────────────────────────────
const SIGNAL: [u8; 3] = [0x4c, 0xf5, 0xa0];
const WARN: [u8; 3] = [0xf5, 0xa0, 0x4c];
const FAULT: [u8; 3] = [0xf5, 0x4c, 0x4c];
const ZINC: [u8; 3] = [0x8a, 0x8f, 0x9a];
const PLATE: [u8; 3] = [0x08, 0x09, 0x0d];
const RIM: [u8; 3] = [0x1d, 0x21, 0x2b];
const RING: [u8; 3] = [0x2b, 0x31, 0x3d];
const PLATE_ALPHA: u8 = 230;

/// Aggregate health for the sweep + core color.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    Nominal,
    Degraded,
    Fault,
}

impl Health {
    fn rgb(self) -> [u8; 3] {
        match self {
            Health::Nominal => SIGNAL,
            Health::Degraded => WARN,
            Health::Fault => FAULT,
        }
    }
}

/// Per-instance blip coloring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlipColor {
    Signal,
    Warn,
    Fault,
    /// Re-adopted PID-only monitors: alive, but without log/stdin control.
    Dim,
}

impl BlipColor {
    fn rgb(self) -> [u8; 3] {
        match self {
            BlipColor::Signal => SIGNAL,
            BlipColor::Warn => WARN,
            BlipColor::Fault => FAULT,
            BlipColor::Dim => ZINC,
        }
    }
}

/// One star in the radar. `angle` is radians, `radius` a fraction of the
/// plate radius, `phase` offsets the pulse cycle (0..1).
#[derive(Debug, Clone, Copy)]
pub struct Blip {
    pub angle: f32,
    pub radius: f32,
    pub phase: f32,
    pub color: BlipColor,
}

/// A single animation frame description.
#[derive(Debug, Clone)]
pub struct RadarSpec {
    pub size: u32,
    pub tick: u64,
    pub cpu: f32,
    pub fault: bool,
    pub severity: Health,
    pub blips: Vec<Blip>,
}

/// Renders one RGBA frame. Pure and deterministic — the unit tests live on it.
pub fn render_frame(spec: &RadarSpec) -> Vec<u8> {
    let size = spec.size.max(8);
    let mut pixels = vec![0u8; size as usize * size as usize * 4];
    let center = (size as f32 - 1.0) / 2.0;
    let plate_r = (size as f32 / 2.0 - 0.5).max(3.0);
    let beam = spec.severity.rgb();
    let brightness = if spec.fault && blink_dim(spec.tick) {
        0.28
    } else {
        1.0
    };
    let cpu = spec.cpu.clamp(0.0, 1.0);
    let sweep = spec.tick as f32 * (SWEEP_BASE_RAD + cpu * SWEEP_CPU_RAD);
    let trail = TAU * TRAIL_FRACTION;

    for (i, pixel) in pixels.chunks_exact_mut(4).enumerate() {
        let x = (i % size as usize) as f32;
        let y = (i / size as usize) as f32;
        let dx = x - center;
        let dy = y - center;
        let r = (dx * dx + dy * dy).sqrt();

        // Outside the plate: transparent.
        if r > plate_r {
            continue;
        }

        let mut rgb = PLATE;
        let mut alpha = PLATE_ALPHA;

        // Outer rim + faint grid rings.
        if (r - plate_r).abs() < 0.7 {
            rgb = RIM;
            alpha = 255;
        }
        for k in [0.45_f32, 0.72] {
            if (r - plate_r * k).abs() < 0.6 {
                rgb = blend(rgb, RING, 0.85);
                alpha = 255;
            }
        }

        // Core: aggregate health dot.
        if r < 1.6 {
            rgb = blend(rgb, beam, brightness);
            alpha = 255;
        } else {
            // Sweep beam with a trailing falloff behind it.
            let angle = dy.atan2(dx);
            let mut behind = (sweep - angle) % TAU;
            if behind < 0.0 {
                behind += TAU;
            }
            if behind < trail {
                let falloff = (1.0 - behind / trail).powi(2);
                rgb = blend(rgb, beam, falloff * brightness);
                alpha = 255;
            }
        }

        // Blips stack on top; the strongest contribution wins.
        let mut blip_t = 0.0_f32;
        let mut blip_rgb = SIGNAL;
        for blip in &spec.blips {
            let bx = center + blip.radius * plate_r * blip.angle.cos();
            let by = center + blip.radius * plate_r * blip.angle.sin();
            let d = ((x - bx).powi(2) + (y - by).powi(2)).sqrt();
            if d > BLIP_REACH {
                continue;
            }
            let pulse = if blip.color == BlipColor::Dim {
                0.6
            } else {
                pulse_at(spec.tick, blip.phase)
            };
            let t = if d <= 1.0 {
                pulse
            } else {
                (1.0 - d / BLIP_REACH) * pulse * 0.8
            };
            if t > blip_t {
                blip_t = t;
                blip_rgb = blip.color.rgb();
            }
        }
        if blip_t > 0.0 {
            rgb = blend(rgb, blip_rgb, blip_t * brightness);
            alpha = 255;
        }

        pixel.copy_from_slice(&[rgb[0], rgb[1], rgb[2], alpha]);
    }

    pixels
}

/// Blip brightness at a visual tick (0.45..1.0), phase-shifted per blip.
fn pulse_at(tick: u64, phase: f32) -> f32 {
    let wave = (TAU * (tick as f32 / PULSE_TICKS + phase)).sin();
    (0.45 + 0.55 * wave).clamp(0.0, 1.0)
}

/// Fault frames alternate bright/dim every two visual ticks (~0.5s at 4 fps).
fn blink_dim(tick: u64) -> bool {
    (tick / 2) % 2 == 1
}

fn blend(dst: [u8; 3], src: [u8; 3], t: f32) -> [u8; 3] {
    let t = t.clamp(0.0, 1.0);
    let mix = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t).round() as u8;
    [
        mix(dst[0], src[0]),
        mix(dst[1], src[1]),
        mix(dst[2], src[2]),
    ]
}

/// Stable FNV-1a hash so each server keeps the same slot across frames.
fn hash_id(id: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Maps an instance id to a stable (angle, radius, pulse phase) slot.
fn blip_slot(id: &str) -> (f32, f32, f32) {
    let hash = hash_id(id);
    let angle = (hash & 0xffff) as f32 / 65535.0 * TAU;
    let radius = 0.34 + ((hash >> 16) & 0xff) as f32 / 255.0 * 0.5;
    let phase = ((hash >> 24) & 0xff) as f32 / 255.0;
    (angle, radius, phase)
}

/// Shared control flags for the animation driver.
pub struct RadarControl {
    /// True while the driver owns the tray icon (a frame is on screen and the
    /// loop is still animating). `tray::refresh_menu` consults this so it
    /// doesn't clobber an in-flight frame with the static state icon.
    pub animating: AtomicBool,
    /// Mirrors `AppSettings::tray_radar`; updated by `update_app_settings`.
    pub enabled: AtomicBool,
}

impl Default for RadarControl {
    fn default() -> Self {
        Self {
            animating: AtomicBool::new(false),
            enabled: AtomicBool::new(true),
        }
    }
}

/// True while the radar animation is painting the tray icon.
pub fn is_animating(app: &AppHandle) -> bool {
    app.try_state::<RadarControl>()
        .map(|control| control.animating.load(Ordering::Relaxed))
        .unwrap_or(false)
}

/// Starts the background animation loop. Call once from `setup`, after the
/// tray icon exists. The [`RadarControl`] state is registered on the builder.
pub fn spawn(app: &AppHandle) {
    let enabled = config::load_config(app)
        .map(|cfg| cfg.settings.tray_radar)
        .unwrap_or(true);
    app.state::<RadarControl>()
        .enabled
        .store(enabled, Ordering::Relaxed);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Let tray setup + the first menu refresh settle before painting.
        std::thread::sleep(Duration::from_millis(750));

        let mut tick: u64 = 0;
        let mut snapshot = sample(&handle);
        let mut sampled_at = Instant::now();
        let mut animating = false;

        loop {
            std::thread::sleep(Duration::from_millis(TICK_MS));

            let enabled = handle
                .state::<RadarControl>()
                .enabled
                .load(Ordering::Relaxed);
            if !enabled {
                if animating {
                    park(&handle);
                    animating = false;
                }
                continue;
            }

            if sampled_at.elapsed() >= Duration::from_secs(1) {
                snapshot = sample(&handle);
                sampled_at = Instant::now();
            }

            // Nothing to show: hand the icon back to the static state icon.
            if snapshot.blips.is_empty() && !snapshot.fault {
                if animating {
                    park(&handle);
                    animating = false;
                }
                continue;
            }

            tick = tick.wrapping_add(TICK_STEP);
            let spec = RadarSpec {
                size: ICON_SIZE,
                tick,
                cpu: snapshot.cpu,
                fault: snapshot.fault,
                severity: snapshot.severity,
                blips: snapshot.blips.clone(),
            };
            if let Some(tray) = handle.tray_by_id("main") {
                let frame = render_frame(&spec);
                let icon = tauri::image::Image::new_owned(frame, ICON_SIZE, ICON_SIZE);
                let _ = tray.set_icon(Some(icon));
            }
            if !animating {
                handle
                    .state::<RadarControl>()
                    .animating
                    .store(true, Ordering::Relaxed);
                animating = true;
            }
        }
    });
}

/// Stops owning the icon and restores the static state icon.
fn park(app: &AppHandle) {
    app.state::<RadarControl>()
        .animating
        .store(false, Ordering::Relaxed);
    crate::tray::refresh_menu(app);
}

/// A once-per-second snapshot of the fleet, used to build radar frames.
struct Snapshot {
    blips: Vec<Blip>,
    cpu: f32,
    fault: bool,
    severity: Health,
}

fn sample(app: &AppHandle) -> Snapshot {
    let registry = app.state::<process::ProcessRegistry>();
    let metrics_state = app.state::<MetricsState>();
    let loaded = config::load_config(app);

    // Faults include instances that aren't running (a crash the user hasn't
    // acknowledged), matching the static icon's alert behavior.
    let fault_ids: HashSet<String> = loaded
        .as_ref()
        .map(|cfg| {
            cfg.servers
                .values()
                .filter(|s| s.status == "error" || s.status == "stopped-forced")
                .map(|s| s.id.clone())
                .collect()
        })
        .unwrap_or_default();

    let mut entries: Vec<(String, Blip)> = Vec::new();
    let mut cpu_sum = 0.0_f32;
    let mut cpu_count = 0_u32;
    let mut degraded = false;

    // One process-table refresh drives every instance (per-call refreshes
    // would reset the CPU delta window and read ~0% for all but the first).
    let running_ids = registry.running_ids();
    let root_pids: Vec<u32> = running_ids
        .iter()
        .map(|id| registry.pid_for(id).unwrap_or(0))
        .collect();
    let all_metrics = metrics_state.instances_metrics(&root_pids, "running");

    for id in running_ids {
        let pid = registry.pid_for(&id).unwrap_or(0);
        let (cpu, ram) = all_metrics
            .get(&pid)
            .map(|m| (m.cpu, m.ram))
            .unwrap_or((0.0, 0.0));
        cpu_sum += cpu;
        cpu_count += 1;

        let fault = fault_ids.contains(&id);
        let over_threshold = loaded
            .as_ref()
            .ok()
            .and_then(|cfg| cfg.servers.get(&id))
            .map(|s| {
                s.alert_rules.cpu_threshold.is_some_and(|t| cpu > t)
                    || s.alert_rules.ram_threshold.is_some_and(|t| ram > t)
            })
            .unwrap_or(false);

        let color = if fault {
            BlipColor::Fault
        } else if over_threshold {
            degraded = true;
            BlipColor::Warn
        } else if registry.is_adopted(&id) {
            BlipColor::Dim
        } else {
            BlipColor::Signal
        };

        let (angle, radius, phase) = blip_slot(&id);
        entries.push((
            id,
            Blip {
                angle,
                radius,
                phase,
                color,
            },
        ));
    }

    // Stable visual order: truncation and stacking must not depend on the
    // registry's map iteration order.
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries.truncate(MAX_BLIPS);

    let fault = !fault_ids.is_empty();
    let severity = if fault {
        Health::Fault
    } else if degraded {
        Health::Degraded
    } else {
        Health::Nominal
    };
    let cpu = if cpu_count > 0 {
        cpu_sum / cpu_count as f32
    } else {
        0.0
    };

    Snapshot {
        blips: entries.into_iter().map(|(_, blip)| blip).collect(),
        cpu,
        fault,
        severity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_spec(tick: u64, cpu: f32, fault: bool) -> RadarSpec {
        RadarSpec {
            size: ICON_SIZE,
            tick,
            cpu,
            fault,
            severity: if fault {
                Health::Fault
            } else {
                Health::Nominal
            },
            blips: Vec::new(),
        }
    }

    fn alpha_at(frame: &[u8], x: u32, y: u32) -> u8 {
        frame[((y * ICON_SIZE + x) as usize) * 4 + 3]
    }

    fn rgb_at(frame: &[u8], x: u32, y: u32) -> [u8; 3] {
        let i = ((y * ICON_SIZE + x) as usize) * 4;
        [frame[i], frame[i + 1], frame[i + 2]]
    }

    #[test]
    fn frame_is_rgba_sized() {
        let frame = render_frame(&base_spec(0, 0.0, false));
        assert_eq!(frame.len(), (ICON_SIZE * ICON_SIZE * 4) as usize);
    }

    #[test]
    fn plate_covers_center_but_not_corners() {
        let frame = render_frame(&base_spec(0, 0.0, false));
        assert_eq!(alpha_at(&frame, ICON_SIZE / 2, ICON_SIZE / 2), 255);
        assert_eq!(alpha_at(&frame, 0, 0), 0);
        assert_eq!(alpha_at(&frame, ICON_SIZE - 1, 0), 0);
        assert_eq!(alpha_at(&frame, 0, ICON_SIZE - 1), 0);
    }

    #[test]
    fn blip_lights_its_slot_signal_green() {
        let blip = Blip {
            angle: 0.0,
            radius: 0.6,
            phase: 0.0,
            color: BlipColor::Signal,
        };
        // Visual tick 2 of the 8-tick pulse is this blip's peak brightness.
        let mut spec = base_spec(2, 0.0, false);
        spec.blips.push(blip);
        let frame = render_frame(&spec);

        let center = (ICON_SIZE as f32 - 1.0) / 2.0;
        let plate_r = ICON_SIZE as f32 / 2.0 - 0.5;
        let x = (center + 0.6 * plate_r).round() as u32;
        let y = center.round() as u32;
        let [r, g, b] = rgb_at(&frame, x, y);
        assert!(
            g > r && g > b,
            "blip pixel should be signal green, got {r},{g},{b}"
        );
    }

    #[test]
    fn fault_frames_blink_between_ticks() {
        assert!(!blink_dim(0));
        assert!(blink_dim(2));
        let bright = render_frame(&base_spec(0, 0.2, true));
        let dim = render_frame(&base_spec(2, 0.2, true));
        assert_ne!(bright, dim);
    }

    #[test]
    fn sweep_tracks_tick_and_cpu() {
        let idle = render_frame(&base_spec(3, 0.0, false));
        let loaded = render_frame(&base_spec(3, 1.0, false));
        assert_ne!(idle, loaded, "cpu load must move the sweep");
        let advanced = render_frame(&base_spec(4, 0.0, false));
        assert_ne!(idle, advanced, "the sweep must advance with the tick");
    }

    #[test]
    fn blip_slots_are_stable_and_in_bounds() {
        let first = blip_slot("server-alpha");
        let second = blip_slot("server-alpha");
        assert_eq!(first.0, second.0);
        assert_eq!(first.1, second.1);
        assert_eq!(first.2, second.2);

        let (angle, radius, phase) = first;
        assert!((0.0..TAU).contains(&angle));
        assert!((0.34..=0.84).contains(&radius));
        assert!((0.0..=1.0).contains(&phase));

        assert_ne!(blip_slot("alpha"), blip_slot("beta"));
    }

    #[test]
    fn pulse_stays_within_bounds_for_every_phase() {
        for tick in 0..64 {
            for phase in [0.0, 0.25, 0.5, 0.75, 1.0] {
                let value = pulse_at(tick, phase);
                assert!((0.0..=1.0).contains(&value), "tick {tick} phase {phase}");
            }
        }
    }
}
