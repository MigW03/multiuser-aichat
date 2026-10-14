use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
pub struct Chat {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Message {
    pub id: String,
    pub author_id: Option<String>,
    pub role: String,
    #[serde(default)]
    pub content: String,
    pub status: String,
    pub seq: i64,
    pub provider: Option<String>,
    pub model: Option<String>,
}

impl Message {
    pub fn is_assistant(&self) -> bool {
        self.role == "assistant"
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Profile {
    pub id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Member {
    pub user_id: String,
    pub ai_provider: Option<String>,
    pub ai_model: Option<String>,
    pub profiles: Option<Profile>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MyProfile {
    pub id: String,
    pub display_name: String,
    pub ai_provider: Option<String>,
    pub ai_model: Option<String>,
}

/// The provider and model a message is answered with.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelChoice {
    pub provider: String,
    pub model: String,
}

impl ModelChoice {
    pub fn from_parts(provider: Option<String>, model: Option<String>) -> Option<Self> {
        Some(ModelChoice { provider: provider?, model: model? })
    }

    pub fn label(&self) -> String {
        let provider = match self.provider.as_str() {
            "openrouter" => "OpenRouter",
            "anthropic" => "Anthropic",
            "openai" => "OpenAI",
            other => other,
        };
        format!("{provider} · {}", self.model)
    }
}
