//! Secrets kept in the OS keychain (macOS Keychain, Windows Credential Manager): the session's
//! refresh token and the user's AI provider API keys. API keys never leave this computer
//! except in requests to the provider itself.

use std::time::Duration;

use anyhow::{Result, anyhow};

const SERVICE: &str = "multiuser-chat-native";
/// The keychain can block (for example on an access prompt); a slow read counts as "nothing saved".
const TIMEOUT: Duration = Duration::from_secs(5);

pub const PROVIDERS: [&str; 3] = ["openrouter", "anthropic", "openai"];

pub fn provider_label(provider: &str) -> &str {
    match provider {
        "openrouter" => "OpenRouter",
        "anthropic" => "Anthropic",
        "openai" => "OpenAI",
        other => other,
    }
}

pub fn provider_key_url(provider: &str) -> &'static str {
    match provider {
        "openrouter" => "https://openrouter.ai/keys",
        "anthropic" => "https://console.anthropic.com/settings/keys",
        _ => "https://platform.openai.com/api-keys",
    }
}

/// Keychain account names are scoped by user so two accounts on one computer don't share keys.
pub fn api_key_account(user_id: &str, provider: &str) -> String {
    format!("{user_id}:{provider}")
}

pub async fn read(account: String) -> Option<String> {
    let read = tokio::task::spawn_blocking(move || keyring::Entry::new(SERVICE, &account).ok()?.get_password().ok());
    tokio::time::timeout(TIMEOUT, read).await.ok()?.ok()?
}

pub async fn write(account: String, secret: String) -> Result<()> {
    let write = tokio::task::spawn_blocking(move || keyring::Entry::new(SERVICE, &account)?.set_password(&secret));
    tokio::time::timeout(TIMEOUT, write)
        .await
        .map_err(|_| anyhow!("The keychain did not respond. Check for a permission prompt."))??
        .map_err(|e| anyhow!("Could not save to the keychain: {e}"))
}

pub async fn delete(account: String) {
    let delete = tokio::task::spawn_blocking(move || {
        if let Ok(entry) = keyring::Entry::new(SERVICE, &account) {
            let _ = entry.delete_credential();
        }
    });
    let _ = tokio::time::timeout(TIMEOUT, delete).await;
}

/// The last four characters, so the settings screen can show which key is saved.
pub fn hint(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}
