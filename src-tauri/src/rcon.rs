//! RCON (Source RCON protocol) client.
//!
//! Used for the per-instance console, player management, and status queries.
//! The password is stored in the OS credential vault (service `kern.rcon`,
//! user = instance id); only host/port live in config.json.
//!
//! Protocol: little-endian `i32` length + `i32` request id + `i32` type +
//! body + two NUL bytes. Auth = type 3, command = type 2, response = type 0.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

use crate::config;

const AUTH_TYPE: i32 = 3;
const EXEC_TYPE: i32 = 2;
const RESPONSE_TYPE: i32 = 0;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PACKET: i32 = 4096;

const KEYRING_SERVICE: &str = "kern.rcon";

/// Connection settings + whether a password is configured.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RconStatus {
    pub host: String,
    pub port: u16,
    pub has_password: bool,
}

/// Result of a player-list query.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RconPlayers {
    pub raw: String,
    pub players: Vec<String>,
}

fn load_instance(app_handle: &AppHandle, id: &str) -> Result<config::ServerInstance, String> {
    let cfg = config::load_config(app_handle)?;
    cfg.servers
        .get(id)
        .cloned()
        .ok_or_else(|| format!("server '{id}' not found"))
}

fn password_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, id)
        .map_err(|e| format!("credential store unavailable: {e}"))
}

fn read_password(id: &str) -> Result<Option<String>, String> {
    match password_entry(id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("failed to read RCON password: {e}")),
    }
}

fn write_packet(stream: &mut TcpStream, id: i32, kind: i32, body: &str) -> Result<(), String> {
    let body_bytes = body.as_bytes();
    let length = (body_bytes.len() + 10) as i32;
    let mut packet = Vec::with_capacity(length as usize + 4);
    packet.extend_from_slice(&length.to_le_bytes());
    packet.extend_from_slice(&id.to_le_bytes());
    packet.extend_from_slice(&kind.to_le_bytes());
    packet.extend_from_slice(body_bytes);
    packet.extend_from_slice(&[0, 0]);
    stream
        .write_all(&packet)
        .map_err(|e| format!("RCON write failed: {e}"))
}

fn read_packet(stream: &mut TcpStream) -> Result<(i32, i32, String), String> {
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .map_err(|e| format!("RCON read failed: {e}"))?;
    let length = i32::from_le_bytes(len_buf);
    if !(10..=MAX_PACKET).contains(&length) {
        return Err(format!("RCON packet length out of range: {length}"));
    }
    let mut buf = vec![0u8; length as usize];
    stream
        .read_exact(&mut buf)
        .map_err(|e| format!("RCON read failed: {e}"))?;
    let id = i32::from_le_bytes(buf[0..4].try_into().unwrap_or([0; 4]));
    let kind = i32::from_le_bytes(buf[4..8].try_into().unwrap_or([0; 4]));
    // Strip the trailing two NUL bytes.
    let body_end = buf.len().saturating_sub(2);
    let body = String::from_utf8_lossy(&buf[8..body_end]).to_string();
    Ok((id, kind, body))
}

/// Opens an authenticated connection.
fn connect(instance: &config::ServerInstance, password: &str) -> Result<TcpStream, String> {
    let addr_str = format!("{}:{}", instance.rcon.host, instance.rcon.port);
    let addr: SocketAddr = addr_str
        .to_socket_addrs()
        .map_err(|e| format!("invalid RCON address '{addr_str}': {e}"))?
        .next()
        .ok_or_else(|| format!("could not resolve RCON address '{addr_str}'"))?;

    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
        .map_err(|e| format!("RCON connect to {addr_str} failed: {e}"))?;
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

    write_packet(&mut stream, 1, AUTH_TYPE, password)?;
    // Servers vary: some reply with an empty RESPONSE_VALUE before the auth
    // result; accept up to three packets.
    for _ in 0..3 {
        let (id, kind, _body) = read_packet(&mut stream)?;
        if kind == AUTH_TYPE || kind == 2 {
            if id == 1 {
                return Ok(stream);
            }
            if id == -1 {
                return Err("RCON authentication failed (wrong password?)".to_string());
            }
        }
        if kind != RESPONSE_TYPE {
            return Err("RCON authentication failed".to_string());
        }
    }
    Err("RCON authentication failed".to_string())
}

fn exec_on(stream: &mut TcpStream, command: &str) -> Result<String, String> {
    write_packet(stream, 2, EXEC_TYPE, command)?;
    // Response bodies may span packets; accumulate until a read times out or an
    // empty body arrives. `list` replies are single-packet on all mainstream
    // servers, so one non-empty body is typically enough.
    let mut out = String::new();
    loop {
        match read_packet(stream) {
            Ok((_id, kind, body)) if kind == RESPONSE_TYPE => {
                if body.is_empty() {
                    break;
                }
                out.push_str(&body);
                break;
            }
            Ok(_) => continue,
            Err(_) => break,
        }
    }
    Ok(out)
}

fn connect_for(app_handle: &AppHandle, id: &str) -> Result<(config::ServerInstance, TcpStream), String> {
    let instance = load_instance(app_handle, id)?;
    let password = read_password(id)?
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "no RCON password configured for this instance".to_string())?;
    let stream = connect(&instance, &password)?;
    Ok((instance, stream))
}

/// Removes the stored password for an instance (used when it is deleted).
pub fn clear_password(id: &str) {
    if let Ok(entry) = password_entry(id) {
        let _ = entry.delete_credential();
    }
}

/// Returns the stored connection settings + whether a password exists.
#[tauri::command]
pub fn rcon_get_status(app_handle: AppHandle, id: String) -> Result<RconStatus, String> {
    let instance = load_instance(&app_handle, &id)?;
    Ok(RconStatus {
        host: instance.rcon.host.clone(),
        port: instance.rcon.port,
        has_password: read_password(&id)?.is_some(),
    })
}

/// Saves host/port and (optionally) the password.
/// `password`: `Some("")` clears it, `Some(value)` sets it, `None` leaves it.
#[tauri::command]
pub fn rcon_set_config(
    app_handle: AppHandle,
    id: String,
    host: String,
    port: u16,
    password: Option<String>,
) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("host must not be empty".to_string());
    }
    config::with_config_mut(&app_handle, |cfg| {
        if let Some(instance) = cfg.servers.get_mut(&id) {
            instance.rcon.host = host.to_string();
            instance.rcon.port = port;
        }
        Ok(())
    })?;

    match password {
        Some(p) if p.is_empty() => {
            match password_entry(&id)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(format!("failed to clear RCON password: {e}")),
            }
        }
        Some(p) => {
            password_entry(&id)?
                .set_password(&p)
                .map_err(|e| format!("failed to store RCON password: {e}"))?;
        }
        None => {}
    }
    Ok(())
}

/// Tests the connection (connect + authenticate).
#[tauri::command]
pub fn rcon_test(app_handle: AppHandle, id: String) -> Result<(), String> {
    let (_instance, _stream) = connect_for(&app_handle, &id)?;
    Ok(())
}

/// Runs one console command and returns the server's response.
#[tauri::command]
pub fn rcon_execute(app_handle: AppHandle, id: String, command: String) -> Result<String, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("command must not be empty".to_string());
    }
    let (_instance, mut stream) = connect_for(&app_handle, &id)?;
    exec_on(&mut stream, command)
}

/// Runs `list` and parses the online players.
#[tauri::command]
pub fn rcon_players(app_handle: AppHandle, id: String) -> Result<RconPlayers, String> {
    let (_instance, mut stream) = connect_for(&app_handle, &id)?;
    let raw = exec_on(&mut stream, "list")?;
    Ok(RconPlayers {
        players: parse_players(&raw),
        raw,
    })
}

/// Parses the player names out of a `list` response, e.g.
/// `There are 2 of a max of 20 players online: alice, bob`.
fn parse_players(raw: &str) -> Vec<String> {
    let Some((_, names)) = raw.split_once(':') else {
        return Vec::new();
    };
    names
        .split(',')
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_player_list() {
        let raw = "There are 2 of a max of 20 players online: alice, bob";
        assert_eq!(parse_players(raw), vec!["alice", "bob"]);
        assert!(parse_players("There are 0 of a max of 20 players online:").is_empty());
        assert!(parse_players("unknown command").is_empty());
    }

    #[test]
    fn player_names_with_spaces_are_trimmed() {
        let raw = "There are 3 of a max of 20 players online: a,  b ,c";
        assert_eq!(parse_players(raw), vec!["a", "b", "c"]);
    }
}
