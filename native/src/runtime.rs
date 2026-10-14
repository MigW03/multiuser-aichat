//! Network code (reqwest, websockets) needs Tokio, while GPUI runs its own executor.
//! Work is spawned on a Tokio runtime here and the result is handed back through a
//! oneshot channel, which GPUI tasks can await.

use std::future::Future;
use std::sync::OnceLock;

use anyhow::{Result, anyhow};
use tokio::runtime::Runtime;

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

pub fn handle() -> tokio::runtime::Handle {
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .thread_name("net")
                .build()
                .expect("could not start the network runtime")
        })
        .handle()
        .clone()
}

/// Runs `fut` on the network runtime; the returned future can be awaited from a GPUI task.
pub fn run<F, T>(fut: F) -> impl Future<Output = Result<T>> + 'static
where
    F: Future<Output = Result<T>> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    handle().spawn(async move {
        let _ = tx.send(fut.await);
    });
    async move { rx.await.map_err(|_| anyhow!("the request was cancelled"))? }
}
