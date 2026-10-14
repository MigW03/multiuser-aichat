//! Supabase auth, REST and broadcast. All methods run on the network runtime (see `runtime::run`).

pub mod ai;
pub mod keys;
pub mod models;
pub mod realtime;
pub mod runner;

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, anyhow, bail};
use serde_json::{Value, json};

use crate::config::Config;
use models::{Chat, Member, Message, ModelChoice, MyProfile};

/// Refresh the access token when it has less than this many seconds left.
const REFRESH_MARGIN_SECS: i64 = 120;

#[derive(Clone, Debug)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub user_id: String,
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
        let raw: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            bail!(error_message(&raw).unwrap_or_else(|| format!("Sign in failed ({status})")));
        }

        let expires_at = raw["expires_at"]
            .as_i64()
            .unwrap_or_else(|| now_secs() + raw["expires_in"].as_i64().unwrap_or(3600));

        let session = Session {
            access_token: str_field(&raw, "access_token")?,
            refresh_token: str_field(&raw, "refresh_token")?,
            expires_at,
            user_id: raw["user"]["id"].as_str().unwrap_or_default().to_string(),
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

    pub async fn rename_chat(&self, chat_id: &str, title: &str) -> Result<String> {
        let title: String = self.rpc("rename_chat", json!({ "p_chat_id": chat_id, "p_title": title })).await?;
        // Other open clients (web and desktop) update their header from this event.
        let _ = self.broadcast(chat_id, "rename", json!({ "title": title })).await;
        Ok(title)
    }

    /// Adds an existing user by email. Returns their display name.
    pub async fn invite(&self, chat_id: &str, email: &str) -> Result<String> {
        self.rpc("invite_to_chat", json!({ "p_chat_id": chat_id, "p_email": email })).await
    }

    /// Remembers the model for this chat (and as the default for new chats).
    pub async fn set_chat_model(&self, chat_id: &str, choice: &ModelChoice) -> Result<()> {
        self.rpc::<Value>(
            "set_chat_model",
            json!({ "p_chat_id": chat_id, "p_provider": choice.provider, "p_model": choice.model }),
        )
        .await?;
        Ok(())
    }

    /// Saves a user message as `pending`; the sender's own app then answers it (see `runner`).
    pub async fn insert_message(&self, chat_id: &str, id: &str, content: &str, choice: &ModelChoice) -> Result<()> {
        let uid = self.user_id().ok_or_else(|| anyhow!("You are signed out."))?;
        let token = self.access_token().await?;
        let res = self
            .http
            .post(format!("{}/rest/v1/messages", self.config.supabase_url))
            .header("apikey", &self.config.supabase_anon_key)
            .header("prefer", "return=minimal")
            .bearer_auth(token)
            .json(&json!({
                "id": id, "chat_id": chat_id, "author_id": uid, "role": "user", "status": "pending",
                "content": content, "provider": choice.provider, "model": choice.model,
            }))
            .send()
            .await
            .context("Could not reach Supabase.")?;
        if res.status().is_success() {
            return Ok(());
        }
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        bail!(error_message(&body).unwrap_or_else(|| format!("Could not send the message ({status})")))
    }

    pub async fn has_pending(&self, chat_id: &str) -> Result<bool> {
        let uid = self.user_id().ok_or_else(|| anyhow!("You are signed out."))?;
        let rows: Vec<Value> = self
            .get(&format!("messages?select=id&chat_id=eq.{chat_id}&author_id=eq.{uid}&status=eq.pending&limit=1"))
            .await?;
        Ok(!rows.is_empty())
    }

    /// The most recent `limit` answered or in-progress messages, oldest first.
    pub async fn history(&self, chat_id: &str, limit: usize) -> Result<Vec<Message>> {
        let mut rows: Vec<Message> = self
            .get(&format!(
                "messages?select=id,author_id,role,content,status,seq,provider,model&chat_id=eq.{chat_id}\
                 &status=in.(done,processing)&order=seq.desc&limit={limit}"
            ))
            .await?;
        rows.reverse();
        Ok(rows)
    }

    /// Claims the chat's run for this user's pending messages. `None`: nothing to do, or someone else's run is going.
    pub async fn start_ai_run(&self, chat_id: &str) -> Result<Option<String>> {
        self.rpc("start_ai_run", json!({ "p_chat_id": chat_id })).await
    }

    pub async fn extend_ai_run(&self, chat_id: &str) -> Result<()> {
        self.rpc::<Value>("extend_ai_run", json!({ "p_chat_id": chat_id })).await?;
        Ok(())
    }

    pub async fn finish_ai_run(&self, message_id: &str, content: &str, ok: bool) -> Result<()> {
        self.rpc::<Value>("finish_ai_run", json!({ "p_message_id": message_id, "p_content": content, "p_ok": ok }))
            .await?;
        Ok(())
    }

    /// Sends an event on the chat's private broadcast channel (`chat:<id>`), as the signed-in user.
    pub async fn broadcast(&self, chat_id: &str, event: &str, payload: Value) -> Result<()> {
        let token = self.access_token().await?;
        let res = self
            .http
            .post(format!("{}/realtime/v1/api/broadcast", self.config.supabase_url))
            .header("apikey", &self.config.supabase_anon_key)
            .bearer_auth(token)
            .json(&json!({ "messages": [{ "topic": format!("chat:{chat_id}"), "event": event, "payload": payload, "private": true }] }))
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("broadcast failed ({})", res.status());
        }
        Ok(())
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
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

fn session_account(config: &Config) -> String {
    format!("session:{}", config.project_ref())
}

async fn read_refresh_token(config: &Config) -> Option<String> {
    keys::read(session_account(config)).await
}

fn save_refresh_token(config: &Config, token: String) {
    let account = session_account(config);
    tokio::spawn(async move {
        let _ = keys::write(account, token).await;
    });
}

fn forget_refresh_token(config: &Config) {
    tokio::spawn(keys::delete(session_account(config)));
}
