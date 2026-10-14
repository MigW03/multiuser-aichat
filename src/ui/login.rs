use std::sync::Arc;

use gpui::{
    Context, Entity, EventEmitter, Focusable, IntoElement, ParentElement, Render, SharedString, Styled,
    Subscription, Window, div, prelude::*,
};

use super::text_input::{InputEvent, TextInput};
use super::{FocusNext, button};
use crate::backend::Backend;
use crate::runtime;
use crate::theme::Theme;

pub enum LoginEvent {
    SignedIn,
}

pub struct LoginView {
    backend: Arc<Backend>,
    email: Entity<TextInput>,
    password: Entity<TextInput>,
    error: Option<SharedString>,
    busy: bool,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<LoginEvent> for LoginView {}

impl LoginView {
    pub fn new(backend: Arc<Backend>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let email = cx.new(|cx| TextInput::new("Email", cx));
        let password = cx.new(|cx| TextInput::new("Password", cx).masked());
        let subscriptions = vec![
            cx.subscribe_in(&email, window, |this, _, InputEvent::Submit, window, cx| {
                window.focus(&this.password.focus_handle(cx));
            }),
            cx.subscribe_in(&password, window, |this, _, InputEvent::Submit, window, cx| {
                this.sign_in(window, cx);
            }),
        ];
        window.focus(&email.focus_handle(cx));
        LoginView { backend, email, password, error: None, busy: false, _subscriptions: subscriptions }
    }

    fn focus_next(&mut self, _: &FocusNext, window: &mut Window, cx: &mut Context<Self>) {
        let next = if self.email.focus_handle(cx).is_focused(window) { &self.password } else { &self.email };
        window.focus(&next.focus_handle(cx));
    }

    fn sign_in(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let email = self.email.read(cx).text().trim().to_string();
        let password = self.password.read(cx).text();
        if email.is_empty() || password.is_empty() {
            self.error = Some("Enter your email and password.".into());
            cx.notify();
            return;
        }
        self.busy = true;
        self.error = None;
        cx.notify();

        let backend = self.backend.clone();
        let request = runtime::run(async move { backend.sign_in(&email, &password).await });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(_) => cx.emit(LoginEvent::SignedIn),
                    Err(e) => this.error = Some(e.to_string().into()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

impl Render for LoginView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx).clone();
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .on_action(cx.listener(Self::focus_next))
            .child(
                div()
                    .w(theme.sizes.auth_form_width)
                    .flex()
                    .flex_col()
                    .gap(theme.sizes.gap_md)
                    .p(theme.sizes.gap_lg)
                    .bg(theme.colors.surface)
                    .border(theme.sizes.border_width)
                    .border_color(theme.colors.border)
                    .rounded(theme.sizes.bubble_radius)
                    .child(div().text_size(theme.fonts.size_xl).child("Sign in"))
                    .child(
                        div()
                            .text_color(theme.colors.text_muted)
                            .text_size(theme.fonts.size_sm)
                            .child("Use the same account as the web app."),
                    )
                    .child(self.email.clone())
                    .child(self.password.clone())
                    .children(self.error.clone().map(|e| div().text_color(theme.colors.danger).child(e)))
                    .child(
                        button("sign-in", if self.busy { "Signing in…" } else { "Sign in" }, true, &theme)
                            .on_click(cx.listener(|this, _, window, cx| this.sign_in(window, cx))),
                    ),
            )
    }
}
