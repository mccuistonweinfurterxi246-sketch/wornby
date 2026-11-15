//! Roblox HTTP access: shared clients, hedged mirror requests, careful retries and small TTL caches.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures::future::{join_all, select_ok};
use serde_json::Value;

// Start the mirror request when the first host is this slow, then take whichever answers first.
const HEDGE_AFTER: Duration = Duration::from_millis(1500);
pub const THUMB_TIMEOUT: Duration = Duration::from_secs(5);

// ── Per-instance TTL cache (Fluid compute reuses instances, so it survives between requests) ──
pub struct Ttl<V> {
    map: Mutex<HashMap<String, (Instant, V)>>,
    ttl: Duration,
    cap: usize,
}

impl<V: Clone> Ttl<V> {
    pub fn new(ttl_secs: u64, cap: usize) -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            ttl: Duration::from_secs(ttl_secs),
            cap,
        }
    }
    pub fn get(&self, key: &str) -> Option<V> {
        let map = self.map.lock().unwrap();
        map.get(key)
            .filter(|(expires, _)| Instant::now() < *expires)
            .map(|(_, v)| v.clone())
    }
    pub fn set(&self, key: String, value: V) {
        self.set_for(key, value, self.ttl);
    }
    pub fn set_for(&self, key: String, value: V, ttl: Duration) {
        let mut map = self.map.lock().unwrap();
        if map.len() >= self.cap {
            let now = Instant::now();
            map.retain(|_, (expires, _)| now < *expires);
            // shortcut: wholesale clear instead of LRU eviction, fine at these sizes
            if map.len() >= self.cap {
                map.clear();
            }
        }
        map.insert(key, (Instant::now() + ttl, value));
    }
    pub fn remove(&self, key: &str) {
        self.map.lock().unwrap().remove(key);
    }
}

static THUMBS: LazyLock<Ttl<String>> = LazyLock::new(|| Ttl::new(10 * 60, 8000));

// ── Clients: EGRESS_COUNT independent connection pools, each optionally behind an EGRESS_PROXIES entry ──
pub static EGRESS_COUNT: LazyLock<usize> = LazyLock::new(|| {
    std::env::var("EGRESS_COUNT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3usize)
        .clamp(1, 8)
});

static CLIENTS: LazyLock<Vec<reqwest::Client>> = LazyLock::new(|| {
    let proxies: Vec<String> = std::env::var("EGRESS_PROXIES")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    (0..*EGRESS_COUNT)
        .map(|i| {
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("Accept", "application/json, text/plain, */*".parse().unwrap());
            headers.insert("Accept-Language", "en-US,en;q=0.9".parse().unwrap());
            let mut builder = reqwest::Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
                .default_headers(headers)
                .connect_timeout(Duration::from_secs(3))
                .pool_idle_timeout(Duration::from_secs(15));
            if let Some(proxy) = proxies.get(i).and_then(|p| reqwest::Proxy::all(p).ok()) {
                builder = builder.proxy(proxy);
            }
            builder.build().expect("http client")
        })
        .collect()
});

/// Consistent pool per id (Knuth multiplicative hash, as in the Node shards).
pub fn client_for(id: u64) -> &'static reqwest::Client {
    let clients = &*CLIENTS;
    &clients[((id.wrapping_mul(2654435761) & 0xffff_ffff) % clients.len() as u64) as usize]
}

pub fn client() -> &'static reqwest::Client {
    &CLIENTS[0]
}

/// Same path on the roproxy mirror (`https://x.roblox.com/...` → `https://x.roproxy.com/...`).
pub fn mirror(url: &str) -> String {
    url.replacen(".roblox.com/", ".roproxy.com/", 1)
}

// ── Requests ──
#[derive(Debug, Clone)]
pub struct UpErr {
    pub status: Option<u16>,
    pub retry_after_secs: Option<u64>,
}

impl UpErr {
    pub fn network() -> Self {
        Self {
            status: None,
            retry_after_secs: None,
        }
    }
    /// Same request will fail on every host: don't try the mirror or retry.
    pub fn is_final(&self) -> bool {
        matches!(self.status, Some(400 | 404))
    }
}

async fn send(request: reqwest::RequestBuilder, url: &str) -> Result<Value, UpErr> {
    let endpoint = url.split('?').next().unwrap_or(url);
    let response = request.send().await.map_err(|e| {
        eprintln!(
            "[upstream] {endpoint} -> {}",
            if e.is_timeout() {
                "timeout"
            } else {
                "network error"
            }
        );
        UpErr::network()
    })?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        eprintln!("[upstream] {endpoint} -> {status}");
        let retry_after_secs = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok());
        return Err(UpErr {
            status: Some(status),
            retry_after_secs,
        });
    }
    // A mirror occasionally answers 200 with an HTML error page: treat it like a network failure.
    response.json::<Value>().await.map_err(|_| {
        eprintln!("[upstream] {endpoint} -> invalid json");
        UpErr::network()
    })
}

pub async fn get_once(
    client: &reqwest::Client,
    url: &str,
    timeout: Duration,
) -> Result<Value, UpErr> {
    send(client.get(url).timeout(timeout), url).await
}

pub async fn post_once(
    client: &reqwest::Client,
    url: &str,
    body: &Value,
    timeout: Duration,
) -> Result<Value, UpErr> {
    send(client.post(url).json(body).timeout(timeout), url).await
}

/// Run `first`; if it fails (non-final) or is slower than HEDGE_AFTER, also run `second` and take the first success.
pub async fn hedge<Fut>(first: Fut, second: impl FnOnce() -> Fut) -> Result<Value, UpErr>
where
    Fut: Future<Output = Result<Value, UpErr>>,
{
    let mut first = Box::pin(first);
    tokio::select! {
        result = &mut first => return match result {
            Ok(v) => Ok(v),
            Err(e) if e.is_final() => Err(e),
            Err(_) => second().await,
        },
        _ = tokio::time::sleep(HEDGE_AFTER) => {}
    }
    let second = Box::pin(second());
    select_ok([first, second]).await.map(|(v, _)| v)
}

/// One careful retry for transient failures: honours Retry-After but never waits more than 1.5s.
pub async fn retry_once<F, Fut>(attempt: F) -> Result<Value, UpErr>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<Value, UpErr>>,
{
    match attempt().await {
        Err(e) if !e.is_final() => {
            let wait_ms = match (e.status, e.retry_after_secs) {
                (Some(429), Some(secs)) => (secs * 1000).min(1500),
                (Some(429), None) => 800,
                _ => 200,
            };
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            attempt().await
        }
        other => other,
    }
}

pub async fn get_hedged(
    client: &reqwest::Client,
    urls: [&str; 2],
    timeout: Duration,
) -> Result<Value, UpErr> {
    hedge(get_once(client, urls[0], timeout), || {
        get_once(client, urls[1], timeout)
    })
    .await
}

pub async fn get_resilient(
    client: &reqwest::Client,
    urls: [&str; 2],
    timeout: Duration,
) -> Result<Value, UpErr> {
    retry_once(|| get_hedged(client, urls, timeout)).await
}

/// Official host first, roproxy mirror as hedge, one retry.
pub async fn get_official(
    client: &reqwest::Client,
    url: &str,
    timeout: Duration,
) -> Result<Value, UpErr> {
    let mirrored = mirror(url);
    get_resilient(client, [url, &mirrored], timeout).await
}

#[derive(Clone, Copy, PartialEq)]
pub enum ThumbKind {
    Asset,
    Bundle,
}

fn thumb_url(kind: ThumbKind, list: &str) -> String {
    match kind {
        ThumbKind::Asset => format!("https://thumbnails.roblox.com/v1/assets?assetIds={list}&size=420x420&format=Png"),
        ThumbKind::Bundle => format!("https://thumbnails.roblox.com/v1/bundles/thumbnails?bundleIds={list}&size=420x420&format=Png"),
    }
}

/// Ready images only: "Error" answers carry a placeholder URL, "Pending" ones none.
fn completed_thumbs(data: &Value) -> Vec<(u64, String)> {
    data["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["state"] == "Completed")
        .filter_map(|t| {
            let id = t["targetId"].as_u64().filter(|&id| id > 0)?;
            let url = t["imageUrl"].as_str().filter(|u| !u.is_empty())?;
            Some((id, url.to_string()))
        })
        .collect()
}

/// Asset thumbnails (420x420); failures are swallowed so ready images still show.
pub async fn asset_thumbnails(ids: &[u64]) -> HashMap<u64, String> {
    thumbnails(ThumbKind::Asset, ids).await
}

/// Bundle thumbnails (the asset service answers bundle ids with a placeholder).
pub async fn bundle_thumbnails(ids: &[u64]) -> HashMap<u64, String> {
    thumbnails(ThumbKind::Bundle, ids).await
}

async fn thumbnails(kind: ThumbKind, ids: &[u64]) -> HashMap<u64, String> {
    let key = |id: u64| if kind == ThumbKind::Bundle { format!("b{id}") } else { id.to_string() };
    let mut out = HashMap::new();
    let mut missing = Vec::new();
    for &id in ids {
        match THUMBS.get(&key(id)) {
            Some(url) => {
                out.insert(id, url);
            }
            None if !missing.contains(&id) => missing.push(id),
            None => {}
        }
    }
    let requests = missing.chunks(100).map(|chunk| async move {
        let list = chunk
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let url = thumb_url(kind, &list);
        get_hedged(client_for(chunk[0]), [&url, &mirror(&url)], THUMB_TIMEOUT).await
    });
    for data in join_all(requests).await.into_iter().flatten() {
        for (id, url) in completed_thumbs(&data) {
            THUMBS.set(key(id), url.clone());
            out.insert(id, url);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    #[test]
    fn bundles_use_the_bundle_thumbnail_service() {
        assert_eq!(
            thumb_url(ThumbKind::Bundle, "5,6"),
            "https://thumbnails.roblox.com/v1/bundles/thumbnails?bundleIds=5,6&size=420x420&format=Png"
        );
        assert_eq!(
            thumb_url(ThumbKind::Asset, "7"),
            "https://thumbnails.roblox.com/v1/assets?assetIds=7&size=420x420&format=Png"
        );
    }

    // A bundle id sent to the asset service comes back "Error" with a placeholder image: never use it.
    #[test]
    fn only_completed_thumbnails_count() {
        let data = json!({ "data": [
            { "targetId": 1, "state": "Completed", "imageUrl": "https://tr.rbxcdn.com/a" },
            { "targetId": 2, "state": "Error", "imageUrl": "https://t2.rbxcdn.com/placeholder" },
            { "targetId": 3, "state": "Pending", "imageUrl": "" } ] });
        assert_eq!(completed_thumbs(&data), vec![(1, "https://tr.rbxcdn.com/a".to_string())]);
    }

    #[test]
    fn mirror_swaps_only_the_host() {
        assert_eq!(
            mirror("https://users.roblox.com/v1/users/1"),
            "https://users.roproxy.com/v1/users/1"
        );
        assert_eq!(
            mirror("https://thumbnails.roblox.com/v1/assets?x=https://www.roblox.com/"),
            "https://thumbnails.roproxy.com/v1/assets?x=https://www.roblox.com/"
        );
    }

    async fn ready(r: Result<Value, UpErr>) -> Result<Value, UpErr> {
        r
    }

    fn err(status: u16, retry_after_secs: Option<u64>) -> UpErr {
        UpErr {
            status: Some(status),
            retry_after_secs,
        }
    }

    #[tokio::test]
    async fn rate_limited_host_falls_back_to_mirror_and_retries_once() {
        // Official host answers 429 at once: the mirror is tried without waiting for the hedge delay.
        let started = Instant::now();
        let v = hedge(ready(Err(err(429, None))), || ready(Ok(Value::from(1)))).await;
        assert_eq!(v.unwrap(), 1);
        assert!(started.elapsed() < HEDGE_AFTER);
        // 404 is final: no mirror call.
        let v = hedge(ready(Err(err(404, None))), || panic!("mirror called")).await;
        assert_eq!(v.unwrap_err().status, Some(404));

        let calls = std::sync::atomic::AtomicU32::new(0);
        let started = Instant::now();
        let v = retry_once(|| {
            let n = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                if n == 0 {
                    Err(err(429, Some(60)))
                } else {
                    Ok(Value::from(2))
                }
            }
        })
        .await;
        assert_eq!(v.unwrap(), 2);
        // Retry-After 60s is capped at 1.5s so the request still fits the endpoint deadline.
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(1400) && waited < Duration::from_millis(2500),
            "{waited:?}"
        );

        // Both attempts throttled: the 429 (with Retry-After) reaches the caller, no third try.
        calls.store(0, std::sync::atomic::Ordering::SeqCst);
        let v = retry_once(|| {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Err(err(429, Some(1))) }
        })
        .await;
        assert_eq!(v.unwrap_err().retry_after_secs, Some(1));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn ttl_cache_expires_and_overrides() {
        let cache: Ttl<u32> = Ttl::new(60, 10);
        cache.set("a".into(), 1);
        cache.set_for("b".into(), 2, Duration::from_millis(0));
        assert_eq!(cache.get("a"), Some(1));
        assert_eq!(cache.get("b"), None);
        cache.remove("a");
        assert_eq!(cache.get("a"), None);
    }
}
