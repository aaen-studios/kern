//! Outbound webhook delivery.
//!
//! Every notification that flows through `watchdog::notify` is also POSTed to
//! the configured webhook (when enabled). Delivery is fire-and-forget on a
//! detached thread with a bounded timeout: a dead or slow endpoint must never
//! block a lifecycle action.
//!
//! Payload shape: `{"content": "...", "text": "..."}` — Discord reads
//! `content`, Slack incoming webhooks read `text`, and generic consumers get
//! both plus nothing else.

use std::time::Duration;

use tauri::AppHandle;

use crate::config;

const WEBHOOK_TIMEOUT: Duration = Duration::from_secs(10);

/// Builds the JSON payload (pure — unit-tested).
fn payload_for(kind: &str, title: &str, message: Option<&str>) -> serde_json::Value {
    let text = match message.map(str::trim) {
        Some(m) if !m.is_empty() => format!("[{kind}] {title}\n{m}"),
        _ => format!("[{kind}] {title}"),
    };
    serde_json::json!({ "content": text, "text": text })
}

/// POSTs a notification to the configured webhook, if enabled. Best-effort.
pub fn send(app: &AppHandle, kind: &str, title: &str, message: Option<&str>) {
    let Ok(cfg) = config::load_config(app) else {
        return;
    };
    if !cfg.settings.webhook_enabled {
        return;
    }
    let url = cfg.settings.webhook_url.trim().to_string();
    if url.is_empty() {
        return;
    }
    let payload = payload_for(kind, title, message);
    std::thread::spawn(move || {
        let result = ureq::post(&url)
            .config()
            .timeout_global(Some(WEBHOOK_TIMEOUT))
            .build()
            .send_json(payload);
        if let Err(e) = result {
            // stderr only: a failing webhook must not surface as an app error.
            eprintln!("[webhook] delivery failed: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_carries_both_discord_and_slack_keys() {
        let v = payload_for("error", "Server crashed", Some("exit 1"));
        assert_eq!(v["content"], "[error] Server crashed\nexit 1");
        assert_eq!(v["text"], v["content"]);
    }

    #[test]
    fn payload_without_message_is_title_only() {
        let v = payload_for("info", "Backup done", None);
        assert_eq!(v["content"], "[info] Backup done");
    }

    #[test]
    fn blank_message_is_ignored() {
        let v = payload_for("warn", "Health", Some("   "));
        assert_eq!(v["content"], "[warn] Health");
    }
}
