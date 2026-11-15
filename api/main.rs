// Vercel Function serving every /api route (vercel.json rewrites /api/* here).
// Locally `cargo run --release --bin main` listens on PORT (default 3001, where the Vite dev proxy points).
use vercel_runtime::{Error, run, service_fn};

fn main() -> Result<(), Error> {
    if std::env::var_os("VERCEL").is_none() && std::env::var_os("VERCEL_DEV_PORT").is_none() {
        let port = std::env::var("PORT").unwrap_or_else(|_| "3001".into());
        // SAFETY: runs before the Tokio runtime starts, while the process is still single-threaded.
        unsafe { std::env::set_var("VERCEL_DEV_PORT", port) };
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(service_fn(wornby_api::handle)))
}
