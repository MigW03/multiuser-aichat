//! Every color, size and font the UI uses. Views read these through `Theme::get(cx)`;
//! nothing else in the app should contain a literal color or pixel value.

use gpui::{App, Global, Hsla, Pixels, Rgba, SharedString, px, rgb, rgba};

#[derive(Clone)]
pub struct Colors {
    pub background: Rgba,
    pub surface: Rgba,
    pub surface_hover: Rgba,
    pub border: Rgba,
    pub text: Rgba,
    pub text_muted: Rgba,
    pub text_on_accent: Rgba,
    pub accent: Rgba,
    pub accent_hover: Rgba,
    pub danger: Rgba,
    pub own_bubble: Rgba,
    pub other_bubble: Rgba,
    pub ai_bubble: Rgba,
    pub input_background: Rgba,
    pub placeholder: Rgba,
    pub cursor: Rgba,
    pub selection: Rgba,
}

#[derive(Clone)]
pub struct Sizes {
    pub window_width: Pixels,
    pub window_height: Pixels,
    pub sidebar_width: Pixels,
    pub auth_form_width: Pixels,
    pub bubble_max_width: Pixels,
    pub radius: Pixels,
    pub bubble_radius: Pixels,
    pub gap_xs: Pixels,
    pub gap_sm: Pixels,
    pub gap_md: Pixels,
    pub gap_lg: Pixels,
    pub input_height: Pixels,
    pub input_padding: Pixels,
    pub cursor_width: Pixels,
    pub border_width: Pixels,
}

#[derive(Clone)]
pub struct Fonts {
    pub family: SharedString,
    pub size_sm: Pixels,
    pub size_md: Pixels,
    pub size_lg: Pixels,
    pub size_xl: Pixels,
    pub line_height: Pixels,
}

#[derive(Clone)]
pub struct Theme {
    pub colors: Colors,
    pub sizes: Sizes,
    pub fonts: Fonts,
}

impl Global for Theme {}

impl Theme {
    pub fn get(cx: &App) -> &Theme {
        cx.global::<Theme>()
    }

    pub fn dark() -> Self {
        Theme {
            colors: Colors {
                background: rgb(0x16171b),
                surface: rgb(0x1e1f24),
                surface_hover: rgb(0x2a2b31),
                border: rgb(0x2f3037),
                text: rgb(0xe8e8ec),
                text_muted: rgb(0x8b8d98),
                text_on_accent: rgb(0xffffff),
                accent: rgb(0x5b6cff),
                accent_hover: rgb(0x7180ff),
                danger: rgb(0xff6b6b),
                own_bubble: rgb(0x3341a8),
                other_bubble: rgb(0x2a2b31),
                ai_bubble: rgb(0x1f2a2a),
                input_background: rgb(0x111216),
                placeholder: rgba(0xe8e8ec55),
                cursor: rgb(0x8f9bff),
                selection: rgba(0x5b6cff55),
            },
            sizes: Sizes {
                window_width: px(1100.),
                window_height: px(720.),
                sidebar_width: px(260.),
                auth_form_width: px(340.),
                bubble_max_width: px(560.),
                radius: px(6.),
                bubble_radius: px(10.),
                gap_xs: px(4.),
                gap_sm: px(8.),
                gap_md: px(12.),
                gap_lg: px(20.),
                input_height: px(36.),
                input_padding: px(10.),
                cursor_width: px(2.),
                border_width: px(1.),
            },
            fonts: Fonts {
                family: default_font_family().into(),
                size_sm: px(12.),
                size_md: px(14.),
                size_lg: px(16.),
                size_xl: px(22.),
                line_height: px(20.),
            },
        }
    }
}

fn default_font_family() -> &'static str {
    if cfg!(target_os = "macos") {
        ".SystemUIFont"
    } else if cfg!(windows) {
        "Segoe UI"
    } else {
        "sans-serif"
    }
}

/// Converts a theme color for APIs that take `Hsla`.
pub fn hsla(c: Rgba) -> Hsla {
    c.into()
}
