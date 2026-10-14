use std::collections::HashMap;
use std::sync::Arc;

use gpui::{
    Context, Entity, EventEmitter, Focusable, IntoElement, ParentElement, Render, ScrollHandle, SharedString,
    Styled, Subscription, Task, Window, div, prelude::*,
};

use super::button;
use super::text_input::{InputEvent, TextInput};
use crate::backend::models::{Chat, Member, Message, ModelChoice, MyProfile};
use crate::backend::realtime::{self, ChatSubscription, RealtimeEvent};
use crate::backend::{Backend, keys, runner};
use crate::runtime;
use crate::theme::Theme;

/// Sorts after every saved message until the real row (with its seq) arrives over realtime.
const OPTIMISTIC_SEQ: i64 = i64::MAX;

pub enum ChatEvent {
    Renamed { chat_id: String, title: String },
}

/// The editor shown under the header, if any.
#[derive(Clone, Copy, PartialEq)]
enum Panel {
    None,
    Rename,
    Invite,
    Model,
}

pub struct ChatView {
    backend: Arc<Backend>,
    chat: Chat,
    me: MyProfile,
    messages: Vec<Message>,
    /// Live text of assistant messages that are still streaming, by message id.
    streams: HashMap<String, String>,
    names: HashMap<String, String>,
    choice: Option<ModelChoice>,
    live: bool,
    notice: Option<SharedString>,
    panel: Panel,
    panel_provider: &'static str,
    panel_input: Entity<TextInput>,
    panel_busy: bool,
    composer: Entity<TextInput>,
    scroll: ScrollHandle,
    _realtime: ChatSubscription,
    _events: Task<()>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ChatEvent> for ChatView {}

impl ChatView {
    pub fn new(backend: Arc<Backend>, chat: Chat, me: MyProfile, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let composer = cx.new(|cx| TextInput::new("Message the chat… (Enter to send)", cx));
        let panel_input = cx.new(|cx| TextInput::new("", cx));
        let subscriptions = vec![
            cx.subscribe_in(&composer, window, |this, _, InputEvent::Submit, window, cx| this.send(window, cx)),
            cx.subscribe_in(&panel_input, window, |this, _, InputEvent::Submit, window, cx| {
                this.submit_panel(window, cx)
            }),
        ];
        window.focus(&composer.focus_handle(cx));

        let (subscription, mut events) = realtime::subscribe(backend.clone(), chat.id.clone());
        let event_loop = cx.spawn_in(window, async move |this, cx| {
            while let Some(event) = events.recv().await {
                if this.update_in(cx, |this, window, cx| this.on_realtime(event, window, cx)).is_err() {
                    break;
                }
            }
        });

        let mut this = ChatView {
            backend,
            choice: ModelChoice::from_parts(me.ai_provider.clone(), me.ai_model.clone()),
            names: HashMap::from([(me.id.clone(), me.display_name.clone())]),
            chat,
            me,
            messages: Vec::new(),
            streams: HashMap::new(),
            live: false,
            notice: None,
            panel: Panel::None,
            panel_provider: keys::PROVIDERS[0],
            panel_input,
            panel_busy: false,
            composer,
            scroll: ScrollHandle::new(),
            _realtime: subscription,
            _events: event_loop,
            _subscriptions: subscriptions,
        };
        this.load(window, cx);
        this
    }

    /// Loads members and the full history. Also called after (re)joining the live channel,
    /// since anything that happened while disconnected was missed.
    fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let backend = self.backend.clone();
        let chat_id = self.chat.id.clone();
        let request = runtime::run(async move {
            let members = backend.members(&chat_id).await?;
            let messages = backend.messages(&chat_id).await?;
            Ok((members, messages))
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok((members, messages)) => {
                        this.apply_members(members);
                        // Keep optimistic messages that the server hasn't confirmed yet.
                        let pending: Vec<Message> = this
                            .messages
                            .drain(..)
                            .filter(|m| m.seq == OPTIMISTIC_SEQ && !messages.iter().any(|s| s.id == m.id))
                            .collect();
                        this.messages = messages;
                        this.messages.extend(pending);
                        this.scroll.scroll_to_bottom();
                        // Answer anything of ours left unanswered (sent while a reply was interrupted, say).
                        let me = this.me.id.as_str();
                        if this.messages.iter().any(|m| m.author_id.as_deref() == Some(me) && m.status == "pending") {
                            runner::ensure_running(this.backend.clone(), this.chat.id.clone());
                        }
                    }
                    Err(e) => this.notice = Some(e.to_string().into()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn apply_members(&mut self, members: Vec<Member>) {
        for m in members {
            if let Some(p) = &m.profiles {
                self.names.insert(p.id.clone(), p.display_name.clone());
            }
            // The model this person last picked for this chat.
            if m.user_id == self.me.id {
                if let Some(choice) = ModelChoice::from_parts(m.ai_provider, m.ai_model) {
                    self.choice = Some(choice);
                }
            }
        }
    }

    fn on_realtime(&mut self, event: RealtimeEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            RealtimeEvent::Joined => {
                self.live = true;
                self.notice = None;
                self.load(window, cx);
            }
            RealtimeEvent::Disconnected(reason) => {
                self.live = false;
                eprintln!("[realtime] {reason}");
                self.notice = Some(format!("Live updates paused, reconnecting: {reason}").into());
            }
            RealtimeEvent::Upsert(message) => {
                if message.status == "done" || message.status == "error" {
                    self.streams.remove(&message.id);
                }
                let unknown_author = message.author_id.as_ref().is_some_and(|a| !self.names.contains_key(a));
                self.upsert(message);
                if unknown_author {
                    self.load(window, cx); // someone new joined the chat
                }
            }
            RealtimeEvent::Stream { message_id, content } => {
                self.streams.insert(message_id, content);
                self.scroll.scroll_to_bottom();
            }
            RealtimeEvent::Renamed(title) => self.set_title(title, cx),
        }
        cx.notify();
    }

    fn set_title(&mut self, title: String, cx: &mut Context<Self>) {
        self.chat.title = title.clone();
        cx.emit(ChatEvent::Renamed { chat_id: self.chat.id.clone(), title });
        cx.notify();
    }

    fn upsert(&mut self, message: Message) {
        match self.messages.iter_mut().find(|m| m.id == message.id) {
            Some(existing) => *existing = message,
            None => self.messages.push(message),
        }
        self.messages.sort_by_key(|m| m.seq);
        self.scroll.scroll_to_bottom();
    }

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let content = self.composer.read(cx).text().trim().to_string();
        if content.is_empty() {
            return;
        }
        let Some(choice) = self.choice.clone() else {
            self.notice = Some("Pick a model first (Model, at the top right).".into());
            self.open_panel(Panel::Model, window, cx);
            return;
        };
        self.notice = None;
        self.composer.update(cx, |input, cx| input.clear(cx));

        // Shown right away. The saved row has the same id, so it replaces this one instead of duplicating it.
        let id = uuid::Uuid::new_v4().to_string();
        self.upsert(Message {
            id: id.clone(),
            author_id: Some(self.me.id.clone()),
            role: "user".into(),
            content: content.clone(),
            status: "pending".into(),
            seq: OPTIMISTIC_SEQ,
            provider: Some(choice.provider.clone()),
            model: Some(choice.model.clone()),
        });
        cx.notify();

        let backend = self.backend.clone();
        let chat_id = self.chat.id.clone();
        let request = {
            let id = id.clone();
            runtime::run(async move {
                backend.insert_message(&chat_id, &id, &content, &choice).await?;
                runner::ensure_running(backend, chat_id);
                Ok(())
            })
        };
        cx.spawn_in(window, async move |this, cx| {
            if let Err(e) = request.await {
                this.update(cx, |this, cx| {
                    this.messages.retain(|m| !(m.id == id && m.seq == OPTIMISTIC_SEQ));
                    this.notice = Some(e.to_string().into());
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    // ------------------------------------------------------------- header editors

    fn open_panel(&mut self, panel: Panel, window: &mut Window, cx: &mut Context<Self>) {
        if self.panel == panel {
            return self.close_panel(window, cx);
        }
        self.panel = panel;
        self.notice = None;
        let (placeholder, text) = match panel {
            Panel::Rename => ("Chat title", self.chat.title.clone()),
            Panel::Invite => ("Their account email", String::new()),
            Panel::Model => {
                if let Some(choice) = &self.choice {
                    self.panel_provider = keys::PROVIDERS.iter().copied().find(|p| *p == choice.provider).unwrap_or(keys::PROVIDERS[0]);
                }
                ("Model id, e.g. gpt-4o-mini or anthropic/claude-sonnet-4", self.choice.as_ref().map(|c| c.model.clone()).unwrap_or_default())
            }
            Panel::None => ("", String::new()),
        };
        self.panel_input.update(cx, |input, cx| {
            *input = TextInput::new(placeholder, cx);
            input.set_text(text, cx);
        });
        window.focus(&self.panel_input.focus_handle(cx));
        cx.notify();
    }

    fn close_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.panel = Panel::None;
        self.panel_busy = false;
        window.focus(&self.composer.focus_handle(cx));
        cx.notify();
    }

    fn submit_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let value = self.panel_input.read(cx).text().trim().to_string();
        if value.is_empty() || self.panel_busy {
            return;
        }
        let backend = self.backend.clone();
        let chat_id = self.chat.id.clone();
        let panel = self.panel;
        let provider = self.panel_provider;
        self.panel_busy = true;
        cx.notify();

        let request = runtime::run(async move {
            Ok(match panel {
                Panel::Rename => PanelResult::Renamed(backend.rename_chat(&chat_id, &value).await?),
                Panel::Invite => PanelResult::Invited(backend.invite(&chat_id, &value).await?),
                Panel::Model => {
                    let choice = ModelChoice { provider: provider.to_string(), model: value };
                    backend.set_chat_model(&chat_id, &choice).await?;
                    PanelResult::Model(choice)
                }
                Panel::None => PanelResult::Nothing,
            })
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            this.update_in(cx, |this, window, cx| {
                this.panel_busy = false;
                match result {
                    Ok(PanelResult::Renamed(title)) => {
                        this.set_title(title, cx);
                        this.close_panel(window, cx);
                    }
                    Ok(PanelResult::Invited(name)) => {
                        this.notice = Some(format!("{name} was added to the chat.").into());
                        this.close_panel(window, cx);
                        this.load(window, cx);
                    }
                    Ok(PanelResult::Model(choice)) => {
                        this.choice = Some(choice);
                        this.close_panel(window, cx);
                    }
                    Ok(PanelResult::Nothing) => {}
                    Err(e) => this.notice = Some(e.to_string().into()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // ------------------------------------------------------------------ render

    fn render_panel(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let (title, action) = match self.panel {
            Panel::None => return None,
            Panel::Rename => ("Rename this chat", "Save"),
            Panel::Invite => ("Add someone who already has an account", "Add"),
            Panel::Model => ("The model that answers your messages here", "Use model"),
        };
        let providers = (self.panel == Panel::Model).then(|| {
            div().flex().gap(theme.sizes.gap_xs).children(keys::PROVIDERS.iter().map(|p| {
                let provider: &'static str = p;
                button(SharedString::from(format!("provider-{provider}")), keys::provider_label(provider).to_string(), self.panel_provider == provider, theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.panel_provider = provider;
                        cx.notify();
                    }))
            }))
        });
        Some(
            div()
                .flex()
                .flex_col()
                .gap(theme.sizes.gap_sm)
                .px(theme.sizes.gap_lg)
                .py(theme.sizes.gap_md)
                .bg(theme.colors.surface)
                .border_b(theme.sizes.border_width)
                .border_color(theme.colors.border)
                .child(div().text_size(theme.fonts.size_sm).text_color(theme.colors.text_muted).child(title))
                .children(providers)
                .child(
                    div()
                        .flex()
                        .gap(theme.sizes.gap_sm)
                        .child(div().flex_1().child(self.panel_input.clone()))
                        .child(
                            button("panel-submit", if self.panel_busy { "…" } else { action }, true, theme)
                                .on_click(cx.listener(|this, _, window, cx| this.submit_panel(window, cx))),
                        )
                        .child(button("panel-cancel", "Cancel", false, theme).on_click(cx.listener(|this, _, window, cx| this.close_panel(window, cx)))),
                ),
        )
    }

    fn render_message(&self, message: &Message, theme: &Theme) -> impl IntoElement {
        let own = message.author_id.as_deref() == Some(self.me.id.as_str());
        let author = if message.is_assistant() {
            match &message.model {
                Some(model) => format!("AI · {model}"),
                None => "AI".to_string(),
            }
        } else if own {
            "You".to_string()
        } else {
            message.author_id.as_ref().and_then(|a| self.names.get(a)).cloned().unwrap_or_else(|| "Someone".into())
        };

        let streaming = message.status == "streaming";
        let text = if streaming {
            self.streams.get(&message.id).cloned().filter(|t| !t.is_empty()).unwrap_or_else(|| "…".into())
        } else {
            message.content.clone()
        };
        let status = match message.status.as_str() {
            "pending" if own => Some("Waiting in queue…"),
            "processing" => Some("AI is answering…"),
            "error" if !message.is_assistant() => Some("Not answered"),
            _ => None,
        };
        let bubble_bg = if message.is_assistant() {
            theme.colors.ai_bubble
        } else if own {
            theme.colors.own_bubble
        } else {
            theme.colors.other_bubble
        };

        div()
            .w_full()
            .flex()
            .flex_col()
            .when(own, |d| d.items_end())
            .when(!own, |d| d.items_start())
            .gap(theme.sizes.gap_xs)
            .child(div().text_size(theme.fonts.size_sm).text_color(theme.colors.text_muted).child(author))
            .child(
                div()
                    .max_w(theme.sizes.bubble_max_width)
                    .px(theme.sizes.gap_md)
                    .py(theme.sizes.gap_sm)
                    .rounded(theme.sizes.bubble_radius)
                    .bg(bubble_bg)
                    .when(message.status == "error" && message.is_assistant(), |d| d.text_color(theme.colors.danger))
                    .child(text),
            )
            .children(status.map(|s| div().text_size(theme.fonts.size_sm).text_color(theme.colors.text_muted).child(s)))
    }
}

enum PanelResult {
    Renamed(String),
    Invited(String),
    Model(ModelChoice),
    Nothing,
}

impl Render for ChatView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx).clone();
        let model_label = self.choice.as_ref().map(|c| c.label()).unwrap_or_else(|| "Pick a model".into());
        let header = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(theme.sizes.gap_md)
            .px(theme.sizes.gap_lg)
            .py(theme.sizes.gap_md)
            .border_b(theme.sizes.border_width)
            .border_color(theme.colors.border)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(theme.sizes.gap_sm)
                    .min_w_0()
                    .child(div().text_size(theme.fonts.size_lg).truncate().child(self.chat.title.clone()))
                    .child(
                        div()
                            .text_size(theme.fonts.size_sm)
                            .text_color(theme.colors.text_muted)
                            .child(if self.live { "● Live" } else { "○ Connecting…" }),
                    ),
            )
            .child(
                div()
                    .flex()
                    .gap(theme.sizes.gap_sm)
                    .child(button("open-model", model_label, false, &theme).on_click(cx.listener(|this, _, window, cx| this.open_panel(Panel::Model, window, cx))))
                    .child(button("open-invite", "Invite", false, &theme).on_click(cx.listener(|this, _, window, cx| this.open_panel(Panel::Invite, window, cx))))
                    .child(button("open-rename", "Rename", false, &theme).on_click(cx.listener(|this, _, window, cx| this.open_panel(Panel::Rename, window, cx)))),
            );
        let panel = self.render_panel(&theme, cx);

        let messages = div()
            .id("messages")
            .flex_1()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .px(theme.sizes.gap_lg)
            .py(theme.sizes.gap_md)
            .flex()
            .flex_col()
            .gap(theme.sizes.gap_md)
            .children(self.messages.iter().map(|m| self.render_message(m, &theme)))
            .when(self.messages.is_empty(), |d| d.child(div().text_color(theme.colors.text_muted).child("No messages yet. Say hi.")));

        let composer = div()
            .flex()
            .flex_col()
            .gap(theme.sizes.gap_xs)
            .px(theme.sizes.gap_lg)
            .py(theme.sizes.gap_md)
            .border_t(theme.sizes.border_width)
            .border_color(theme.colors.border)
            .children(self.notice.clone().map(|n| div().text_size(theme.fonts.size_sm).text_color(theme.colors.text_muted).child(n)))
            .child(self.composer.clone());

        div().size_full().flex().flex_col().child(header).children(panel).child(messages).child(composer)
    }
}
