//! HyperVoice Suite membership: account sign-in + entitlement gating.
//!
//! Synapse ships as a suite app alongside HyperVoice. It does not have its own
//! accounts — it links to the user's HyperVoice account via the same deep-link
//! claim flow ClaudeConnect used, then checks the shared entitlement endpoint to
//! confirm the account has suite access (Pro / Lifetime).
//!
//! Flow:
//!   1. `auth_begin_signin` opens the browser to
//!      `https://hypervoice.app/auth/desktop?app=synapse&nonce=<uuid>`.
//!   2. The web page mints a `user_token` and bounces back to
//!      `synapse://claim?token=<user_token>` (handled in `lib.rs` via the
//!      deep-link / single-instance plugins), which calls `store_token`.
//!   3. `get_entitlement` reads the stored token and calls
//!      `GET /api/desktop/entitlements` with the `X-User-Token` header; the app
//!      gates itself on `suite_access`.

use serde_json::{json, Value};

const HV_BASE: &str = "https://hypervoice.app";
const APP: &str = "synapse";

// OS keyring slots for the linked HyperVoice user token + a stable device id.
const KEYRING_SERVICE: &str = "com.adlistic.synapse";
const KEYRING_USER: &str = "hypervoice_user_token";
const KEYRING_MACHINE: &str = "synapse_machine_id";

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

/// A stable per-install device id (persisted in the OS keyring), required by
/// the `/api/claim` finalize call and the suite's per-device limit.
fn machine_id() -> String {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_MACHINE) {
        if let Ok(id) = entry.get_password() {
            if !id.is_empty() {
                return id;
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let _ = entry.set_password(&id);
        return id;
    }
    uuid::Uuid::new_v4().to_string()
}

/// Finalize the claim: bind the token to this device and stamp `claimed_at`
/// server-side. Until this runs, `/api/desktop/entitlements` returns 409
/// ("User token not linked"). Idempotent for the same machine.
async fn finalize_claim(client: &reqwest::Client, token: &str) -> Result<(), String> {
    let url = format!("{HV_BASE}/api/claim");
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "token": token, "machine_id": machine_id() }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        return Ok(());
    }
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or_else(|e| {
        tracing::warn!(target: "synapse2", error = %e, "auth response was not JSON");
        json!({})
    });
    Err(format!(
        "claim {} {}",
        status,
        body.get("error").and_then(Value::as_str).unwrap_or("")
    ))
}

/// Persist the linked user token in the OS credential store.
pub fn store_token(token: &str) -> Result<(), String> {
    keyring_entry()?
        .set_password(token)
        .map_err(|e| e.to_string())
}

/// Read the linked user token, if any.
pub fn load_token() -> Option<String> {
    keyring_entry().ok()?.get_password().ok()
}

/// Open an http(s) URL in the user's default browser.
fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    let r = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", url]);
        synapse_core::runner::hide_window(&mut c);
        c.spawn()
    };
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(url).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// Start the web sign-in. Opens the HyperVoice desktop-link page in the browser;
/// the bounce-back `synapse://claim?token=...` is handled by the deep-link plugin.
#[tauri::command]
pub fn auth_begin_signin() -> Result<String, String> {
    let nonce = uuid::Uuid::new_v4().to_string();
    let url = format!("{HV_BASE}/auth/desktop?app={APP}&nonce={nonce}");
    open_url(&url)?;
    Ok(nonce)
}

/// Whether an account token is currently stored.
#[tauri::command]
pub fn auth_is_linked() -> bool {
    load_token().is_some()
}

/// Forget the linked account (sign out).
#[tauri::command]
pub fn auth_sign_out() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        // Already gone is success for our purposes.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Fetch the current suite entitlement for the linked account.
///
/// Returns a normalized object the frontend gate reads:
/// `{ linked, http_status, suite_access, plan, status, is_free_tier,
///    email, display_name, suite_updates_until, customer_portal_url, error }`.
#[tauri::command]
pub async fn get_entitlement() -> Result<Value, String> {
    let Some(token) = load_token() else {
        return Ok(json!({ "linked": false }));
    };

    let client = reqwest::Client::builder()
        .user_agent("Synapse-Suite")
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{HV_BASE}/api/desktop/entitlements");
    let fetch_ent = |client: &reqwest::Client, token: &str| {
        client.get(&url).header("X-User-Token", token).send()
    };

    let resp = fetch_ent(&client, &token).await.map_err(|e| e.to_string())?;
    let mut status = resp.status().as_u16();
    let mut body: Value = resp.json().await.unwrap_or_else(|e| {
        tracing::warn!(target: "synapse2", error = %e, "auth response was not JSON");
        json!({})
    });

    // 409 = the claim was never finalized (claimed_at null). Finalize once,
    // then retry — and ONLY then, so a healthy account never pays the extra
    // round-trip or logs expired-token noise on every launch.
    if status == 409 {
        if let Err(e) = finalize_claim(&client, &token).await {
            tracing::warn!(target: "synapse2", error = %e, "claim finalize failed");
        }
        if let Ok(resp2) = fetch_ent(&client, &token).await {
            status = resp2.status().as_u16();
            body = resp2.json().await.unwrap_or_else(|e| {
                tracing::warn!(target: "synapse2", error = %e, "auth response was not JSON");
                json!({})
            });
        }
    }

    // The server signals account-deleted / token-revoked via 404 / 410 — surface
    // it so the frontend can drop back to the sign-in screen.
    let revoked = status == 404 || status == 410;

    Ok(json!({
        "linked": !revoked,
        "http_status": status,
        "suite_access": body.get("suite_access").and_then(Value::as_bool).unwrap_or(false),
        "plan": body.get("plan").cloned().unwrap_or(Value::Null),
        "status": body.get("status").cloned().unwrap_or(Value::Null),
        "is_free_tier": body.get("is_free_tier").and_then(Value::as_bool).unwrap_or(true),
        "email": body.get("email").cloned().unwrap_or(Value::Null),
        "display_name": body.get("display_name").cloned().unwrap_or(Value::Null),
        "suite_updates_until": body.get("suite_updates_until").cloned().unwrap_or(Value::Null),
        "customer_portal_url": body.get("customer_portal_url").cloned().unwrap_or(Value::Null),
        "error": body.get("error").cloned().unwrap_or(Value::Null),
    }))
}

/// Parse a `synapse://claim?token=...` deep-link URL and persist the token.
/// Returns the token on success so the caller can notify the frontend.
pub fn handle_claim_url(url: &str) -> Option<String> {
    // Accept `synapse://claim?token=XXX` (and tolerate extra params).
    let after = url.split('?').nth(1)?;
    for pair in after.split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next() == Some("token") {
            if let Some(tok) = kv.next() {
                let tok = urldecode(tok);
                if !tok.is_empty() {
                    // Only report success if the token actually persisted —
                    // otherwise the entitlement check would find nothing and
                    // the user would be silently stuck at sign-in.
                    match store_token(&tok) {
                        Ok(()) => return Some(tok),
                        Err(e) => {
                            tracing::error!(target: "synapse2", error = %e, "failed to store account token");
                            return None;
                        }
                    }
                }
            }
        }
    }
    None
}

/// Minimal percent-decode (tokens are URL-safe but may carry %XX just in case).
fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
