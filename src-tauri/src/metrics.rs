//! Live process + host telemetry for the matrix shader engine.
//!
//! Feeds `ShaderTelemetry` (src/types/matrix.ts) from the `sysinfo` crate so the
//! radar sweep reacts to real load instead of a hardcoded constant.
//!
//! Sampling is pull-based: the frontend's `useMetrics` hook polls
//! `get_instance_metrics` / `get_host_metrics` on an interval. A single shared
//! `System` is held as Tauri managed state and refreshed on each query. Because
//! `sysinfo` computes per-process CPU as a delta between refreshes, the first
//! poll after a launch reads ~0% and corrects on the next — which reads as a
//! natural spin-up over the first second.

use std::collections::HashSet;
use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{Pid, ProcessesToUpdate, System};

/// Mirrors `ShaderTelemetry` in src/types/matrix.ts (camelCase on the wire).
///
/// `cpu` and `ram` are normalized to `0.0..=1.0`. `status` is a free-form label
/// forwarded verbatim to the shader (e.g. "running", "host", "orphaned").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceMetrics {
    /// Process-tree CPU load, normalized to `0.0..=1.0` (1.0 = all cores maxed).
    pub cpu: f32,
    /// Process-tree resident memory as a fraction of total RAM (`0.0..=1.0`).
    pub ram: f32,
    /// Status label passed through to the shader.
    pub status: String,
}

/// Shared `sysinfo` state. One `System` is created eagerly and refreshed under a
/// mutex on every query — cheaper than re-enumerating the process list from
/// scratch each poll, and the mutex is held only for the duration of a refresh.
#[derive(Default)]
pub struct MetricsState(pub Mutex<System>);

impl MetricsState {
    /// Computes host-wide telemetry: global CPU average (0..1) and the fraction
    /// of total RAM currently in use (0..1).
    pub fn host_metrics(&self) -> InstanceMetrics {
        let mut sys = self.0.lock().expect("metrics state lock poisoned");
        sys.refresh_cpu_usage();
        sys.refresh_memory();

        // `global_cpu_usage()` is already the per-core-averaged 0..100 value, so
        // no further division by core count is needed here.
        let cpu = sys.global_cpu_usage() / 100.0;
        let total = sys.total_memory();
        let used = sys.used_memory();
        let ram = if total > 0 { used as f32 / total as f32 } else { 0.0 };

        InstanceMetrics {
            cpu: cpu.clamp(0.0, 1.0),
            ram: ram.clamp(0.0, 1.0),
            status: "host".to_string(),
        }
    }

    /// Computes telemetry for a running instance by summing CPU + memory across
    /// the process tree rooted at `root_pid` (the launched command may spawn
    /// worker children — e.g. a node parent + workers, or cargo + rustc).
    ///
    /// Returns `None` if the root PID can no longer be resolved (process exited
    /// between the registry lookup and this refresh); the caller then falls back
    /// to a zeroed/idle telemetry reading.
    pub fn instance_metrics(&self, root_pid: u32, status: &str) -> Option<InstanceMetrics> {
        let mut sys = self.0.lock().expect("metrics state lock poisoned");

        // Refresh every process's CPU + memory, dropping dead entries so exited
        // children stop accumulating. (Targeting just the subtree would require
        // knowing all descendant PIDs up front; a full refresh is cheap enough at
        // a 1 Hz poll cadence and keeps the tree walk correct.)
        sys.refresh_processes(ProcessesToUpdate::All, true);

        let root = Pid::from_u32(root_pid);
        sys.process(root)?;

        let cpus = sys.cpus().len().max(1) as f32;
        let total_mem = sys.total_memory();

        // Collect the subtree rooted at `root_pid`. A process belongs to the tree
        // if walking its parent chain eventually reaches the root; we compute that
        // by scanning all processes and including any whose ancestor is the root.
        let mut in_tree: HashSet<Pid> = HashSet::new();
        in_tree.insert(root);

        // Iterate to a fixed point: keep scanning until no new descendants are
        // found. A single extra pass after each discovery covers trees that branch
        // more than one level deep per scan — bounded by tree depth, which is tiny.
        loop {
            let before = in_tree.len();
            for (pid, proc) in sys.processes() {
                if in_tree.contains(pid) {
                    continue;
                }
                if let Some(parent) = proc.parent() {
                    if in_tree.contains(&parent) {
                        in_tree.insert(*pid);
                    }
                }
            }
            if in_tree.len() == before {
                break;
            }
        }

        let mut cpu_sum = 0f32;
        let mut mem_sum: u64 = 0;
        for pid in &in_tree {
            if let Some(proc) = sys.process(*pid) {
                // cpu_usage() is summed across all cores, so it can exceed 100 on
                // a multi-core box. Dividing by the core count yields a 0..100
                // single-core-equivalent before the final /100 → 0..1.
                cpu_sum += proc.cpu_usage();
                mem_sum += proc.memory();
            }
        }

        let cpu = (cpu_sum / cpus / 100.0).clamp(0.0, 1.0);
        let ram = if total_mem > 0 {
            (mem_sum as f32 / total_mem as f32).clamp(0.0, 1.0)
        } else {
            0.0
        };

        Some(InstanceMetrics {
            cpu,
            ram,
            status: status.to_string(),
        })
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Historical metrics — a rolling in-memory ring buffer sampled by the
// background worker. Powers the 24h/7d resource graphs. Kept in memory (not
// persisted) to avoid write churn; a long-running host accumulates plenty.
// ──────────────────────────────────────────────────────────────────────────

use std::collections::VecDeque;

/// A single telemetry sample at a point in time.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricSample {
    /// Epoch seconds.
    pub at: u64,
    /// CPU fraction 0.0..=1.0.
    pub cpu: f32,
    /// RAM fraction 0.0..=1.0.
    pub ram: f32,
}

/// How long a sample is retained. ~7 days at a 60s cadence ≈ 10k samples.
const MAX_SAMPLES: usize = 10_000;

/// Per-instance rolling history. Keyed by instance id.
#[derive(Default)]
pub struct MetricsHistory(pub Mutex<std::collections::HashMap<String, VecDeque<MetricSample>>>);

impl MetricsHistory {
    /// Appends a sample for an instance, capping the buffer length.
    pub fn record(&self, id: &str, sample: MetricSample) {
        if let Ok(mut map) = self.0.lock() {
            let buf = map.entry(id.to_string()).or_default();
            buf.push_back(sample);
            while buf.len() > MAX_SAMPLES {
                buf.pop_front();
            }
        }
    }

    /// Returns samples within `[since_secs, now]`, oldest first.
    pub fn query(&self, id: &str, since_secs: u64) -> Vec<MetricSample> {
        let Ok(map) = self.0.lock() else {
            return Vec::new();
        };
        let Some(buf) = map.get(id) else {
            return Vec::new();
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let cutoff = now.saturating_sub(since_secs);
        buf.iter()
            .filter(|s| s.at >= cutoff)
            .copied()
            .collect()
    }

    /// Drops history for a deleted instance.
    pub fn forget(&self, id: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(id);
        }
    }
}
