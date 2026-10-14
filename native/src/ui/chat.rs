use std::collections::HashMap;
use std::sync::Arc;

use gpui::{
    Context, Entity, Focusable, IntoElement, ParentElement, Render, ScrollHandle, SharedString, Styled,
    Subscription, Task, Window, div, prelude::*,
};

use super::text_input::{InputEvent, TextInput};
use crate::backend::Backend;
use crate::backend::models::{Chat, Member, Message, ModelChoice, MyProfile};
use crate::backend::realtime::{self, ChatSubscription, RealtimeEvent};
use crate::runtime;
use crate::theme::Theme;

/// Sorts after every saved message until the real row (with its seq) arrives over realtime.
const OPTIMISTIC_SEQ: i64 = i64::MAX;

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
    composer: Entity<TextInput>,
    scroll: ScrollHandle,
    _realtime: ChatSubscription,
    _events: Task<()>,
    _subscriptions: Vec<Subscription>,
}

impl ChatView {
    pub fn new(backend: Arc<Backend>, chat: Chat, me: MyProfile, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let composer = cx.new(|cx| TextInput::new("Message the chat… (Enter to send)", cx));
        let subscriptions = vec![cx.subscribe_in(&composer, window, |this, _, InputEvent::Submit, window, cx| {
            this.send(window, cx);
        })];
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
            // The model this person last picked for this chat, as the web app remembers it.
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
                log::warn(&reason);
                self.notice = Some(format!("Live updates paused, reconnecting: {reason}").into());
            }
            RealtimeEvent::Upsert(message) => {
                if message.status == "done" || message.status == "error" {
                    self.streams.remove(&message.id);
                }
                let unknown_author = message.author_id.as_ref().is_some_and(|a| !self.names.contains_key(a));
                self.upsert(message);
                if unknown_author {
                    self.load(window, cx); // someone joined through an invite link
                }
            }
            RealtimeEvent::Stream { message_id, content } => {
                self.streams.insert(message_id, content);
                self.scroll.scroll_to_bottom();
            }
        }
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
            self.notice = Some("Pick a model for this chat in the web app first (model picker next to the message box).".into());
            cx.notify();
            return;
        };
        self.notice = None;
        self.composer.update(cx, |input, cx| input.clear(cx));

        // Shown right away. The server reuses this id, so the saved row replaces it instead of duplicating it.
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
            runtime::run(async move { backend.send_message(&chat_id, &id, &content, &choice).await })
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

impl Render for ChatView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx).clone();
        let model_label = self.choice.as_ref().map(|c| c.label()).unwrap_or_else(|| "No model picked".into());
        let header = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(theme.sizes.gap_md)
            .px(theme.sizes.gap_lg)
            .py(theme.sizes.gap_md)
            .border_b(theme.sizes.border_width)
            .border_color(theme.colors.border)
            .child(div().text_size(theme.fonts.size_lg).truncate().child(self.chat.title.clone()))
            .child(
                div()
                    .flex()
                    .gap(theme.sizes.gap_md)
                    .text_size(theme.fonts.size_sm)
                    .text_color(theme.colors.text_muted)
                    .child(model_label)
                    .child(if self.live { "● Live" } else { "○ Connecting…" }),
            );

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
            .children(self.notice.clone().map(|n| div().text_size(theme.fonts.size_sm).text_color(theme.colors.danger).child(n)))
            .child(self.composer.clone());

        div().size_full().flex().flex_col().child(header).child(messages).child(composer)
    }
}

mod log {
    pub fn warn(message: &str) {
        eprintln!("[realtime] {message}");
    }
}
