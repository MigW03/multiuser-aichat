//! A minimal Supabase Realtime client (Phoenix channels over a websocket) for one chat:
//! Postgres changes on `messages`, and the private broadcast channel `chat:<id>` that carries
//! the AI's streaming snapshots.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use super::Backend;
use super::models::Message;
use crate::runtime;

const HEARTBEAT: Duration = Duration::from_secs(25);
const RECONNECT_DELAY: Duration = Duration::from_secs(3);

#[derive(Debug)]
pub enum RealtimeEvent {
    /// Joined (or re-joined after a drop). Messages may have been missed, so reload them.
    Joined,
    Disconnected(String),
    /// A row in `messages` was inserted or updated.
    Upsert(Message),
    /// Full text so far of an assistant message that is still streaming.
    Stream { message_id: String, content: String },
    /// Someone renamed the chat.
    Renamed(String),
}

/// Dropping the handle closes the connection.
pub struct ChatSubscription {
    _stop: mpsc::Sender<()>,
}

pub fn subscribe(backend: Arc<Backend>, chat_id: String) -> (ChatSubscription, mpsc::UnboundedReceiver<RealtimeEvent>) {
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
    runtime::handle().spawn(async move {
        loop {
            tokio::select! {
                result = run_connection(&backend, &chat_id, &events_tx) => {
                    let reason = match result {
                        Ok(()) => "Connection closed".to_string(),
                        Err(e) => e.to_string(),
                    };
                    if events_tx.send(RealtimeEvent::Disconnected(reason)).is_err() {
                        return;
                    }
                }
                _ = stop_rx.recv() => return,
            }
            tokio::select! {
                _ = tokio::time::sleep(RECONNECT_DELAY) => {}
                _ = stop_rx.recv() => return,
            }
        }
    });
    (ChatSubscription { _stop: stop_tx }, events_rx)
}

async fn run_connection(
    backend: &Backend,
    chat_id: &str,
    events: &mpsc::UnboundedSender<RealtimeEvent>,
) -> Result<()> {
    let mut token = backend.access_token().await?;
    let (ws, _) = tokio_tungstenite::connect_async(backend.config.realtime_url()).await?;
    let (mut sink, mut stream) = ws.split();

    let topic = format!("realtime:chat:{chat_id}");
    let mut next_ref = 1u64;
    let mut make_ref = || {
        next_ref += 1;
        next_ref.to_string()
    };
    let join_ref = make_ref();
    let join = json!({
        "topic": topic,
        "event": "phx_join",
        "ref": join_ref,
        "join_ref": join_ref,
        "payload": {
            "config": {
                "broadcast": { "ack": false, "self": false },
                "presence": { "key": "", "enabled": false },
                "postgres_changes": [{
                    "event": "*",
                    "schema": "public",
                    "table": "messages",
                    "filter": format!("chat_id=eq.{chat_id}"),
                }],
                "private": true,
            },
            "access_token": token,
        },
    });
    sink.send(WsMessage::Text(join.to_string())).await?;

    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await;
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let hb = json!({ "topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": make_ref() });
                sink.send(WsMessage::Text(hb.to_string())).await?;
                // Hand the channel a fresh token before the old one expires, or the server drops us.
                let current = backend.access_token().await?;
                if current != token {
                    token = current;
                    let msg = json!({
                        "topic": topic, "event": "access_token", "ref": make_ref(), "join_ref": join_ref,
                        "payload": { "access_token": token },
                    });
                    sink.send(WsMessage::Text(msg.to_string())).await?;
                }
            }
            frame = stream.next() => {
                let Some(frame) = frame else { return Ok(()) };
                match frame? {
                    WsMessage::Text(text) => {
                        let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
                        if msg["topic"] != topic {
                            continue;
                        }
                        handle_message(&msg, &join_ref, events)?;
                    }
                    WsMessage::Ping(data) => sink.send(WsMessage::Pong(data)).await?,
                    WsMessage::Close(_) => return Ok(()),
                    _ => {}
                }
            }
        }
    }
}

fn handle_message(msg: &Value, join_ref: &str, events: &mpsc::UnboundedSender<RealtimeEvent>) -> Result<()> {
    let payload = &msg["payload"];
    let send = |e| events.send(e).map_err(|_| anyhow!("chat closed"));
    match msg["event"].as_str().unwrap_or_default() {
        "phx_reply" if msg["ref"] == join_ref => {
            if payload["status"] == "ok" {
                send(RealtimeEvent::Joined)?;
            } else {
                let reason = payload["response"]["reason"].as_str().unwrap_or("could not join the chat");
                return Err(anyhow!("Live updates unavailable: {reason}"));
            }
        }
        "postgres_changes" => {
            let data = &payload["data"];
            if matches!(data["type"].as_str(), Some("INSERT" | "UPDATE")) {
                if let Ok(m) = serde_json::from_value::<Message>(data["record"].clone()) {
                    send(RealtimeEvent::Upsert(m))?;
                }
            }
        }
        "broadcast" if payload["event"] == "stream" => {
            let inner = &payload["payload"];
            if let (Some(id), Some(content)) = (inner["messageId"].as_str(), inner["content"].as_str()) {
                send(RealtimeEvent::Stream { message_id: id.to_string(), content: content.to_string() })?;
            }
        }
        "broadcast" if payload["event"] == "rename" => {
            if let Some(title) = payload["payload"]["title"].as_str() {
                send(RealtimeEvent::Renamed(title.chars().take(80).collect()))?;
            }
        }
        "phx_error" | "phx_close" => return Err(anyhow!("The live connection was closed by the server")),
        "system" if payload["status"] == "error" => {
            let reason = payload["message"].as_str().unwrap_or("realtime error");
            return Err(anyhow!("Live updates error: {reason}"));
        }
        _ => {}
    }
    Ok(())
}
