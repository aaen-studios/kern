//! Background job registry for remote-triggered long tasks (plugin installs).
//!
//! The web remote answers `202 { jobId }` immediately and the panel polls
//! `GET /jobs/{id}` until the task reports done or failed. Jobs are in-memory
//! and short-lived — finished entries older than an hour are pruned.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: String,
    /// `"running"`, `"done"`, or `"error"`.
    pub state: String,
    pub message: String,
    /// Epoch seconds when the job started.
    pub at: u64,
}

#[derive(Default)]
pub struct JobState(pub Mutex<HashMap<String, Job>>);

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Registers a running job and returns its id.
pub fn start(state: &JobState, kind: &str) -> String {
    let id = format!("job_{:x}", now_nanos());
    if let Ok(mut map) = state.0.lock() {
        if map.len() > 50 {
            let cutoff = now_secs().saturating_sub(3600);
            map.retain(|_, job| job.state == "running" || job.at >= cutoff);
        }
        map.insert(
            id.clone(),
            Job {
                id: id.clone(),
                kind: kind.to_string(),
                state: "running".to_string(),
                message: String::new(),
                at: now_secs(),
            },
        );
    }
    id
}

/// Marks a job finished (success message or error text).
pub fn finish(state: &JobState, id: &str, result: Result<String, String>) {
    if let Ok(mut map) = state.0.lock() {
        if let Some(job) = map.get_mut(id) {
            match result {
                Ok(message) => {
                    job.state = "done".to_string();
                    job.message = message;
                }
                Err(error) => {
                    job.state = "error".to_string();
                    job.message = error;
                }
            }
        }
    }
}

pub fn get(state: &JobState, id: &str) -> Option<Job> {
    state.0.lock().ok()?.get(id).cloned()
}
