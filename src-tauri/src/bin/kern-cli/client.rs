//! Endpoint discovery + HTTP client for the kern automation API.
//!
//! Discovery order:
//!   1. `KERN_AUTOMATION_URL` + `KERN_AUTOMATION_TOKEN` (explicit override,
//!      useful for tunnels/CI).
//!   2. `<app_data>/automation.json` written by the running app, with the app
//!      data dir resolved from `KERN_APP_DATA_DIR` (debug builds / E2E) or the
//!      platform default.
//!
//! Errors carry an exit code so `main` can map them consistently.

use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

pub const EXIT_OK: u8 = 0;
pub const EXIT_ERROR: u8 = 1;
pub const EXIT_USAGE: u8 = 2;
pub const EXIT_NOT_FOUND: u8 = 3;
pub const EXIT_UNREACHABLE: u8 = 4;
pub const EXIT_TIMEOUT: u8 = 5;

/// A CLI failure with a scriptable exit code.
#[derive(Debug)]
pub enum CliError {
    /// The app can't be reached (not running, automation disabled, bad file).
    Unreachable(String),
    /// The requested server/plugin/backup/task doesn't exist.
    NotFound(String),
    /// A `--wait`/`--timeout` expired.
    Timeout(String),
    /// The API answered with an error status.
    Api { status: u16, message: String },
    /// Anything else (I/O, parse, usage).
    Error(String),
}

impl CliError {
    pub fn exit_code(&self) -> u8 {
        match self {
            CliError::Unreachable(_) => EXIT_UNREACHABLE,
            CliError::NotFound(_) => EXIT_NOT_FOUND,
            CliError::Timeout(_) => EXIT_TIMEOUT,
            CliError::Api { .. } | CliError::Error(_) => EXIT_ERROR,
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CliError::Unreachable(m)
            | CliError::NotFound(m)
            | CliError::Timeout(m)
            | CliError::Error(m) => write!(f, "{m}"),
            CliError::Api { status, message } => write!(f, "HTTP {status}: {message}"),
        }
    }
}

impl std::error::Error for CliError {}

pub type Result<T> = std::result::Result<T, CliError>;

/// The discovery document written by the running app.
#[derive(Debug, Clone)]
pub struct EndpointFile {
    pub path: PathBuf,
    pub version: u32,
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub started_at: u64,
}

/// Resolves the app data directory the same way the app does.
pub fn app_data_dir() -> Option<PathBuf> {
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

/// Reads + parses `<app_data>/automation.json`.
pub fn read_endpoint_file() -> Result<EndpointFile> {
    let dir = app_data_dir().ok_or_else(|| {
        CliError::Unreachable("could not resolve the kern app data directory".into())
    })?;
    let path = dir.join("automation.json");
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        CliError::Unreachable(format!(
            "could not read '{}': {e}\nIs kern running with the automation API enabled?",
            path.display()
        ))
    })?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|e| CliError::Unreachable(format!("invalid endpoint file: {e}")))?;
    let port = value
        .get("port")
        .and_then(Value::as_u64)
        .ok_or_else(|| CliError::Unreachable("endpoint file has no port".into()))?
        as u16;
    let token = value
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Unreachable("endpoint file has no token".into()))?
        .to_string();
    if token.is_empty() {
        return Err(CliError::Unreachable("endpoint file has an empty token".into()));
    }
    Ok(EndpointFile {
        path,
        version: value.get("version").and_then(Value::as_u64).unwrap_or(1) as u32,
        port,
        token,
        pid: value.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32,
        started_at: value.get("started_at").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// An authenticated automation API client.
#[derive(Debug, Clone)]
pub struct Client {
    pub url: String,
    pub token: String,
    pub endpoint: Option<EndpointFile>,
}

impl Client {
    /// Discovers the endpoint (env override → endpoint file).
    pub fn discover() -> Result<Self> {
        if let (Ok(url), Ok(token)) = (
            std::env::var("KERN_AUTOMATION_URL"),
            std::env::var("KERN_AUTOMATION_TOKEN"),
        ) {
            if !url.trim().is_empty() && !token.trim().is_empty() {
                return Ok(Client {
                    url: url.trim_end_matches('/').to_string(),
                    token,
                    endpoint: None,
                });
            }
        }
        let endpoint = read_endpoint_file()?;
        Ok(Client {
            url: format!("http://127.0.0.1:{}", endpoint.port),
            token: endpoint.token.clone(),
            endpoint: Some(endpoint),
        })
    }

    pub fn get(&self, path: &str) -> Result<Value> {
        self.request("GET", path, None, Duration::from_secs(30))
    }

    pub fn get_with_timeout(&self, path: &str, timeout: Duration) -> Result<Value> {
        self.request("GET", path, None, timeout)
    }

    pub fn post(&self, path: &str, body: Option<&Value>) -> Result<Value> {
        self.request("POST", path, body, Duration::from_secs(30))
    }

    pub fn patch(&self, path: &str, body: &Value) -> Result<Value> {
        self.request("PATCH", path, Some(body), Duration::from_secs(30))
    }

    pub fn delete(&self, path: &str) -> Result<Value> {
        self.request("DELETE", path, None, Duration::from_secs(30))
    }

    pub fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<Value> {
        let url = format!("{}{}", self.url, path);
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .build();
        let agent: ureq::Agent = config.into();

        let response = match method {
            "POST" => {
                let req = agent.post(&url).header("Authorization", &format!("Bearer {}", self.token));
                match body {
                    Some(value) => req.send_json(value),
                    None => req.send_empty(),
                }
            }
            "PATCH" => {
                let req = agent.patch(&url).header("Authorization", &format!("Bearer {}", self.token));
                match body {
                    Some(value) => req.send_json(value),
                    None => req.send_empty(),
                }
            }
            "DELETE" => {
                // ureq's DELETE builder is bodyless; DELETE requests here
                // never carry a body.
                agent
                    .delete(&url)
                    .header("Authorization", &format!("Bearer {}", self.token))
                    .call()
            }
            _ => agent.get(&url).header("Authorization", &format!("Bearer {}", self.token)).call(),
        };

        let mut response = match response {
            Ok(r) => r,
            Err(ureq::Error::Timeout(_)) => {
                return Err(CliError::Timeout(format!("request timed out after {timeout:?}")));
            }
            Err(e) => {
                return Err(CliError::Unreachable(format!(
                    "could not reach the kern app at {}: {e}",
                    self.url
                )));
            }
        };

        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .read_to_string()
            .map_err(|e| CliError::Error(format!("invalid response: {e}")))?;
        let value: Value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text)
                .map_err(|e| CliError::Error(format!("invalid JSON response: {e}\n{text}")))? 
        };

        if status >= 400 {
            let message = value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| text.trim().to_string());
            if status == 404 {
                return Err(CliError::NotFound(message));
            }
            if status == 401 {
                return Err(CliError::Unreachable(format!(
                    "unauthorized — the token in {} is stale (restarting kern rewrites it)\n{message}",
                    self.endpoint
                        .as_ref()
                        .map(|e| e.path.display().to_string())
                        .unwrap_or_else(|| "the endpoint file".to_string())
                )));
            }
            return Err(CliError::Api { status, message });
        }

        Ok(value)
    }
}
