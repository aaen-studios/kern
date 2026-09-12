//! kern-cli — scriptable control for a running kern app.
//!
//! Talks to the loopback automation API (`127.0.0.1`, Bearer token published
//! in `<app_data>/automation.json`). Console-first by design: human-readable
//! by default, `--json` for scripting.
//!
//! Usage:
//!   kern-cli status
//!   kern-cli list [--json]
//!   kern-cli start <id|name>
//!   kern-cli stop <id|name>
//!   kern-cli restart <id|name>
//!   kern-cli logs <id|name> [--lines N] [--follow]
//!   kern-cli say <id|name> <message…>
//!   kern-cli endpoint
//!
//! The endpoint file is written by the app on startup; `KERN_APP_DATA_DIR`
//! overrides the app-data location (used by the isolated E2E harness).

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

const USAGE: &str = "\
kern-cli — control a running kern app

USAGE:
  kern-cli status
  kern-cli list [--json]
  kern-cli start|stop|restart <id|name>
  kern-cli logs <id|name> [--lines N] [--follow]
  kern-cli say <id|name> <message…>
  kern-cli endpoint

FLAGS:
  --json    print the raw JSON response
";

struct Endpoint {
    url: String,
    token: String,
}

fn app_data_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("KERN_APP_DATA_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("com.ellio.kern"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support/com.ellio.kern"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .map(|base| base.join("com.ellio.kern"))
    }
}

fn load_endpoint() -> Result<Endpoint, String> {
    let dir = app_data_dir().ok_or("could not resolve the app data directory")?;
    let path = dir.join("automation.json");
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "could not read '{}': {e}\nIs the kern app running with automation enabled?",
            path.display()
        )
    })?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid endpoint file: {e}"))?;
    let port = value
        .get("port")
        .and_then(|p| p.as_u64())
        .ok_or("endpoint file has no port")?;
    let token = value
        .get("token")
        .and_then(|t| t.as_str())
        .ok_or("endpoint file has no token")?;
    if token.is_empty() {
        return Err("endpoint file has an empty token".to_string());
    }
    Ok(Endpoint {
        url: format!("http://127.0.0.1:{port}"),
        token: token.to_string(),
    })
}

fn request(endpoint: &Endpoint, method: &str, path: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", endpoint.url, path);
    let response = match method {
        "POST" => ureq::post(&url)
            .config()
            .timeout_global(Some(Duration::from_secs(30)))
            .build()
            .header("Authorization", &format!("Bearer {}", endpoint.token))
            .send_empty(),
        _ => ureq::get(&url)
            .config()
            .timeout_global(Some(Duration::from_secs(30)))
            .build()
            .header("Authorization", &format!("Bearer {}", endpoint.token))
            .call(),
    };
    let mut response = match response {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(code)) => {
            return Err(format!("request failed: HTTP {code}"));
        }
        Err(e) => return Err(format!("request failed: {e}")),
    };
    response
        .body_mut()
        .read_json::<serde_json::Value>()
        .map_err(|e| format!("invalid response: {e}"))
}

/// Resolves a user-supplied id or exact name to a server id.
fn resolve_id(endpoint: &Endpoint, needle: &str) -> Result<String, String> {
    let servers = request(endpoint, "GET", "/servers")?;
    let list = servers
        .get("servers")
        .and_then(|s| s.as_array())
        .ok_or("malformed server list")?;
    for server in list {
        let id = server.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id == needle {
            return Ok(id.to_string());
        }
    }
    for server in list {
        let name = server.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.eq_ignore_ascii_case(needle) {
            if let Some(id) = server.get("id").and_then(|v| v.as_str()) {
                return Ok(id.to_string());
            }
        }
    }
    let known: Vec<&str> = list
        .iter()
        .filter_map(|s| s.get("name").and_then(|v| v.as_str()))
        .collect();
    Err(format!(
        "no server matches '{needle}'. Known servers: {}",
        if known.is_empty() {
            "(none)".to_string()
        } else {
            known.join(", ")
        }
    ))
}

fn print_servers(value: &serde_json::Value) {
    let Some(list) = value.get("servers").and_then(|s| s.as_array()) else {
        println!("(no servers)");
        return;
    };
    if list.is_empty() {
        println!("(no servers)");
        return;
    }
    println!("{:<14} {:<14} NAME", "ID", "STATUS");
    for server in list {
        let id = server.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let status = server.get("status").and_then(|v| v.as_str()).unwrap_or("?");
        let name = server.get("name").and_then(|v| v.as_str()).unwrap_or("?");
        let orphan = server
            .get("orphaned")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        println!(
            "{id:<14} {status:<14} {name}{}",
            if orphan { " (orphaned)" } else { "" }
        );
    }
}

fn print_json(value: &serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
    );
}

fn error_message(value: &serde_json::Value) -> String {
    value
        .get("error")
        .and_then(|e| e.as_str())
        .unwrap_or("unknown error")
        .to_string()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let json = args.iter().any(|a| a == "--json");
    let positional: Vec<&str> = args
        .iter()
        .filter(|a| !a.starts_with("--"))
        .map(String::as_str)
        .collect();

    let Some(command) = positional.first().copied() else {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    };

    if matches!(command, "help" | "-h" | "--help") {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }

    let endpoint = match load_endpoint() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("kern-cli: {e}");
            return ExitCode::FAILURE;
        }
    };

    let result: Result<(), String> = (|| {
        match command {
            "endpoint" => {
                println!("{}", endpoint.url);
                Ok(())
            }
            "status" => {
                let value = request(&endpoint, "GET", "/status")?;
                if json {
                    print_json(&value);
                } else {
                    let version = value.get("version").and_then(|v| v.as_str()).unwrap_or("?");
                    println!("kern v{version} — automation ok ({})", endpoint.url);
                }
                Ok(())
            }
            "list" => {
                let value = request(&endpoint, "GET", "/servers")?;
                if json {
                    print_json(&value);
                } else {
                    print_servers(&value);
                }
                Ok(())
            }
            "start" | "stop" | "restart" => {
                let Some(needle) = positional.get(1) else {
                    return Err(format!("usage: kern-cli {command} <id|name>"));
                };
                let id = resolve_id(&endpoint, needle)?;
                let value = request(&endpoint, "POST", &format!("/servers/{id}/{command}"))?;
                if json {
                    print_json(&value);
                } else if value.get("error").is_some() {
                    return Err(error_message(&value));
                } else {
                    println!("{command}: {id} — ok");
                }
                Ok(())
            }
            "say" => {
                let Some(needle) = positional.get(1) else {
                    return Err("usage: kern-cli say <id|name> <message…>".to_string());
                };
                let message = positional.get(2..).unwrap_or(&[]).join(" ");
                if message.trim().is_empty() {
                    return Err("usage: kern-cli say <id|name> <message…>".to_string());
                }
                let id = resolve_id(&endpoint, needle)?;
                let url = format!("{}/servers/{id}/stdin", endpoint.url);
                let mut response = ureq::post(&url)
                    .config()
                    .timeout_global(Some(Duration::from_secs(30)))
                    .build()
                    .header("Authorization", &format!("Bearer {}", endpoint.token))
                    .send_json(serde_json::json!({ "line": message }))
                    .map_err(|e| format!("request failed: {e}"))?;
                let value: serde_json::Value = response
                    .body_mut()
                    .read_json()
                    .map_err(|e| format!("invalid response: {e}"))?;
                if json {
                    print_json(&value);
                } else {
                    println!("sent to {id}");
                }
                Ok(())
            }
            "logs" => {
                let Some(needle) = positional.get(1) else {
                    return Err("usage: kern-cli logs <id|name> [--lines N] [--follow]".to_string());
                };
                let lines = args
                    .iter()
                    .position(|a| a == "--lines")
                    .and_then(|i| args.get(i + 1))
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(200);
                let follow = args.iter().any(|a| a == "--follow");
                let id = resolve_id(&endpoint, needle)?;
                let mut shown = 0usize;
                loop {
                    let value = request(&endpoint, "GET", &format!("/servers/{id}/log?lines={lines}"))?;
                    let all: Vec<String> = value
                        .get("lines")
                        .and_then(|l| l.as_array())
                        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                        .unwrap_or_default();
                    if json && !follow {
                        print_json(&value);
                        return Ok(());
                    }
                    // On follow, only print what's new since the last poll.
                    let start = if shown == 0 {
                        all.len().saturating_sub(lines)
                    } else if all.len() >= shown {
                        shown
                    } else {
                        0 // log was truncated/rotated
                    };
                    for line in &all[start..] {
                        println!("{line}");
                    }
                    shown = all.len();
                    if !follow {
                        return Ok(());
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            other => Err(format!("unknown command '{other}' — run `kern-cli help`")),
        }
    })();

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("kern-cli: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_url_is_built_from_port() {
        let endpoint = Endpoint {
            url: "http://127.0.0.1:7442".to_string(),
            token: "t".to_string(),
        };
        assert!(endpoint.url.starts_with("http://127.0.0.1:"));
    }

    #[test]
    fn error_message_extracts_json_error() {
        let value = serde_json::json!({ "error": "server not found" });
        assert_eq!(error_message(&value), "server not found");
        let fallback = serde_json::json!({});
        assert_eq!(error_message(&fallback), "unknown error");
    }
}
