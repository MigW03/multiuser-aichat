use gpui::{
    Context, Entity, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window, div, prelude::*,
};

use super::button;
use super::text_input::{InputEvent, TextInput};
use crate::backend::keys;
use crate::runtime;
use crate::theme::Theme;

struct ProviderRow {
    provider: &'static str,
    input: Entity<TextInput>,
    /// e.g. "…a1b2" when a key is saved on this computer.
    saved_hint: Option<String>,
    message: Option<SharedString>,
}

/// API keys, kept in this computer's keychain. The AI answers your messages with these.
pub struct SettingsView {
    user_id: String,
    rows: Vec<ProviderRow>,
    _subscriptions: Vec<Subscription>,
}

impl SettingsView {
    pub fn new(user_id: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut subscriptions = Vec::new();
        let rows = keys::PROVIDERS
            .iter()
            .enumerate()
            .map(|(i, provider)| {
                let input = cx.new(|cx| TextInput::new(format!("Paste your {} API key", keys::provider_label(provider)), cx).masked());
                subscriptions.push(cx.subscribe_in(&input, window, move |this, _, InputEvent::Submit, window, cx| this.save(i, window, cx)));
                ProviderRow { provider, input, saved_hint: None, message: None }
            })
            .collect();
        let mut this = SettingsView { user_id, rows, _subscriptions: subscriptions };
        this.load(window, cx);
        this
    }

    fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let user_id = self.user_id.clone();
        let request = runtime::run(async move {
            let mut hints = Vec::new();
            for provider in keys::PROVIDERS {
                hints.push(keys::read(keys::api_key_account(&user_id, provider)).await.map(|k| keys::hint(&k)));
            }
            Ok(hints)
        });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(hints) = request.await {
                this.update(cx, |this, cx| {
                    for (row, hint) in this.rows.iter_mut().zip(hints) {
                        row.saved_hint = hint;
                    }
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn save(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let row = &mut self.rows[index];
        let key = row.input.read(cx).text().trim().to_string();
        if key.is_empty() {
            row.message = Some("Paste a key first.".into());
            cx.notify();
            return;
        }
        let account = keys::api_key_account(&self.user_id, row.provider);
        let hint = keys::hint(&key);
        let request = runtime::run(keys::write(account, key));
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                let row = &mut this.rows[index];
                match result {
                    Ok(()) => {
                        row.saved_hint = Some(hint);
                        row.message = Some("Saved on this computer.".into());
                        row.input.update(cx, |input, cx| input.clear(cx));
                    }
                    Err(e) => row.message = Some(e.to_string().into()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn remove(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let account = keys::api_key_account(&self.user_id, self.rows[index].provider);
        let request = runtime::run(async move {
            keys::delete(account).await;
            Ok(())
        });
        cx.spawn_in(window, async move |this, cx| {
            let _ = request.await;
            this.update(cx, |this, cx| {
                this.rows[index].saved_hint = None;
                this.rows[index].message = Some("Removed.".into());
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

impl Render for SettingsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx).clone();
        let rows = self.rows.iter().enumerate().map(|(i, row)| {
            let url = keys::provider_key_url(row.provider);
            div()
                .flex()
                .flex_col()
                .gap(theme.sizes.gap_sm)
                .p(theme.sizes.gap_md)
                .bg(theme.colors.surface)
                .border(theme.sizes.border_width)
                .border_color(theme.colors.border)
                .rounded(theme.sizes.bubble_radius)
                .child(
                    div()
                        .flex()
                        .justify_between()
                        .items_center()
                        .child(div().text_size(theme.fonts.size_lg).child(keys::provider_label(row.provider).to_string()))
                        .child(
                            div()
                                .text_size(theme.fonts.size_sm)
                                .text_color(theme.colors.text_muted)
                                .child(match &row.saved_hint {
                                    Some(hint) => format!("Saved key {hint}"),
                                    None => "No key saved".to_string(),
                                }),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .gap(theme.sizes.gap_sm)
                        .child(div().flex_1().child(row.input.clone()))
                        .child(button(("save-key", i), "Save", true, &theme).on_click(cx.listener(move |this, _, window, cx| this.save(i, window, cx))))
                        .when(row.saved_hint.is_some(), |d| {
                            d.child(button(("remove-key", i), "Remove", false, &theme).on_click(cx.listener(move |this, _, window, cx| this.remove(i, window, cx))))
                        }),
                )
                .child(
                    div()
                        .flex()
                        .justify_between()
                        .text_size(theme.fonts.size_sm)
                        .text_color(theme.colors.text_muted)
                        .child(row.message.clone().unwrap_or_default())
                        .child(
                            div()
                                .id(("key-link", i))
                                .cursor_pointer()
                                .text_color(theme.colors.accent_hover)
                                .child("Get a key")
                                .on_click(move |_, _, cx| cx.open_url(url)),
                        ),
                )
        });

        div()
            .id("settings")
            .size_full()
            .overflow_y_scroll()
            .p(theme.sizes.gap_lg)
            .flex()
            .flex_col()
            .gap(theme.sizes.gap_md)
            .child(div().text_size(theme.fonts.size_xl).child("API keys"))
            .child(div().text_color(theme.colors.text_muted).child(
                "The AI answers your messages with your own key and model. Keys stay in this computer's keychain \
                 and are only sent to the provider.",
            ))
            .children(rows)
    }
}
