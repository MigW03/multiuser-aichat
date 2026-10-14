use anyhow::{Context as _, Result, bail};

/// Where the app connects. Read from environment variables, or from a `.env` file next to
/// `Cargo.toml` / the current directory. The names used by the web prototype work too.
#[derive(Clone, Debug)]
pub struct Config {
    /// e.g. https://abcd.supabase.co
    pub supabase_url: String,
    /// The publishable (anon) key. Safe to ship in a client; RLS protects the data.
    pub supabase_anon_key: String,
    /// The web app that runs AI replies (POST /api/chats/:id/messages), e.g. http://localhost:3000.
    pub api_url: String,
}

impl Config {
    pub fn load() -> Result<Self> {
        let _ = dotenvy::from_path(concat!(env!("CARGO_MANIFEST_DIR"), "/.env"));
        let _ = dotenvy::dotenv();

        let supabase_url = var(&["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"])
            .context("Set SUPABASE_URL (your Supabase project URL) in native/.env")?;
        let supabase_anon_key = var(&["SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"])
            .context("Set SUPABASE_ANON_KEY (the publishable key) in native/.env")?;
        let api_url = var(&["CHAT_API_URL"]).unwrap_or_else(|| "http://localhost:3000".into());

        if !supabase_url.starts_with("https://") && !supabase_url.starts_with("http://") {
            bail!("SUPABASE_URL must start with https://");
        }
        Ok(Config {
            supabase_url: supabase_url.trim_end_matches('/').to_string(),
            supabase_anon_key,
            api_url: api_url.trim_end_matches('/').to_string(),
        })
    }

    /// The `<ref>` in `https://<ref>.supabase.co`, used for the web app's auth cookie name.
    pub fn project_ref(&self) -> String {
        let host = self
            .supabase_url
            .split("://")
            .nth(1)
            .unwrap_or_default()
            .split(['/', ':'])
            .next()
            .unwrap_or_default();
        host.split('.').next().unwrap_or_default().to_string()
    }

    pub fn realtime_url(&self) -> String {
        let ws = self.supabase_url.replacen("http", "ws", 1);
        format!("{ws}/realtime/v1/websocket?apikey={}&vsn=1.0.0", self.supabase_anon_key)
    }
}

fn var(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|n| std::env::var(n).ok().filter(|v| !v.trim().is_empty()))
        .map(|v| v.trim().to_string())
}
