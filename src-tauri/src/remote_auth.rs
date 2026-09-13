//! Remote access control: users, devices, invites.
//!
//! The web remote used to accept a single long-lived token for everyone. This
//! module adds the missing layer for sharing the panel with a few trusted
//! people: named users with a role (`admin` / `operator` / `viewer`), optional
//! per-server scoping, and single-use invite codes that pair a device in one
//! scan. The owner (the desktop user) keeps using the keyring token as an
//! implicit admin; nothing about existing setups changes.
//!
//! Storage: `<app_data>/remote_users.json`. Small by design — a handful of
//! users, devices, and invites. Writes are atomic (tmp + rename). Device
//! tokens are stored as SHA-256 hashes; the plaintext only ever exists in the
//! pairing response and on the device itself.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::config;

/// Serialises read-modify-write cycles across request threads.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// Unambiguous alphabet (no I/O/0/1) for invite codes.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 8;
const TOKEN_BYTES: usize = 32;
const DEFAULT_INVITE_TTL_SECS: u64 = 15 * 60;
const MAX_INVITE_TTL_SECS: u64 = 30 * 24 * 3600;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    Operator,
    Viewer,
}

impl Role {
    fn parse(value: &str) -> Result<Role, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "admin" => Ok(Role::Admin),
            "operator" => Ok(Role::Operator),
            "viewer" => Ok(Role::Viewer),
            other => Err(format!("unknown role '{other}'")),
        }
    }
}

/// What a request is allowed to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Scope {
    View,
    Control,
    Admin,
}

/// Authenticated identity for one request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthContext {
    pub user_id: String,
    pub name: String,
    pub role: Role,
    /// `None` = every server; otherwise ids or `"*"`.
    pub servers: Option<Vec<String>>,
    /// `"owner"` (keyring token) or the device id.
    pub via: String,
    pub device: Option<String>,
}

impl AuthContext {
    pub fn allows_scope(&self, scope: Scope) -> bool {
        match self.role {
            Role::Admin => true,
            Role::Operator => scope <= Scope::Control,
            Role::Viewer => scope == Scope::View,
        }
    }

    pub fn allows_server(&self, id: &str) -> bool {
        if self.role == Role::Admin {
            return true;
        }
        match &self.servers {
            None => true,
            Some(list) => list.iter().any(|s| s == "*" || s == id),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub name: String,
    pub role: Role,
    #[serde(default)]
    pub servers: Option<Vec<String>>,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub user_id: String,
    #[serde(default)]
    pub label: String,
    /// SHA-256 hex of the bearer token. Never serialized to clients.
    #[serde(default)]
    pub token_hash: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub last_seen_at: u64,
    #[serde(default)]
    pub expires_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub code: String,
    /// Who the invite is for (pre-filled user name).
    #[serde(default)]
    pub name: String,
    pub role: Role,
    #[serde(default)]
    pub servers: Option<Vec<String>>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub expires_at: u64,
    #[serde(default)]
    pub used_at: Option<u64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStore {
    #[serde(default)]
    pub users: Vec<User>,
    #[serde(default)]
    pub devices: Vec<Device>,
    #[serde(default)]
    pub invites: Vec<Invite>,
}

/// Store view for the desktop settings panel / panel admin tab.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeopleView {
    pub users: Vec<UserView>,
    pub devices: Vec<DeviceView>,
    pub invites: Vec<InviteView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserView {
    pub id: String,
    pub name: String,
    pub role: Role,
    pub servers: Option<Vec<String>>,
    pub created_at: u64,
    pub device_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub user_id: String,
    pub user_name: String,
    pub label: String,
    pub created_at: u64,
    pub last_seen_at: u64,
    pub expires_at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteView {
    pub code: String,
    pub name: String,
    pub role: Role,
    pub servers: Option<Vec<String>>,
    pub created_at: u64,
    pub expires_at: u64,
    pub expired: bool,
    pub used_at: Option<u64>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config::config_dir(app)?.join("remote_users.json"))
}

pub fn load(app: &AppHandle) -> Result<AuthStore, String> {
    let path = store_path(app)?;
    if !path.is_file() {
        return Ok(AuthStore::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("failed to read {path:?}: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("failed to parse {path:?}: {e}"))
}

fn save(app: &AppHandle, store: &AuthStore) -> Result<(), String> {
    let path = store_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(store).map_err(|e| format!("encode failed: {e}"))?;
    std::fs::write(&tmp, raw).map_err(|e| format!("failed to write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("failed to replace {path:?}: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Crypto helpers
// ─────────────────────────────────────────────────────────────────────────────

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    if getrandom::getrandom(&mut buf).is_err() {
        let nanos = now_secs() as u128 * 1_000_000_000 + std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u128)
            .unwrap_or(0);
        for (i, b) in buf.iter_mut().enumerate() {
            *b = ((nanos >> ((i % 16) * 8)) & 0xff) as u8;
        }
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_code() -> String {
    let mut buf = vec![0u8; CODE_LEN];
    let _ = getrandom::getrandom(&mut buf);
    buf.iter()
        .map(|b| CODE_ALPHABET[(*b as usize) % CODE_ALPHABET.len()] as char)
        .collect()
}

pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

// ─────────────────────────────────────────────────────────────────────────────
// Invites
// ─────────────────────────────────────────────────────────────────────────────

pub fn create_invite(
    app: &AppHandle,
    name: &str,
    role: &str,
    servers: Option<Vec<String>>,
    ttl_secs: Option<u64>,
) -> Result<Invite, String> {
    let role = Role::parse(role)?;
    let _guard = STORE_LOCK.lock().map_err(|_| "store lock poisoned")?;
    let mut store = load(app)?;
    let now = now_secs();
    // Expire stale invites opportunistically.
    store
        .invites
        .retain(|i| i.used_at.is_none() && i.expires_at > now);

    let invite = Invite {
        code: random_code(),
        name: name.trim().to_string(),
        role,
        servers: normalize_servers(servers),
        created_at: now,
        expires_at: now + ttl_secs.unwrap_or(DEFAULT_INVITE_TTL_SECS).min(MAX_INVITE_TTL_SECS),
        used_at: None,
    };
    store.invites.push(invite.clone());
    save(app, &store)?;
    Ok(invite)
}

pub fn revoke_invite(app: &AppHandle, code: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "store lock poisoned")?;
    let mut store = load(app)?;
    let before = store.invites.len();
    store.invites.retain(|i| i.code != code);
    if store.invites.len() == before {
        return Err("invite not found".to_string());
    }
    save(app, &store)
}

/// Public info about an invite, shown on the pairing screen before redeeming.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteInfo {
    pub name: String,
    pub role: Role,
    pub expires_at: u64,
    pub valid: bool,
}

pub fn invite_info(app: &AppHandle, code: &str) -> Result<InviteInfo, String> {
    let store = load(app)?;
    let invite = store
        .invites
        .iter()
        .find(|i| i.code.eq_ignore_ascii_case(code.trim()))
        .ok_or_else(|| "invite not found".to_string())?;
    let valid = invite.used_at.is_none() && invite.expires_at > now_secs();
    Ok(InviteInfo {
        name: invite.name.clone(),
        role: invite.role,
        expires_at: invite.expires_at,
        valid,
    })
}

/// Redeems an invite: creates the user + a device token and returns both.
pub fn redeem_invite(
    app: &AppHandle,
    code: &str,
    device_label: &str,
) -> Result<(AuthContext, String), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "store lock poisoned")?;
    let mut store = load(app)?;
    let now = now_secs();

    let invite = store
        .invites
        .iter_mut()
        .find(|i| i.code.eq_ignore_ascii_case(code.trim()))
        .ok_or_else(|| "invite not found".to_string())?;
    if invite.used_at.is_some() {
        return Err("invite already used".to_string());
    }
    if invite.expires_at <= now {
        return Err("invite expired".to_string());
    }
    invite.used_at = Some(now);

    let name = if invite.name.trim().is_empty() {
        "guest".to_string()
    } else {
        invite.name.trim().to_string()
    };
    // Keep names unique for display purposes.
    let mut unique = name.clone();
    let mut n = 2;
    while store.users.iter().any(|u| u.name == unique) {
        unique = format!("{name} ({n})");
        n += 1;
    }

    let user = User {
        id: format!("u_{}", random_hex(8)),
        name: unique,
        role: invite.role,
        servers: invite.servers.clone(),
        created_at: now,
    };
    let token = random_hex(TOKEN_BYTES);
    let device = Device {
        id: format!("d_{}", random_hex(6)),
        user_id: user.id.clone(),
        label: device_label.trim().to_string(),
        token_hash: hash_token(&token),
        created_at: now,
        last_seen_at: now,
        expires_at: None,
    };

    let context = AuthContext {
        user_id: user.id.clone(),
        name: user.name.clone(),
        role: user.role,
        servers: user.servers.clone(),
        via: device.id.clone(),
        device: Some(device.label.clone()),
    };

    store.users.push(user);
    store.devices.push(device);
    save(app, &store)?;
    Ok((context, token))
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────────────────────────────────────

/// Resolves a device token to an identity, updating last-seen opportunistically.
pub fn authenticate(app: &AppHandle, token: &str) -> Option<AuthContext> {
    if token.trim().is_empty() {
        return None;
    }
    let hash = hash_token(token.trim());
    let _guard = STORE_LOCK.lock().ok()?;
    let mut store = load(app).ok()?;
    let now = now_secs();

    let device = store
        .devices
        .iter()
        .find(|d| d.token_hash == hash)
        .cloned()?;
    if let Some(expires) = device.expires_at {
        if expires <= now {
            return None;
        }
    }
    let user = store.users.iter().find(|u| u.id == device.user_id)?.clone();

    if now.saturating_sub(device.last_seen_at) >= 60 {
        if let Some(d) = store.devices.iter_mut().find(|d| d.id == device.id) {
            d.last_seen_at = now;
        }
        let _ = save(app, &store);
    }

    Some(AuthContext {
        user_id: user.id,
        name: user.name,
        role: user.role,
        servers: user.servers,
        via: device.id,
        device: Some(device.label),
    })
}

/// Owner identity for the keyring token (implicit admin).
pub fn owner_context() -> AuthContext {
    AuthContext {
        user_id: "owner".to_string(),
        name: "owner".to_string(),
        role: Role::Admin,
        servers: None,
        via: "owner".to_string(),
        device: None,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Management
// ─────────────────────────────────────────────────────────────────────────────

pub fn people(app: &AppHandle) -> Result<PeopleView, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "store lock poisoned")?;
    let store = load(app)?;
    let now = now_secs();
    Ok(PeopleView {
        users: store
            .users
            .iter()
            .map(|u| UserView {
                id: u.id.clone(),
                name: u.name.clone(),
                role: u.role,
                servers: u.servers.clone(),
                created_at: u.created_at,
                device_count: store.devices.iter().filter(|d| d.user_id == u.id).count(),
            })
            .collect(),
        devices: store
            .devices
            .iter()
            .map(|d| DeviceView {
                id: d.id.clone(),
                user_id: d.user_id.clone(),
                user_name: store
                    .users
                    .iter()
                    .find(|u| u.id == d.user_id)
                    .map(|u| u.name.clone())
                    .unwrap_or_else(|| "unknown".to_string()),
                label: d.label.clone(),
                created_at: d.created_at,
                last_seen_at: d.last_seen_at,
                expires_at: d.expires_at,
            })
            .collect(),
        invites: store
            .invites
            .iter()
            .map(|i| InviteView {
                code: i.code.clone(),
                name: i.name.clone(),
                role: i.role,
                servers: i.servers.clone(),
                created_at: i.created_at,
                expires_at: i.expires_at,
                expired: i.expires_at <= now,
                used_at: i.used_at,
            })
            .collect(),
    })
}

pub fn update_user(
    app: &AppHandle,
    id: &str,
    role: Option<&str>,
    servers: Option<Option<Vec<String>>>,
) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "store lock poisoned")?;
    let mut store = load(app)?;
    let user = store
        .users
        .iter_mut()
        .find(|u| u.id == id)
        .ok_or_else(|| "user not found".to_string())?;
    if let Some(role) = role {
        user.role = Role::parse(role)?;
    }
    if let Some(servers) = servers {
        user.servers = normalize_servers(servers);
    }
    save(app, &store)
}

pub fn remove_user(app: &AppHandle, id: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "store lock poisoned")?;
    let mut store = load(app)?;
    store.users.retain(|u| u.id != id);
    store.devices.retain(|d| d.user_id != id);
    save(app, &store)
}

pub fn revoke_device(app: &AppHandle, id: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "store lock poisoned")?;
    let mut store = load(app)?;
    let before = store.devices.len();
    store.devices.retain(|d| d.id != id);
    if store.devices.len() == before {
        return Err("device not found".to_string());
    }
    save(app, &store)
}

/// `Some([])` and `Some(["*"])` both mean every server; `None` also means every
/// server (kept for admin simplicity).
fn normalize_servers(servers: Option<Vec<String>>) -> Option<Vec<String>> {
    match servers {
        None => None,
        Some(list) => {
            let cleaned: Vec<String> = list
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if cleaned.is_empty() || cleaned.iter().any(|s| s == "*") {
                None
            } else {
                Some(cleaned)
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands (desktop settings)
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn remote_people(app: AppHandle) -> Result<PeopleView, String> {
    people(&app)
}

#[tauri::command]
pub fn remote_invite_create(
    app: AppHandle,
    name: String,
    role: String,
    servers: Option<Vec<String>>,
    ttl_secs: Option<u64>,
) -> Result<Invite, String> {
    create_invite(&app, &name, &role, servers, ttl_secs)
}

#[tauri::command]
pub fn remote_invite_revoke(app: AppHandle, code: String) -> Result<(), String> {
    revoke_invite(&app, &code)
}

#[tauri::command]
pub fn remote_user_update(
    app: AppHandle,
    id: String,
    role: Option<String>,
    servers: Option<Vec<String>>,
) -> Result<(), String> {
    update_user(&app, &id, role.as_deref(), servers.map(Some))
}

#[tauri::command]
pub fn remote_user_remove(app: AppHandle, id: String) -> Result<(), String> {
    remove_user(&app, &id)
}

#[tauri::command]
pub fn remote_device_revoke(app: AppHandle, id: String) -> Result<(), String> {
    revoke_device(&app, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_parse_and_rank_scopes() {
        assert_eq!(Role::parse("ADMIN").unwrap(), Role::Admin);
        assert!(Role::parse("nope").is_err());
        let viewer = AuthContext {
            user_id: "u".into(),
            name: "v".into(),
            role: Role::Viewer,
            servers: None,
            via: "d".into(),
            device: None,
        };
        assert!(viewer.allows_scope(Scope::View));
        assert!(!viewer.allows_scope(Scope::Control));
        let operator = AuthContext {
            role: Role::Operator,
            ..viewer.clone()
        };
        assert!(operator.allows_scope(Scope::Control));
        assert!(!operator.allows_scope(Scope::Admin));
    }

    #[test]
    fn server_scope_is_honored() {
        let scoped = AuthContext {
            user_id: "u".into(),
            name: "o".into(),
            role: Role::Operator,
            servers: Some(vec!["alpha".into()]),
            via: "d".into(),
            device: None,
        };
        assert!(scoped.allows_server("alpha"));
        assert!(!scoped.allows_server("beta"));
        let all = AuthContext {
            servers: None,
            ..scoped.clone()
        };
        assert!(all.allows_server("anything"));
    }

    #[test]
    fn invite_codes_are_unique_and_hashes_are_stable() {
        let a = random_code();
        let b = random_code();
        assert_eq!(a.len(), CODE_LEN);
        assert_ne!(a, b);
        assert_eq!(hash_token("abc"), hash_token("abc"));
        assert_ne!(hash_token("abc"), hash_token("abd"));
    }
}
