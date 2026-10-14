//! Streams a chat completion straight from the provider with the user's own key.

use anyhow::{Context as _, Result, anyhow, bail};
use futures_util::StreamExt;
use serde_json::{Value, json};

#[derive(Clone, Debug)]
pub struct Turn {
    /// "user" or "assistant"
    pub role: &'static str,
    pub content: String,
}

const MAX_TOKENS: u32 = 4096;

/// Calls `on_text` with the full text so far as it streams, and returns the final text.
pub async fn stream_reply(
    http: &reqwest::Client,
    provider: &str,
    api_key: &str,
    model: &str,
    system: &str,
    turns: &[Turn],
    mut on_text: impl FnMut(&str),
) -> Result<String> {
    let request = match provider {
        "anthropic" => http
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": model,
                "max_tokens": MAX_TOKENS,
                "system": system,
                "messages": turns.iter().map(|t| json!({ "role": t.role, "content": t.content })).collect::<Vec<_>>(),
                "stream": true,
            })),
        "openai" | "openrouter" => {
            let url = if provider == "openai" {
                "https://api.openai.com/v1/chat/completions"
            } else {
                "https://openrouter.ai/api/v1/chat/completions"
            };
            let mut messages = vec![json!({ "role": "system", "content": system })];
            messages.extend(turns.iter().map(|t| json!({ "role": t.role, "content": t.content })));
            http.post(url).bearer_auth(api_key).json(&json!({ "model": model, "messages": messages, "stream": true }))
        }
        other => bail!("Unknown provider {other}"),
    };

    let label = super::keys::provider_label(provider).to_string();
    let res = request.send().await.with_context(|| format!("Could not reach {label}."))?;
    let status = res.status();
    if !status.is_success() {
        let body: Value = res.json().await.unwrap_or(Value::Null);
        let detail = body["error"]["message"].as_str().or(body["error"].as_str()).unwrap_or("no details");
        if status.as_u16() == 401 || status.as_u16() == 403 {
            bail!("{label} rejected your API key ({detail}). Update it in API keys.");
        }
        bail!("{label} returned an error ({status}): {detail}");
    }

    // Server-sent events: lines of `data: {json}`, separated by blank lines.
    let mut text = String::new();
    let mut buffer: Vec<u8> = Vec::new(); // bytes, so a character split across chunks stays intact
    let mut body = res.bytes_stream();
    while let Some(chunk) = body.next().await {
        buffer.extend_from_slice(&chunk.context("The reply stream was interrupted.")?);
        while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
            let line_bytes: Vec<u8> = buffer.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" {
                return Ok(text);
            }
            let Ok(event) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(err) = event.get("error").filter(|e| !e.is_null()) {
                let message = err["message"].as_str().unwrap_or("unknown error");
                return Err(anyhow!("{label}: {message}"));
            }
            let delta = if provider == "anthropic" {
                (event["type"] == "content_block_delta").then(|| event["delta"]["text"].as_str()).flatten()
            } else {
                event["choices"][0]["delta"]["content"].as_str()
            };
            if let Some(delta) = delta.filter(|d| !d.is_empty()) {
                text.push_str(delta);
                on_text(&text);
            }
        }
    }
    Ok(text)
}
