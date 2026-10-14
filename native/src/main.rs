mod backend;
mod config;
mod runtime;
mod theme;
mod ui;

use gpui::{App, AppContext as _, Application, Bounds, KeyBinding, TitlebarOptions, WindowBounds, WindowOptions};

use backend::Backend;
use config::Config;
use theme::Theme;
use ui::text_input::{self, Backspace, Copy, Cut, Delete, End, Home, Left, Paste, Right, SelectAll, SelectLeft, SelectRight, Submit};
use ui::{AppView, FocusNext, Quit};

fn main() {
    // Config errors are shown in the window instead of crashing.
    let backend = Config::load().map(Backend::new).map_err(|e| format!("{e:#}"));

    Application::new().run(move |cx: &mut App| {
        cx.set_global(Theme::dark());
        bind_keys(cx);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        let theme = Theme::get(cx);
        let bounds = Bounds::centered(None, gpui::size(theme.sizes.window_width, theme.sizes.window_height), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions { title: Some("Multiuser Chat".into()), ..Default::default() }),
                ..Default::default()
            },
            |window, cx| cx.new(|cx| AppView::new(backend, window, cx)),
        )
        .expect("could not open the window");
        cx.activate(true);
    });
}

fn bind_keys(cx: &mut App) {
    let input = Some(text_input::CONTEXT);
    cx.bind_keys([
        // "secondary" is Cmd on macOS and Ctrl on Windows and Linux.
        KeyBinding::new("secondary-q", Quit, None),
        KeyBinding::new("tab", FocusNext, None),
        KeyBinding::new("enter", Submit, input),
        KeyBinding::new("backspace", Backspace, input),
        KeyBinding::new("delete", Delete, input),
        KeyBinding::new("left", Left, input),
        KeyBinding::new("right", Right, input),
        KeyBinding::new("shift-left", SelectLeft, input),
        KeyBinding::new("shift-right", SelectRight, input),
        KeyBinding::new("home", Home, input),
        KeyBinding::new("end", End, input),
        KeyBinding::new("secondary-left", Home, input),
        KeyBinding::new("secondary-right", End, input),
        KeyBinding::new("secondary-a", SelectAll, input),
        KeyBinding::new("secondary-v", Paste, input),
        KeyBinding::new("secondary-c", Copy, input),
        KeyBinding::new("secondary-x", Cut, input),
    ]);
}
