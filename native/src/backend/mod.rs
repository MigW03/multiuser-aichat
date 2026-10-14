//! Supabase auth + REST, and the web app's message endpoint. All methods run on the
//! network runtime (see `runtime::run`).

pub mod models;
pub mod realtime;

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, anyhow, bail};
use base64::Engine as _;
use serde_json::{Value, json};

use crate::config::Config;
use models::{Chat, Member, Message, ModelChoice, MyProfile};

const KEYRING_SERVICE: &str = "multiuser-chat-native";
const KEYCHAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// Refresh the access token when it has less than this many seconds left.
const REFRESH_MARGIN_SECS: i64 = 120;
/// Same as @supabase/ssr: cookie values longer than this are split into `name.0`, `name.1`, ...
const COOKIE_CHUNK_SIZE: usize = 3180;

#[derive(Clone, Debug)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub user_id: String,
    /// The token response as GoTrue returned it, used to build the web app's auth cookie.
    raw: Value,
}

pub struct Backend {
    pub config: Config,
    http: reqwest::Client,
    session: Mutex<Option<Session>>,
}

impl Backend {
    pub fn new(config: Config) -> Arc<Self> {
        Arc::new(Backend {
            config,
            http: reqwest::Client::builder()
                .user_agent(concat!("multiuser-chat-native/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("http client"),
            session: Mutex::new(None),
        })
    }

    pub fn session(&self) -> Option<Session> {
        self.session.lock().unwrap().clone()
    }

    pub fn user_id(&self) -> Option<String> {
        self.session().map(|s| s.user_id)
    }

    // ------------------------------------------------------------------ auth

    pub async fn sign_in(&self, email: &str, password: &str) -> Result<Session> {
        let body = json!({ "email": email, "password": password });
        let session = self.token_request("password", body).await?;
        Ok(session)
    }

    /// Restores the previous session from the OS keychain, if there is one and it still works.
    pub async fn restore(&self) -> Result<Option<Session>> {
        let Some(refresh_token) = read_refresh_token(&self.config).await else {
            return Ok(None);
        };
        match self.token_request("refresh_token", json!({ "refresh_token": refresh_token })).await {
            Ok(s) => Ok(Some(s)),
            Err(_) => {
                forget_refresh_token(&self.config);
                Ok(None)
            }
        }
    }

    pub async fn sign_out(&self) -> Result<()> {
        let token = self.session().map(|s| s.access_token);
        *self.session.lock().unwrap() = None;
        forget_refresh_token(&self.config);
        if let Some(token) = token {
            // Best effort: revokes the refresh token on the server.
            let _ = self
                .http
                .post(format!("{}/auth/v1/logout", self.config.supabase_url))
                .header("apikey", &self.config.supabase_anon_key)
                .bearer_auth(token)
                .send()
                .await;
        }
        Ok(())
    }

    /// A current access token, refreshed first if it is about to expire.
    pub async fn access_token(&self) -> Result<String> {
        let session = self.session().ok_or_else(|| anyhow!("You are signed out."))?;
        if session.expires_at - now_secs() > REFRESH_MARGIN_SECS {
            return Ok(session.access_token);
        }
        let refreshed = self
            .token_request("refresh_token", json!({ "refresh_token": session.refresh_token }))
            .await
            .context("Your session expired. Sign in again.")?;
        Ok(refreshed.access_token)
    }

    async fn token_request(&self, grant_type: &str, body: Value) -> Result<Session> {
        let res = self
            .http
            .post(format!("{}/auth/v1/token?grant_type={grant_type}", self.config.supabase_url))
            .header("apikey", &self.config.supabase_anon_key)
            .json(&body)
            .send()
            .await
            .context("Could not reach Supabase. Check your connection.")?;
        let status = res.status();
        let mut raw: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            bail!(error_message(&raw).unwrap_or_else(|| format!("Sign in failed ({status})")));
        }

        // GoTrue returns expires_in; supabase-js stores an absolute expires_at, and so does the cookie.
        let expires_at = raw["expires_at"]
            .as_i64()
            .unwrap_or_else(|| now_secs() + raw["expires_in"].as_i64().unwrap_or(3600));
        raw["expires_at"] = json!(expires_at);

        let session = Session {
            access_token: str_field(&raw, "access_token")?,
            refresh_token: str_field(&raw, "refresh_token")?,
            expires_at,
            user_id: raw["user"]["id"].as_str().unwrap_or_default().to_string(),
            raw,
        };
        save_refresh_token(&self.config, session.refresh_token.clone());
        *self.session.lock().unwrap() = Some(session.clone());
        Ok(session)
    }

    // ------------------------------------------------------------------ data

    async fn get<T: serde::de::DeserializeOwned>(&self, path_and_query: &str) -> Result<T> {
        let token = self.access_token().await?;
        let res = self
            .http
            .get(format!("{}/rest/v1/{path_and_query}", self.config.supabase_url))
            .header("apikey", &self.config.supabase_anon_key)
            .bearer_auth(token)
            .send()
            .await
            .context("Could not reach Supabase.")?;
        parse(res).await
    }

    async fn rpc<T: serde::de::DeserializeOwned>(&self, name: &str, args: Value) -> Result<T> {
        let token = self.access_token().await?;
        let res = self
            .http
            .post(format!("{}/rest/v1/rpc/{name}", self.config.supabase_url))
            .header("apikey", &self.config.supabase_anon_key)
            .bearer_auth(token)
            .json(&args)
            .send()
            .await
            .context("Could not reach Supabase.")?;
        parse(res).await
    }

    pub async fn my_profile(&self) -> Result<MyProfile> {
        let uid = self.user_id().ok_or_else(|| anyhow!("You are signed out."))?;
        let rows: Vec<MyProfile> = self
            .get(&format!("profiles?select=id,display_name,ai_provider,ai_model&id=eq.{uid}"))
            .await?;
        rows.into_iter().next().ok_or_else(|| anyhow!("Your profile was not found."))
    }

    pub async fn list_chats(&self) -> Result<Vec<Chat>> {
        self.get("chats?select=id,title&order=created_at.desc").await
    }

    pub async fn create_chat(&self) -> Result<String> {
        self.rpc("create_chat", json!({ "p_title": "New chat" })).await
    }

    pub async fn members(&self, chat_id: &str) -> Result<Vec<Member>> {
        self.get(&format!(
            "chat_members?select=user_id,ai_provider,ai_model,profiles(id,display_name)&chat_id=eq.{chat_id}"
        ))
        .await
    }

    pub async fn messages(&self, chat_id: &str) -> Result<Vec<Message>> {
        self.get(&format!(
            "messages?select=id,author_id,role,content,status,seq,provider,model&chat_id=eq.{chat_id}&order=seq.asc"
        ))
        .await
    }

    /// Sends through the web app, which saves the message and runs the AI with the sender's saved key.
    pub async fn send_message(&self, chat_id: &str, id: &str, content: &str, choice: &ModelChoice) -> Result<()> {
        self.access_token().await?; // refresh first so the cookie carries a valid token
        let cookie = self.auth_cookie()?;
        let res = self
            .http
            .post(format!("{}/api/chats/{chat_id}/messages", self.config.api_url))
            .header("cookie", cookie)
            .json(&json!({ "id": id, "content": content, "provider": choice.provider, "model": choice.model }))
            .send()
            .await
            .with_context(|| format!("Could not reach the chat server at {}. Is it running?", self.config.api_url))?;
        if res.status().is_success() {
            return Ok(());
        }
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        bail!(error_message(&body).unwrap_or_else(|| format!("Could not send the message ({status})")))
    }

    /// The web app reads its session from the cookie @supabase/ssr writes:
    /// `sb-<ref>-auth-token` = "base64-" + base64url(session JSON), chunked when long.
    fn auth_cookie(&self) -> Result<String> {
        let session = self.session().ok_or_else(|| anyhow!("You are signed out."))?;
        let name = format!("sb-{}-auth-token", self.config.project_ref());
        let value = format!(
            "base64-{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(session.raw.to_string())
        );
        if value.len() <= COOKIE_CHUNK_SIZE {
            return Ok(format!("{name}={value}"));
        }
        // base64url is ASCII, so byte-based chunking is safe.
        Ok(value
            .as_bytes()
            .chunks(COOKIE_CHUNK_SIZE)
            .enumerate()
            .map(|(i, chunk)| format!("{name}.{i}={}", std::str::from_utf8(chunk).unwrap_or_default()))
            .collect::<Vec<_>>()
            .join("; "))
    }
}

async fn parse<T: serde::de::DeserializeOwned>(res: reqwest::Response) -> Result<T> {
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        bail!(error_message(&body).unwrap_or_else(|| format!("Request failed ({status})")));
    }
    serde_json::from_value(body).context("Unexpected response from Supabase")
}

/// Supabase services use a few different error shapes.
fn error_message(body: &Value) -> Option<String> {
    ["error_description", "msg", "message", "error"]
        .iter()
        .find_map(|k| body[*k].as_str())
        .map(str::to_string)
}

fn str_field(v: &Value, key: &str) -> Result<String> {
    v[key]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow!("Supabase did not return {key}"))
}

pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn keyring_entry(config: &Config) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &config.project_ref()).ok()
}

/// The OS keychain can block (for example on an access prompt), so it never runs on a
/// network worker and a slow read is treated as "no saved session".
async fn read_refresh_token(config: &Config) -> Option<String> {
    let config = config.clone();
    let read = tokio::task::spawn_blocking(move || keyring_entry(&config)?.get_password().ok());
    tokio::time::timeout(KEYCHAIN_TIMEOUT, read).await.ok()?.ok()?
}

fn save_refresh_token(config: &Config, token: String) {
    let config = config.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(entry) = keyring_entry(&config) {
            let _ = entry.set_password(&token);
        }
    });
}

fn forget_refresh_token(config: &Config) {
    let config = config.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(entry) = keyring_entry(&config) {
            let _ = entry.delete_credential();
        }
    });
}
