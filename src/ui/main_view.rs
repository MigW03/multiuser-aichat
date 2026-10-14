use std::sync::Arc;

use gpui::{
    Context, Entity, EventEmitter, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window,
    div, prelude::*,
};

use super::button;
use super::chat::{ChatEvent, ChatView};
use super::settings::SettingsView;
use crate::backend::Backend;
use crate::backend::models::{Chat, MyProfile};
use crate::runtime;
use crate::theme::Theme;

pub enum MainEvent {
    SignedOut,
}

/// Chat list on the left, the open chat on the right.
pub struct MainView {
    backend: Arc<Backend>,
    profile: Option<MyProfile>,
    chats: Vec<Chat>,
    loading: bool,
    error: Option<SharedString>,
    open_chat: Option<Entity<ChatView>>,
    open_chat_id: Option<String>,
    settings: Option<Entity<SettingsView>>,
    _chat_subscription: Option<Subscription>,
}

impl EventEmitter<MainEvent> for MainView {}

impl MainView {
    pub fn new(backend: Arc<Backend>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut this = MainView {
            backend,
            profile: None,
            chats: Vec::new(),
            loading: true,
            error: None,
            open_chat: None,
            open_chat_id: None,
            settings: None,
            _chat_subscription: None,
        };
        this.reload(None, window, cx);
        this
    }

    /// Loads the profile and chat list, then opens `select` (or keeps the open chat).
    fn reload(&mut self, select: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let backend = self.backend.clone();
        let request = runtime::run(async move {
            let profile = backend.my_profile().await?;
            let chats = backend.list_chats().await?;
            Ok((profile, chats))
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            this.update_in(cx, |this, window, cx| {
                this.loading = false;
                match result {
                    Ok((profile, chats)) => {
                        this.profile = Some(profile);
                        this.chats = chats;
                        this.error = None;
                        let target = select.or_else(|| this.open_chat_id.clone()).or_else(|| this.chats.first().map(|c| c.id.clone()));
                        if let Some(id) = target {
                            this.open(id, window, cx);
                        }
                    }
                    Err(e) => this.error = Some(e.to_string().into()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn open(&mut self, chat_id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.settings = None;
        if self.open_chat_id.as_deref() == Some(chat_id.as_str()) && self.open_chat.is_some() {
            return;
        }
        let (Some(chat), Some(profile)) = (self.chats.iter().find(|c| c.id == chat_id).cloned(), self.profile.clone()) else {
            return;
        };
        let backend = self.backend.clone();
        let view = cx.new(|cx| ChatView::new(backend, chat, profile, window, cx));
        self._chat_subscription = Some(cx.subscribe(&view, |this, _, event: &ChatEvent, cx| match event {
            ChatEvent::Renamed { chat_id, title } => {
                if let Some(chat) = this.chats.iter_mut().find(|c| &c.id == chat_id) {
                    chat.title = title.clone();
                }
                cx.notify();
            }
        }));
        self.open_chat = Some(view);
        self.open_chat_id = Some(chat_id);
        cx.notify();
    }

    fn toggle_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings.take().is_none() {
            if let Some(user_id) = self.backend.user_id() {
                self.settings = Some(cx.new(|cx| SettingsView::new(user_id, window, cx)));
            }
        }
        cx.notify();
    }

    fn new_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let backend = self.backend.clone();
        let request = runtime::run(async move { backend.create_chat().await });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            this.update_in(cx, |this, window, cx| match result {
                Ok(id) => this.reload(Some(id), window, cx),
                Err(e) => {
                    this.error = Some(e.to_string().into());
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn sign_out(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_chat = None; // closes the live connection
        let backend = self.backend.clone();
        let request = runtime::run(async move { backend.sign_out().await });
        cx.spawn_in(window, async move |this, cx| {
            let _ = request.await;
            this.update(cx, |_, cx| cx.emit(MainEvent::SignedOut)).ok();
        })
        .detach();
    }
}

impl Render for MainView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx).clone();
        let name = self.profile.as_ref().map(|p| p.display_name.clone()).unwrap_or_default();

        let chat_rows = self.chats.iter().enumerate().map(|(i, chat)| {
            let selected = self.settings.is_none() && self.open_chat_id.as_deref() == Some(chat.id.as_str());
            let id = chat.id.clone();
            div()
                .id(("chat", i))
                .px(theme.sizes.gap_md)
                .py(theme.sizes.gap_sm)
                .rounded(theme.sizes.radius)
                .truncate()
                .cursor_pointer()
                .when(selected, |d| d.bg(theme.colors.surface_hover))
                .hover(|s| s.bg(theme.colors.surface_hover))
                .on_click(cx.listener(move |this, _, window, cx| this.open(id.clone(), window, cx)))
                .child(chat.title.clone())
        });

        let sidebar = div()
            .w(theme.sizes.sidebar_width)
            .h_full()
            .flex()
            .flex_col()
            .gap(theme.sizes.gap_sm)
            .p(theme.sizes.gap_md)
            .bg(theme.colors.surface)
            .border_r(theme.sizes.border_width)
            .border_color(theme.colors.border)
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .child(div().text_size(theme.fonts.size_lg).child("Chats"))
                    .child(button("new-chat", "New chat", true, &theme).on_click(cx.listener(|this, _, window, cx| this.new_chat(window, cx)))),
            )
            .child(
                div()
                    .id("chat-list")
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap(theme.sizes.gap_xs)
                    .overflow_y_scroll()
                    .children(chat_rows)
                    .when(!self.loading && self.chats.is_empty(), |d| {
                        d.child(div().text_color(theme.colors.text_muted).child("No chats yet."))
                    }),
            )
            .children(self.error.clone().map(|e| div().text_color(theme.colors.danger).text_size(theme.fonts.size_sm).child(e)))
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .gap(theme.sizes.gap_sm)
                    .child(div().flex_1().min_w_0().text_color(theme.colors.text_muted).truncate().child(name))
                    .child(button("api-keys", "API keys", self.settings.is_some(), &theme).on_click(cx.listener(|this, _, window, cx| this.toggle_settings(window, cx))))
                    .child(button("sign-out", "Sign out", false, &theme).on_click(cx.listener(|this, _, window, cx| this.sign_out(window, cx)))),
            );

        let content = match (&self.settings, &self.open_chat) {
            (Some(settings), _) => div().flex_1().h_full().child(settings.clone()),
            (None, Some(chat)) => div().flex_1().h_full().child(chat.clone()),
            (None, None) => div()
                .flex_1()
                .h_full()
                .flex()
                .items_center()
                .justify_center()
                .text_color(theme.colors.text_muted)
                .child(if self.loading { "Loading…" } else { "Pick a chat or create one." }),
        };

        div().size_full().flex().child(sidebar).child(content)
    }
}
