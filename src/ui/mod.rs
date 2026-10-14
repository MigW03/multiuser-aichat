pub mod chat;
pub mod login;
pub mod main_view;
pub mod settings;
pub mod text_input;

use std::sync::Arc;

use gpui::{
    Context, Div, ElementId, Entity, IntoElement, ParentElement, Render, SharedString, Stateful, Styled,
    Subscription, Window, actions, div, prelude::*,
};

use crate::backend::Backend;
use crate::runtime;
use crate::theme::Theme;
use login::{LoginEvent, LoginView};
use main_view::{MainEvent, MainView};

actions!(app, [Quit, FocusNext]);

enum Screen {
    Loading,
    Error(SharedString),
    SignIn(Entity<LoginView>),
    Main(Entity<MainView>),
}

pub struct AppView {
    backend: Option<Arc<Backend>>,
    screen: Screen,
    _subscription: Option<Subscription>,
}

impl AppView {
    pub fn new(backend: Result<Arc<Backend>, String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let backend = match backend {
            Ok(b) => b,
            Err(e) => return AppView { backend: None, screen: Screen::Error(e.into()), _subscription: None },
        };

        let restore = runtime::run({
            let backend = backend.clone();
            async move { backend.restore().await }
        });
        cx.spawn_in(window, async move |this, cx| {
            let restored = restore.await.ok().flatten().is_some();
            this.update_in(cx, |this, window, cx| {
                if restored { this.show_main(window, cx) } else { this.show_sign_in(window, cx) }
            })
            .ok();
        })
        .detach();

        AppView { backend: Some(backend), screen: Screen::Loading, _subscription: None }
    }

    fn show_sign_in(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else { return };
        let view = cx.new(|cx| LoginView::new(backend, window, cx));
        self._subscription = Some(cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            LoginEvent::SignedIn => this.show_main(window, cx),
        }));
        self.screen = Screen::SignIn(view);
        cx.notify();
    }

    fn show_main(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else { return };
        let view = cx.new(|cx| MainView::new(backend, window, cx));
        self._subscription = Some(cx.subscribe_in(&view, window, |this, _, event, window, cx| match event {
            MainEvent::SignedOut => this.show_sign_in(window, cx),
        }));
        self.screen = Screen::Main(view);
        cx.notify();
    }
}

impl Render for AppView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx);
        let root = div()
            .size_full()
            .bg(theme.colors.background)
            .text_color(theme.colors.text)
            .font_family(theme.fonts.family.clone())
            .text_size(theme.fonts.size_md)
            .line_height(theme.fonts.line_height);
        match &self.screen {
            Screen::Loading => root.flex().items_center().justify_center().child(
                div().text_color(theme.colors.text_muted).child("Loading…"),
            ),
            Screen::Error(message) => root.flex().items_center().justify_center().p(theme.sizes.gap_lg).child(
                div()
                    .flex()
                    .flex_col()
                    .gap(theme.sizes.gap_sm)
                    .max_w(theme.sizes.bubble_max_width)
                    .child(div().text_size(theme.fonts.size_lg).child("The app is not configured"))
                    .child(div().text_color(theme.colors.danger).child(message.clone()))
                    .child(
                        div()
                            .text_color(theme.colors.text_muted)
                            .child("Copy native/.env.example to native/.env, fill it in, and start the app again."),
                    ),
            ),
            Screen::SignIn(view) => root.child(view.clone()),
            Screen::Main(view) => root.child(view.clone()),
        }
    }
}

/// A themed button. Add `.on_click(...)` at the call site.
pub fn button(id: impl Into<ElementId>, label: impl Into<SharedString>, primary: bool, theme: &Theme) -> Stateful<Div> {
    let (bg, hover, text) = if primary {
        (theme.colors.accent, theme.colors.accent_hover, theme.colors.text_on_accent)
    } else {
        (theme.colors.surface, theme.colors.surface_hover, theme.colors.text)
    };
    div()
        .id(id)
        .flex()
        .items_center()
        .justify_center()
        .h(theme.sizes.input_height)
        .px(theme.sizes.gap_md)
        .rounded(theme.sizes.radius)
        .border(theme.sizes.border_width)
        .border_color(theme.colors.border)
        .bg(bg)
        .text_color(text)
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .child(label.into())
}
