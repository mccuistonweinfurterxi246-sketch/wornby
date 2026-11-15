//! Rust backend for the Roblox Outfits & Groups explorer. Serves every /api route with the same
//! responses as the former Express server (server/index.ts), so the frontend is unchanged.

mod archive;
mod catalog;
mod explore;
mod outfits;
mod profile;
mod upstream;
mod wayback;

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use http_body::Frame;
use http_body_util::{BodyExt, Limited, StreamBody};
use serde_json::{Map, Value, json};
use vercel_runtime::{Error, Request, Response, ResponseBody};

use crate::catalog::StoreQuery;
use crate::profile::{Msg, Sink, profile_error};

const MAX_BODY: usize = 50 * 1024;
const RATE_WINDOW: Duration = Duration::from_secs(60);
const RATE_MAX: u32 = 60;
const FRESH_MAX: u32 = 5;
// Archive snapshots come in bursts (hundreds per large account) but are immutable and CDN-cached;
// Wayback itself is protected by wayback.rs's per-instance concurrency cap.
const SNAPSHOT_MAX: u32 = 400;
// Server-side deadlines, each below the frontend's axios timeout for that endpoint.
const SEARCH_DEADLINE: Duration = Duration::from_secs(7); // client 8s
const PROFILE_DEADLINE: Duration = Duration::from_secs(18); // client 20s
const STORE_DEADLINE: Duration = Duration::from_secs(13); // client 15s
const STATUS_DEADLINE: Duration = Duration::from_secs(9); // client 10s
const THUMBS_RETRY_UNTIL: Duration = Duration::from_secs(8); // client 15s

static STARTED: LazyLock<Instant> = LazyLock::new(Instant::now);
static RATE: LazyLock<Mutex<HashMap<String, (u32, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// ── Responses ──
fn respond(status: u16, body: Value, cache_control: Option<&str>) -> Response<ResponseBody> {
    let mut builder = Response::builder()
        .status(status)
        .header("Content-Type", "application/json; charset=utf-8");
    if let Some(cc) = cache_control {
        builder = builder.header("Cache-Control", cc);
    }
    builder.body(ResponseBody::from(body.to_string())).unwrap()
}

fn error(status: u16, message: &str) -> Response<ResponseBody> {
    respond(status, json!({ "error": message }), None)
}

fn upstream_error(e: &upstream::UpErr, message: &str) -> Response<ResponseBody> {
    if e.status == Some(429) {
        let secs = e.retry_after_secs.unwrap_or(2).clamp(1, 30);
        let mut res = respond(
            429,
            json!({ "error": "Roblox is rate limiting requests right now, try again shortly." }),
            Some("no-store"),
        );
        res.headers_mut()
            .insert("Retry-After", secs.to_string().parse().unwrap());
        return res;
    }
    respond(502, json!({ "error": message }), Some("no-store"))
}

/// Explore feed answer: CDN-cached when the page is complete, never cached when partial or failed.
fn feed_response(result: Result<(Value, bool), upstream::UpErr>, message: &str) -> Response<ResponseBody> {
    match result {
        Ok((page, true)) => respond(200, page, Some("public, max-age=300, stale-while-revalidate=600")),
        Ok((page, false)) => respond(200, page, Some("no-store")),
        Err(e) => upstream_error(&e, message),
    }
}

fn set_header(res: &mut Response<ResponseBody>, name: &'static str, value: &str) {
    if let Ok(v) = value.parse() {
        res.headers_mut().insert(name, v);
    }
}

// ── Input parsing (same acceptance rules as the Express handlers) ──
/// Positive integer id within JS safe-integer range (digits only).
fn parse_id(raw: &str) -> Option<u64> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 16 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u64>()
        .ok()
        .filter(|&id| id > 0 && id <= 9_007_199_254_740_991)
}

/// JS `parseInt(x, 10) || fallback`: leading integer, NaN/0 → fallback.
fn js_int(raw: Option<&String>, fallback: i64) -> i64 {
    let raw = raw.map(|s| s.trim()).unwrap_or("");
    let (negative, digits) = match raw.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, raw.strip_prefix('+').unwrap_or(raw)),
    };
    let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
    match digits.parse::<i64>() {
        Ok(0) | Err(_) => fallback,
        Ok(v) => {
            if negative {
                -v
            } else {
                v
            }
        }
    }
}

fn store_query(query: &HashMap<String, String>) -> StoreQuery {
    let sort_type = match query.get("sortType").map(String::as_str) {
        Some("PriceAsc") => "PriceAsc",
        Some("PriceDesc") => "PriceDesc",
        Some("Relevance") => "Relevance",
        _ => "RecentlyCreated",
    };
    let asc = query
        .get("sortOrder")
        .is_some_and(|s| s.eq_ignore_ascii_case("asc"));
    StoreQuery {
        cursor: query
            .get("cursor")
            .map(|s| s.trim().to_string())
            .unwrap_or_default(),
        limit: js_int(query.get("limit"), 100).clamp(10, 120) as u32,
        sort_type,
        sort_order: if asc { "Asc" } else { "Desc" },
        thumbnails: query.get("fast").map(String::as_str) != Some("1"),
        section: query.get("section").and_then(|s| catalog::Section::parse(s)),
    }
}

/// Body of POST /api/asset-thumbnails: unique positive safe-integer ids, max 120.
fn thumbnail_ids(body: &Value) -> Vec<u64> {
    let mut ids = Vec::new();
    for raw in body["assetIds"].as_array().into_iter().flatten() {
        let number = match raw {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        };
        let Some(n) =
            number.filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0)
        else {
            continue;
        };
        let id = n as u64;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.truncate(120);
    ids
}

/// Username (3-20 chars, starts with a letter, no "__", no trailing "_") or numeric user id.
fn valid_user_query(q: &str) -> bool {
    if !q.is_empty() && q.bytes().all(|b| b.is_ascii_digit()) {
        return q.len() <= 16
            && !q.starts_with('0')
            && q.parse::<u64>().is_ok_and(|n| n <= 9_007_199_254_740_991);
    }
    let bytes = q.as_bytes();
    (3..=20).contains(&bytes.len())
        && bytes[0].is_ascii_alphabetic()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
        && !q.contains("__")
        && !q.ends_with('_')
}

// ── Security: origin allow-list and per-IP rate limits ──
fn is_allowed_origin(origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(origin) = origin else { return true };
    let Ok(parsed) = url::Url::parse(origin) else {
        return false;
    };
    // Browsers also send Origin on same-origin POSTs; the site's own origin is never cross-origin.
    let origin_host = match parsed.port() {
        Some(port) => format!("{}:{port}", parsed.host_str().unwrap_or("")),
        None => parsed.host_str().unwrap_or("").to_string(),
    };
    if host.is_some_and(|h| h.eq_ignore_ascii_case(&origin_host)) {
        return true;
    }
    let allowed: Vec<String> = std::env::var("ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if !allowed.is_empty() {
        return allowed.iter().any(|a| a == origin || a == "*");
    }
    // No allow-list: allow in dev, deny cross-origin in production.
    let is_prod =
        std::env::var("NODE_ENV").as_deref() == Ok("production") || std::env::var("VERCEL").is_ok();
    !is_prod
}

/// Fixed-window counter; Some(ms until reset) once `max` is exceeded.
fn rate_limited(key: &str, max: u32) -> Option<u128> {
    let mut map = RATE.lock().unwrap();
    let now = Instant::now();
    if map.len() > 10_000 {
        map.retain(|_, (_, start)| now.duration_since(*start) < RATE_WINDOW);
    }
    let entry = map.entry(key.to_string()).or_insert((0, now));
    if now.duration_since(entry.1) >= RATE_WINDOW {
        *entry = (0, now);
    }
    entry.0 += 1;
    (entry.0 > max).then(|| (RATE_WINDOW - now.duration_since(entry.1)).as_millis())
}

// ── Health ──
/// ISO-8601 UTC timestamp with milliseconds (Date.prototype.toISOString).
fn iso_now() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    iso_from_ms(ms)
}

fn iso_from_ms(ms: i64) -> String {
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (h, m, s, milli) = (
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000,
    );
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{milli:03}Z")
}

fn health() -> Response<ResponseBody> {
    respond(
        200,
        json!({
            "status": "operational",
            "service": "ANTIGRAVITY Roblox Telemetry Proxy",
            "version": "2026.1.0",
            "uptimeSeconds": STARTED.elapsed().as_secs(),
            "timestamp": iso_now(),
        }),
        None,
    )
}

// ── Profile (JSON or SSE) ──
fn sse_frame(msg: &Msg) -> String {
    match msg {
        Msg::Event(event, data) => format!("event: {event}\ndata: {data}\n\n"),
        Msg::KeepAlive => ": keepalive\n\n".to_string(),
        Msg::End => "event: end\ndata: {\"ok\":true}\n\n".to_string(),
        Msg::Fail(status, message) => format!(
            "event: error\ndata: {}\n\n",
            json!({ "error": message, "status": status })
        ),
    }
}

/// Headers go out with the first event, so early failures (unknown user, rate limit) still get a real HTTP status.
async fn profile_stream(query: String, fresh: bool) -> Response<ResponseBody> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Msg>();
    let sink = Arc::new(Sink::new(tx.clone()));
    tokio::spawn(async move {
        let result = profile::stream_profile(&query, fresh, sink.clone()).await;
        match result {
            Ok(()) => sink.finish(Msg::End),
            Err(e) => {
                eprintln!(
                    "[API Error] Stream failed for \"{}\": {}",
                    clean(&query),
                    clean(&e.message)
                );
                let (status, message) = profile_error(&e);
                sink.finish(Msg::Fail(status, message));
            }
        }
    });
    let keepalive = tx;
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            if keepalive.send(Msg::KeepAlive).is_err() {
                break;
            }
        }
    });
    let first = match rx.recv().await {
        Some(Msg::Fail(status, message)) => return error(status, &message),
        Some(first) => first,
        None => return error(500, "Failed to retrieve telemetry from Roblox services."),
    };
    // Close the body right after the terminal event (not on the next message, e.g. a 15s keepalive).
    let frames = futures::stream::unfold(
        (Some(first), rx, false),
        |(pending, mut rx, finished)| async move {
            if finished {
                return None;
            }
            let msg = match pending {
                Some(msg) => msg,
                None => rx.recv().await?,
            };
            let terminal = matches!(msg, Msg::End | Msg::Fail(..));
            Some((
                Ok::<_, Error>(Frame::data(Bytes::from(sse_frame(&msg)))),
                (None, rx, terminal),
            ))
        },
    );
    Response::builder()
        .status(200)
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache, no-transform")
        .header("X-Accel-Buffering", "no")
        .body(ResponseBody::from(StreamBody::new(frames)))
        .unwrap()
}

async fn profile_json(query: &str, fresh: bool) -> Response<ResponseBody> {
    match profile::full_profile(query, fresh).await {
        Ok(profile) => {
            let telemetry = &profile["telemetry"];
            let cached = telemetry["cached"] == true;
            let cc = if cached {
                "public, max-age=10, stale-while-revalidate=30"
            } else {
                "public, max-age=30, stale-while-revalidate=60"
            };
            let headers = [
                (
                    "X-Cache",
                    if cached {
                        "HIT".to_string()
                    } else {
                        "MISS".to_string()
                    },
                ),
                (
                    "X-Response-Time",
                    format!("{}ms", telemetry["responseTimeMs"]),
                ),
                (
                    "X-Fingerprint",
                    telemetry["fingerprint"].as_str().unwrap_or("").to_string(),
                ),
                ("X-Egress-Shards", telemetry["egressShards"].to_string()),
                ("Vary", "Accept-Encoding".to_string()),
            ];
            let mut res = respond(200, profile, Some(cc));
            for (name, value) in headers {
                set_header(&mut res, name, &value);
            }
            res
        }
        Err(e) => {
            eprintln!(
                "[API Error] User resolution failed for \"{}\": {}",
                clean(query),
                clean(&e.message)
            );
            let (status, message) = profile_error(&e);
            error(status, &message)
        }
    }
}

// ── Routing ──
fn clean(s: &str) -> String {
    s.replace(['\r', '\n'], "_").chars().take(500).collect()
}

fn decode_segment(s: &str) -> String {
    percent_encoding::percent_decode_str(s)
        .decode_utf8_lossy()
        .into_owned()
}

async fn route(
    method: &str,
    segments: &[String],
    query: &HashMap<String, String>,
    ip: &str,
    accept: Option<&str>,
    req: Request,
    started: Instant,
) -> Response<ResponseBody> {
    let get = matches!(method, "GET" | "HEAD");
    let seg: Vec<&str> = segments.iter().map(String::as_str).collect();
    match seg.as_slice() {
        ["api", "health"] if get => health(),
        ["api", "users", "search"] if get => {
            let keyword = query.get("keyword").map(|k| k.trim()).unwrap_or("");
            if !(2..=20).contains(&keyword.chars().count()) {
                return respond(200, json!({ "users": [] }), None);
            }
            let Ok(result) =
                tokio::time::timeout(SEARCH_DEADLINE, profile::search_users(keyword)).await
            else {
                return respond(
                    503,
                    json!({ "users": [], "error": "User search is unavailable right now." }),
                    Some("no-store"),
                );
            };
            match result {
                Ok(users) => respond(200, json!({ "users": users }), None),
                Err(e) => {
                    eprintln!("[User Search] failed: {:?}", e.status);
                    let (status, message) = if e.status == Some(429) {
                        (429, "Roblox user search is rate limited.")
                    } else {
                        (502, "User search is unavailable right now.")
                    };
                    respond(status, json!({ "users": [], "error": message }), None)
                }
            }
        }
        ["api", "users", id, "outfits"] if get => {
            let token = query.get("pageToken").map(String::as_str).unwrap_or("");
            let Some(user_id) = parse_id(id).filter(|_| token.len() <= 1024) else {
                return error(400, "Invalid outfit request");
            };
            match outfits::saved_outfits(user_id, token).await {
                Ok(v) => respond(
                    200,
                    v,
                    Some("public, max-age=120, stale-while-revalidate=300"),
                ),
                Err(_) => error(502, "Saved outfits are unavailable right now"),
            }
        }
        ["api", "users", id, "creations"] if get => {
            let Some(user_id) = parse_id(id) else {
                return error(400, "Invalid user id");
            };
            let msg = "Creations are unavailable right now";
            let page = async {
                let q = store_query(query);
                feed_response(catalog::creator_store(catalog::Creator::User(user_id), &q).await, msg)
            };
            within(STORE_DEADLINE, msg, page).await
        }
        ["api", "users", id, feed @ ("experiences" | "assets" | "assets-summary")] if get => {
            let Some(user_id) = parse_id(id) else {
                return error(400, "Invalid user id");
            };
            let c = catalog::Creator::User(user_id);
            match *feed {
                "experiences" => experiences_route(c, query).await,
                "assets" => assets_route(c, query).await,
                _ => assets_summary_route(c).await,
            }
        }
        ["api", "outfits", id] if get => {
            let Some(outfit_id) = parse_id(id) else {
                return error(400, "Invalid outfit id");
            };
            match outfits::outfit_details(outfit_id).await {
                Ok(v) => respond(
                    200,
                    v,
                    Some("public, max-age=300, stale-while-revalidate=600"),
                ),
                // The archive needs "deleted" apart from "unavailable right now".
                Err(e) if e.status == Some(404) => respond(
                    404,
                    json!({ "error": "Outfit not found" }),
                    Some("public, max-age=600"),
                ),
                Err(_) => error(502, "Outfit details are unavailable right now"),
            }
        }
        ["api", "outfits", id, "archived"] if get => {
            let Some(outfit_id) = parse_id(id) else {
                return error(400, "Invalid outfit id");
            };
            match wayback::archived_outfit(outfit_id).await {
                Some(v) => respond(200, v, Some("public, max-age=86400")),
                None => respond(
                    503,
                    json!({ "error": "The Wayback Machine is unavailable right now" }),
                    Some("no-store"),
                ),
            }
        }
        ["api", "users", id, "archive"] if get => {
            let Some(user_id) = parse_id(id) else {
                return error(400, "Invalid user id");
            };
            match archive::live(user_id).await {
                Ok(v) => {
                    let cc = if v["complete"] == true {
                        "public, max-age=120, stale-while-revalidate=300"
                    } else {
                        "no-store"
                    };
                    respond(200, v, Some(cc))
                }
                Err(e) => upstream_error(&e, "Saved outfits are unavailable right now"),
            }
        }
        ["api", "users", id, "archive", "index"] if get => {
            let Some(user_id) = parse_id(id) else {
                return error(400, "Invalid user id");
            };
            let Some(kind) = query.get("kind").and_then(|k| wayback::Kind::parse(k)) else {
                return error(400, "Invalid archive kind");
            };
            // Archived outfit lists only for inventories Roblox shows publicly today.
            if kind == wayback::Kind::Outfits && archive::privacy(user_id).await != "public" {
                return respond(
                    200,
                    json!({ "snapshots": [], "complete": true, "private": true }),
                    Some("public, max-age=600"),
                );
            }
            let index = wayback::index(user_id, kind).await;
            // New Wayback captures of one player are rare; a day keeps slow prefix searches to one a day.
            let cc = if index["complete"] == true {
                "public, max-age=86400"
            } else {
                "no-store"
            };
            respond(200, index, Some(cc))
        }
        ["api", "archive", "snapshot"] if get => {
            let user_id = query.get("user").and_then(|u| parse_id(u));
            let kind = query.get("kind").and_then(|k| wayback::Kind::parse(k));
            let ts = query.get("ts").map(String::as_str).unwrap_or("");
            let url = query.get("url").map(String::as_str).unwrap_or("");
            let (Some(user_id), Some(kind)) = (user_id, kind) else {
                return error(400, "Invalid snapshot request");
            };
            if !(8..=14).contains(&ts.len())
                || !ts.bytes().all(|b| b.is_ascii_digit())
                || url.len() > 600
                || !wayback::allowed(kind, user_id, url)
            {
                return error(400, "Invalid snapshot request");
            }
            if kind == wayback::Kind::Outfits && archive::privacy(user_id).await != "public" {
                return error(403, "This player's outfits are private");
            }
            match wayback::snapshot(kind, ts, url).await {
                Some(v) => respond(200, v, Some("public, max-age=31536000, immutable")),
                None => respond(
                    503,
                    json!({ "error": "The Wayback Machine is unavailable right now" }),
                    Some("no-store"),
                ),
            }
        }
        ["api", "user", raw] if get => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return error(400, "Query parameter (username or userId) is required.");
            }
            if !valid_user_query(trimmed) {
                return error(
                    400,
                    "Invalid query: must be numeric userId (1..16 digits, no leading zero) or 3-20 char username (starts with letter, no __, no trailing _).",
                );
            }
            let fresh = query.get("fresh").map(String::as_str) == Some("true");
            if fresh && rate_limited(&format!("fresh:{ip}"), FRESH_MAX).is_some() {
                return error(429, "Fresh refresh limited to 5/min. Use cached data.");
            }
            let wants_stream = query.get("stream").map(String::as_str) == Some("true")
                || accept.is_some_and(|a| a.contains("text/event-stream"));
            if wants_stream {
                profile_stream(raw.to_string(), fresh).await
            } else {
                within(
                    PROFILE_DEADLINE,
                    "Roblox services temporarily unavailable, try again.",
                    profile_json(raw, fresh),
                )
                .await
            }
        }
        ["api", "asset-thumbnails"] if method == "POST" => {
            match Limited::new(req.into_body(), MAX_BODY).collect().await {
                Err(_) => error(413, "Request body too large"),
                Ok(bytes) => match serde_json::from_slice::<Value>(&bytes.to_bytes()) {
                    Ok(body) => thumbnails_route(&body, started).await,
                    Err(_) => error(400, "Invalid JSON body"),
                },
            }
        }
        ["api", "group", id, rest @ ..] if get && rest.len() <= 1 => {
            let Some(group_id) = parse_id(id) else {
                return error(400, "Invalid group id");
            };
            match rest {
                [] => match catalog::group_info(group_id).await {
                    Ok(Some(info)) => respond(
                        200,
                        info,
                        Some("public, max-age=60, stale-while-revalidate=120"),
                    ),
                    Ok(None) => error(404, "Group not found"),
                    Err(e) => upstream_error(&e, "Failed to fetch group"),
                },
                ["store"] => {
                    let page = async {
                        match catalog::group_store(group_id, &store_query(query)).await {
                            Ok(page) => respond(
                                200,
                                page,
                                Some("public, max-age=60, stale-while-revalidate=180"),
                            ),
                            Err(e) => upstream_error(&e, "Failed to fetch group store"),
                        }
                    };
                    within(STORE_DEADLINE, "Failed to fetch group store", page).await
                }
                ["store-summary"] => {
                    let msg = "Failed to count group store items";
                    within(STORE_DEADLINE, msg, async {
                        match catalog::store_summary(group_id).await {
                            Ok(v) => respond(200, v, Some("public, max-age=600, stale-while-revalidate=1200")),
                            Err(e) => upstream_error(&e, msg),
                        }
                    })
                    .await
                }
                ["store-status"] => {
                    let status = async {
                        match catalog::store_status(group_id).await {
                            Ok(has_items) => respond(
                                200,
                                json!({ "hasItems": has_items }),
                                Some("public, max-age=300, stale-while-revalidate=600"),
                            ),
                            Err(e) => upstream_error(&e, "Failed to check group store"),
                        }
                    };
                    within(STATUS_DEADLINE, "Failed to check group store", status).await
                }
                ["members"] => {
                    let cursor = query.get("cursor").map(String::as_str).unwrap_or("");
                    if !explore::valid_cursor(cursor) {
                        return error(400, "Invalid cursor");
                    }
                    let msg = "Group members are unavailable right now";
                    within(STORE_DEADLINE, msg, async {
                        feed_response(explore::members(group_id, cursor).await, msg)
                    })
                    .await
                }
                ["experiences"] => experiences_route(catalog::Creator::Group(group_id), query).await,
                ["assets"] => assets_route(catalog::Creator::Group(group_id), query).await,
                ["assets-summary"] => assets_summary_route(catalog::Creator::Group(group_id)).await,
                ["new-items"] => {
                    let limit = js_int(query.get("limit"), 3).clamp(1, 10) as usize;
                    match catalog::new_items(group_id, limit).await {
                        Ok(items) => respond(
                            200,
                            items,
                            Some("public, max-age=120, stale-while-revalidate=300"),
                        ),
                        // Same empty answer as before, but never cached so the next check retries.
                        Err(_) => respond(200, json!({ "items": [] }), Some("no-store")),
                    }
                }
                _ => error(404, "Not found"),
            }
        }
        _ => error(404, "Not found"),
    }
}

async fn experiences_route(c: catalog::Creator, query: &HashMap<String, String>) -> Response<ResponseBody> {
    let cursor = query.get("cursor").map(String::as_str).unwrap_or("");
    if !explore::valid_cursor(cursor) {
        return error(400, "Invalid cursor");
    }
    let msg = "Experiences are unavailable right now";
    within(STORE_DEADLINE, msg, async { feed_response(explore::experiences(c, cursor).await, msg) }).await
}

async fn assets_route(c: catalog::Creator, query: &HashMap<String, String>) -> Response<ResponseBody> {
    let cursor = query.get("cursor").map(String::as_str).unwrap_or("");
    let kind = query.get("type").and_then(|t| explore::AssetKind::parse(t));
    let Some(kind) = kind.filter(|_| explore::valid_cursor(cursor)) else {
        return error(400, "Invalid asset request");
    };
    let msg = "Creator assets are unavailable right now";
    within(STORE_DEADLINE, msg, async { feed_response(explore::assets(c, kind, cursor).await, msg) }).await
}

async fn assets_summary_route(c: catalog::Creator) -> Response<ResponseBody> {
    let msg = "Creator assets are unavailable right now";
    within(STORE_DEADLINE, msg, async {
        match explore::assets_summary(c).await {
            Ok(v) => respond(200, v, Some("public, max-age=600, stale-while-revalidate=1200")),
            Err(e) => upstream_error(&e, msg),
        }
    })
    .await
}

/// Answer within `limit`, or 503 with the endpoint's usual message (never cached) before the client gives up.
async fn within(
    limit: Duration,
    message: &str,
    work: impl Future<Output = Response<ResponseBody>>,
) -> Response<ResponseBody> {
    match tokio::time::timeout(limit, work).await {
        Ok(response) => response,
        Err(_) => {
            eprintln!("[deadline] gave up after {}s: {message}", limit.as_secs());
            respond(503, json!({ "error": message }), Some("no-store"))
        }
    }
}

async fn thumbnails_route(body: &Value, started: Instant) -> Response<ResponseBody> {
    let ids = thumbnail_ids(body);
    if ids.is_empty() {
        return error(400, "assetIds must contain valid asset IDs.");
    }
    let mut found: HashMap<u64, String> = HashMap::new();
    let mut missing = ids.clone();
    // Roblox may answer "Pending" first: retry only the missing ids so ready images show immediately.
    for attempt in 0..3u64 {
        if missing.is_empty() {
            break;
        }
        if attempt > 0 {
            // Return what is ready rather than retry past the client's 15s timeout.
            if started.elapsed() > THUMBS_RETRY_UNTIL {
                break;
            }
            tokio::time::sleep(Duration::from_millis(350 * attempt)).await;
        }
        found.extend(upstream::asset_thumbnails(&missing).await);
        missing.retain(|id| !found.contains_key(id));
    }
    let map: Map<String, Value> = found
        .into_iter()
        .map(|(id, url)| (id.to_string(), json!(url)))
        .collect();
    let cc = if missing.is_empty() {
        "public, max-age=300, stale-while-revalidate=1800"
    } else {
        "no-store"
    };
    respond(200, json!({ "thumbnails": map }), Some(cc))
}

/// Path segments of the original request. A Vercel rewrite may deliver `/api/main?__path=...`.
fn request_segments(path: &str, query: &HashMap<String, String>) -> Vec<String> {
    let path = match query.get("__path") {
        Some(original) if path.trim_end_matches('/') == "/api/main" => {
            format!("/api/{}", original.trim_start_matches('/'))
        }
        _ => path.to_string(),
    };
    path.trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .map(decode_segment)
        .collect()
}

pub async fn handle(req: Request) -> Response<ResponseBody> {
    let started = Instant::now();
    LazyLock::force(&STARTED);
    let method = req.method().as_str().to_string();
    let uri = req.uri().to_string();
    let query: HashMap<String, String> =
        url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes())
            .into_owned()
            .fold(HashMap::new(), |mut m, (k, v)| {
                m.entry(k).or_insert(v);
                m
            });
    let segments = request_segments(req.uri().path(), &query);
    let header = |name: &str| {
        req.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let origin = header("origin");
    let accept = header("accept");
    let ip = header("x-real-ip")
        .or_else(|| {
            header("x-forwarded-for")
                .and_then(|v| v.split(',').next().map(|s| s.trim().to_string()))
        })
        .unwrap_or_else(|| "global".into());
    let request_headers = header("access-control-request-headers");

    let origin_ok = is_allowed_origin(origin.as_deref(), header("host").as_deref());
    let mut response = if !origin_ok {
        error(403, "Origin not allowed")
    } else if method == "OPTIONS" {
        let mut res = Response::builder()
            .status(204)
            .header(
                "Access-Control-Allow-Methods",
                "GET,HEAD,PUT,PATCH,POST,DELETE",
            )
            .header("Content-Length", "0")
            .body(ResponseBody::from(""))
            .unwrap();
        if let Some(h) = &request_headers {
            set_header(&mut res, "Access-Control-Allow-Headers", h);
        }
        res
    } else if let Some(retry_ms) = if segments.get(1).map(String::as_str) == Some("archive") {
        rate_limited(&format!("archive:{ip}"), SNAPSHOT_MAX)
    } else {
        rate_limited(&ip, RATE_MAX)
    } {
        respond(
            429,
            json!({ "error": "Too many requests, please slow down.", "retryAfterMs": retry_ms }),
            None,
        )
    } else {
        route(
            &method,
            &segments,
            &query,
            &ip,
            accept.as_deref(),
            req,
            started,
        )
        .await
    };

    if let Some(origin) = origin.as_ref().filter(|_| origin_ok) {
        set_header(&mut response, "Access-Control-Allow-Origin", origin);
        set_header(&mut response, "Vary", "Origin");
    }
    println!(
        "[HTTP] {} {} -> {} ({}ms)",
        clean(&method),
        clean(&uri),
        response.status().as_u16(),
        started.elapsed().as_millis()
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_parsing_matches_express_handlers() {
        assert_eq!(js_int(None, 100), 100);
        assert_eq!(js_int(Some(&"120".into()), 100), 120);
        assert_eq!(js_int(Some(&"-5".into()), 100), -5);
        assert_eq!(js_int(Some(&"abc".into()), 3), 3);
        assert_eq!(js_int(Some(&"7x".into()), 3), 7);
        assert_eq!(
            store_query(&HashMap::from([("limit".into(), "500".into())])).limit,
            120
        );
        assert_eq!(parse_id("6589372"), Some(6589372));
        assert_eq!(parse_id("0"), None);
        assert_eq!(parse_id("12a"), None);
        assert_eq!(
            thumbnail_ids(&json!({ "assetIds": [5, "5", 7, -1, 0, 1.5, "x"] })),
            vec![5, 7]
        );
    }

    #[test]
    fn user_query_validation() {
        for ok in ["Roblox", "abc", "a_b_c", "1", "156", "9007199254740991"] {
            assert!(valid_user_query(ok), "{ok}");
        }
        for bad in [
            "ab",
            "1abc",
            "a__b",
            "abc_",
            "0123",
            "0",
            "abcdefghijklmnopqrstu",
            "a-b",
            "9007199254740992",
        ] {
            assert!(!valid_user_query(bad), "{bad}");
        }
    }

    // Ported from tests/origin.test.ts (production mode with an allow-list).
    #[test]
    fn origin_rules() {
        // SAFETY: test-only env mutation; no other test reads these variables concurrently.
        unsafe {
            std::env::set_var("VERCEL", "1");
            std::env::set_var("ALLOWED_ORIGINS", "https://partner.example");
        }
        assert!(
            is_allowed_origin(Some("http://127.0.0.1:5000"), Some("127.0.0.1:5000")),
            "same-origin POST"
        );
        assert!(is_allowed_origin(None, Some("a.app")), "no Origin header");
        assert!(
            is_allowed_origin(Some("https://partner.example"), Some("a.app")),
            "allow-listed"
        );
        assert!(
            !is_allowed_origin(Some("https://evil.example"), Some("a.app")),
            "other origin"
        );
        assert!(!is_allowed_origin(Some("not a url"), Some("a.app")));
    }

    #[test]
    fn rewritten_and_original_paths_route_the_same() {
        let empty = HashMap::new();
        assert_eq!(
            request_segments("/api/group/7/store", &empty),
            ["api", "group", "7", "store"]
        );
        let rewritten = HashMap::from([("__path".to_string(), "user/Some%20One".to_string())]);
        assert_eq!(
            request_segments("/api/main", &rewritten),
            ["api", "user", "Some One"]
        );
        assert_eq!(
            request_segments("/api/user/Bob%5F1", &empty),
            ["api", "user", "Bob_1"]
        );
    }

    #[test]
    fn upstream_429_becomes_client_429_with_bounded_retry_after() {
        let res = upstream_error(
            &upstream::UpErr {
                status: Some(429),
                retry_after_secs: Some(600),
            },
            "x",
        );
        assert_eq!(res.status().as_u16(), 429);
        assert_eq!(res.headers()["Retry-After"], "30");
        let res = upstream_error(
            &upstream::UpErr {
                status: Some(429),
                retry_after_secs: None,
            },
            "x",
        );
        assert_eq!(res.headers()["Retry-After"], "2");
        assert_eq!(res.headers()["Cache-Control"], "no-store");
        let res = upstream_error(&upstream::UpErr::network(), "Failed to fetch group");
        assert_eq!(
            (res.status().as_u16(), res.headers().get("Retry-After")),
            (502, None)
        );
    }

    // An empty or bad creator id must never reach Roblox: catalog search then returns everyone's items.
    // Every creator route gates on parse_id (route() itself needs a hyper body, so it is checked live).
    #[test]
    fn creator_id_validation() {
        for bad in ["", "0", "abc", "12345678901234567", "-5", "9007199254740992"] {
            assert_eq!(parse_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn iso_timestamps() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_794_642_003_690), "2026-11-14T07:40:03.690Z");
        assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn sse_frames() {
        assert_eq!(
            sse_frame(&Msg::Event("user", json!({ "a": 1 }))),
            "event: user\ndata: {\"a\":1}\n\n"
        );
        assert_eq!(sse_frame(&Msg::End), "event: end\ndata: {\"ok\":true}\n\n");
        assert_eq!(
            sse_frame(&Msg::Fail(429, "x".into())),
            "event: error\ndata: {\"error\":\"x\",\"status\":429}\n\n"
        );
    }
}
