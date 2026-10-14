//! Answers this user's own messages: claims the chat's run, streams the reply from the provider with
//! the key in this computer's keychain, broadcasts snapshots to everyone in the chat, then saves it.
//! Other members' messages are answered by their own apps.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use serde_json::json;

use super::ai::{self, Turn};
use super::keys;
use super::Backend;
use crate::runtime;

const HISTORY_LIMIT: usize = 60;
/// While another run holds the chat, check again this often, for at most `MAX_WAIT`.
const RETRY_EVERY: Duration = Duration::from_secs(2);
const MAX_WAIT: Duration = Duration::from_secs(6 * 60);
const BROADCAST_EVERY: Duration = Duration::from_millis(120);
const EXTEND_EVERY: Duration = Duration::from_secs(60);

fn active() -> &'static Mutex<HashSet<String>> {
    static ACTIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ACTIVE.get_or_init(Default::default)
}

/// Starts answering this user's pending messages in the chat, unless that is already happening.
pub fn ensure_running(backend: Arc<Backend>, chat_id: String) {
    if !active().lock().unwrap().insert(chat_id.clone()) {
        return;
    }
    runtime::handle().spawn(async move {
        if let Err(e) = drain(&backend, &chat_id).await {
            eprintln!("[runner] {chat_id}: {e:#}");
        }
        active().lock().unwrap().remove(&chat_id);
    });
}

async fn drain(backend: &Arc<Backend>, chat_id: &str) -> Result<()> {
    let waiting_since = Instant::now();
    while backend.has_pending(chat_id).await? {
        match backend.start_ai_run(chat_id).await? {
            Some(message_id) => run(backend, chat_id, &message_id).await?,
            None if waiting_since.elapsed() < MAX_WAIT => tokio::time::sleep(RETRY_EVERY).await,
            None => return Err(anyhow!("gave up waiting for another reply to finish")),
        }
    }
    Ok(())
}

async fn run(backend: &Arc<Backend>, chat_id: &str, message_id: &str) -> Result<()> {
    let result = generate(backend, chat_id, message_id).await;
    let (content, ok) = match result {
        Ok(text) => (text, true),
        Err(e) => (format!("Sorry, something went wrong: {e:#}"), false),
    };
    backend.finish_ai_run(message_id, &content, ok).await
}

async fn generate(backend: &Arc<Backend>, chat_id: &str, message_id: &str) -> Result<String> {
    let me = backend.user_id().ok_or_else(|| anyhow!("signed out"))?;
    let (history, members) = tokio::try_join!(backend.history(chat_id, HISTORY_LIMIT), backend.members(chat_id))?;
    let names: HashMap<String, String> = members
        .into_iter()
        .filter_map(|m| m.profiles.map(|p| (p.id, p.display_name)))
        .collect();
    let asker = names.get(&me).cloned().unwrap_or_else(|| "Someone".into());

    // The model is the one picked on this user's latest message in the run.
    let latest = history
        .iter()
        .rev()
        .find(|m| m.author_id.as_deref() == Some(me.as_str()) && m.status == "processing")
        .ok_or_else(|| anyhow!("the message to answer was not found"))?;
    let (Some(provider), Some(model)) = (latest.provider.clone(), latest.model.clone()) else {
        return Err(anyhow!("This message was sent without a model selected."));
    };
    let api_key = keys::read(keys::api_key_account(&me, &provider))
        .await
        .ok_or_else(|| anyhow!("{asker} has no {} API key on this computer. Add one in API keys.", keys::provider_label(&provider)))?;

    let mut turns: Vec<Turn> = Vec::new();
    for m in &history {
        let (role, text) = if m.is_assistant() {
            ("assistant", m.content.clone())
        } else {
            let name = m.author_id.as_ref().and_then(|a| names.get(a)).map(String::as_str).unwrap_or("Someone");
            ("user", format!("[{name}]: {}", m.content))
        };
        if turns.is_empty() && role == "assistant" {
            continue; // the conversation must start with a user turn
        }
        match turns.last_mut() {
            // Merge consecutive same-role turns; some providers require strict alternation.
            Some(last) if last.role == role => {
                last.content.push_str("\n\n");
                last.content.push_str(&text);
            }
            _ => turns.push(Turn { role, content: text }),
        }
    }

    let mut last_sent = Instant::now() - BROADCAST_EVERY;
    let mut last_extended = Instant::now();
    let on_text = |text: &str| {
        let now = Instant::now();
        if now.duration_since(last_sent) >= BROADCAST_EVERY {
            last_sent = now;
            // Full-text snapshots, not deltas: a dropped one fixes itself with the next.
            let (backend, chat_id, payload) = (backend.clone(), chat_id.to_string(), json!({ "messageId": message_id, "content": text }));
            tokio::spawn(async move {
                let _ = backend.broadcast(&chat_id, "stream", payload).await;
            });
        }
        if now.duration_since(last_extended) >= EXTEND_EVERY {
            last_extended = now;
            let (backend, chat_id) = (backend.clone(), chat_id.to_string());
            tokio::spawn(async move {
                let _ = backend.extend_ai_run(&chat_id).await;
            });
        }
    };

    let text = ai::stream_reply(backend.http(), &provider, &api_key, &model, &instructions(&asker), &turns, on_text)
        .await
        .map_err(|e| anyhow!(e.to_string().replace(&api_key, "***")))?;
    if text.trim().is_empty() {
        return Err(anyhow!("The model returned an empty reply."));
    }
    Ok(text)
}

fn instructions(asker: &str) -> String {
    format!(
        "You are an AI assistant inside a shared group chat with several people.\n\
         Each user message is prefixed with the author's name in brackets, like \"[Ana]: ...\". \
         Address people by name when it helps, and keep track of who said what.\n\
         You are replying to the latest message(s) from {asker}. Other people may have messages waiting that you \
         haven't seen yet; those are answered separately, so don't guess at them.\n\
         Don't prefix your own replies with a name."
    )
}
