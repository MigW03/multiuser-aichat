use anyhow::{Context as _, Result, bail};

/// Where the app connects. Read from environment variables, or from `.env` / `.env.local` next to
/// `Cargo.toml` or in the current directory. Values present when the app was built are the fallback,
/// so a bundled app works on its own (both values are public: RLS protects the data).
#[derive(Clone, Debug)]
pub struct Config {
    /// e.g. https://abcd.supabase.co
    pub supabase_url: String,
    /// The publishable (anon) key. Safe to ship in a client; RLS protects the data.
    pub supabase_anon_key: String,
}

impl Config {
    pub fn load() -> Result<Self> {
        let files = load_env_files();
        let var = |names: &[&str]| var(names).or_else(|| names.iter().find_map(|n| files.get(*n).cloned()));

        let supabase_url = var(&["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"])
            .or(option_env!("SUPABASE_URL").map(str::to_string))
            .context("Set SUPABASE_URL (your Supabase project URL) in .env")?;
        let supabase_anon_key = var(&["SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"])
            .or(option_env!("SUPABASE_ANON_KEY").map(str::to_string))
            .context("Set SUPABASE_ANON_KEY (the publishable key) in .env")?;

        if !supabase_url.starts_with("https://") && !supabase_url.starts_with("http://") {
            bail!("SUPABASE_URL must start with https://");
        }
        Ok(Config {
            supabase_url: supabase_url.trim_end_matches('/').to_string(),
            supabase_anon_key,
        })
    }

    /// The `<ref>` in `https://<ref>.supabase.co`, used to name saved secrets per project.
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

/// Reads only the two settings the app needs from `.env` / `.env.local`. These files may also hold
/// server secrets from other tools, which must not end up in this process's environment.
fn load_env_files() -> std::collections::HashMap<String, String> {
    const WANTED: [&str; 4] = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
    let mut found = std::collections::HashMap::new();
    for dir in [env!("CARGO_MANIFEST_DIR"), "."] {
        for file in [".env", ".env.local"] {
            let Ok(iter) = dotenvy::from_path_iter(format!("{dir}/{file}")) else { continue };
            for (key, value) in iter.flatten() {
                if WANTED.contains(&key.as_str()) && !value.trim().is_empty() {
                    found.entry(key).or_insert_with(|| value.trim().to_string());
                }
            }
        }
    }
    found
}

fn var(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|n| std::env::var(n).ok().filter(|v| !v.trim().is_empty()))
        .map(|v| v.trim().to_string())
}
