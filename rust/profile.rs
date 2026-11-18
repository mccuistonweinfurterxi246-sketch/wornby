//! Player profile pipeline (user, equipped outfit with valuation, avatar thumbnails, groups) and user search.
//! Mirrors RobloxService.getFullProfile / streamFullProfile / searchUsers in the Node backend.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::future::{BoxFuture, Shared, join_all};
use futures::{FutureExt, StreamExt};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc::UnboundedSender;

use crate::catalog::{
    ARCHIVED_PREFIX, DETAIL_CONCURRENCY, Lookup, Parsed, asset_type_name, lookup_item, lua_command,
    parse_catalog_item, text,
};
use crate::upstream::{
    EGRESS_COUNT, Ttl, UpErr, asset_thumbnails, client, client_for, get_hedged, get_official,
    hedge, mirror, post_once, retry_once,
};

const USER_TIMEOUT: Duration = Duration::from_secs(6);
const AVATAR_TIMEOUT: Duration = Duration::from_secs(7);

static PROFILES: LazyLock<Ttl<Value>> = LazyLock::new(|| Ttl::new(60, 250));
static UNKNOWN_USERNAMES: LazyLock<Ttl<bool>> = LazyLock::new(|| Ttl::new(15, 500));
static ITEM_DETAILS: LazyLock<Ttl<Parsed>> = LazyLock::new(|| Ttl::new(5 * 60, 4000));
static GROUP_ICONS: LazyLock<Ttl<String>> = LazyLock::new(|| Ttl::new(10 * 60, 2000));
static USER_SEARCH: LazyLock<Ttl<Value>> = LazyLock::new(|| Ttl::new(60, 500));

type SharedProfile = Shared<BoxFuture<'static, Result<Value, ProfileErr>>>;
static PENDING: LazyLock<Mutex<HashMap<String, SharedProfile>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone)]
pub struct ProfileErr {
    pub status: Option<u16>,
    pub message: String,
}

impl ProfileErr {
    fn upstream(e: &UpErr) -> Self {
        let message = match e.status {
            Some(s) => format!("Request failed with status code {s}"),
            None => "Network error talking to Roblox".to_string(),
        };
        Self {
            status: e.status,
            message,
        }
    }
    fn message(message: String) -> Self {
        Self {
            status: None,
            message,
        }
    }
}

/// HTTP status and message the client shows (profileError in server/index.ts).
pub fn profile_error(e: &ProfileErr) -> (u16, String) {
    let lower = e.message.to_lowercase();
    if e.status == Some(404) || lower.contains("not found") || lower.contains("does not exist") {
        return (
            404,
            if e.status == Some(404) {
                "User not found.".to_string()
            } else {
                e.message.clone()
            },
        );
    }
    if e.status == Some(429) || lower.contains("too many requests") || lower.contains("429") {
        return (
            429,
            "Roblox API rate limited, try again shortly.".to_string(),
        );
    }
    if matches!(e.status, Some(502 | 503)) {
        return (
            503,
            "Roblox services temporarily unavailable, try again.".to_string(),
        );
    }
    (
        500,
        "Failed to retrieve telemetry from Roblox services.".to_string(),
    )
}

// ── Streaming events ──
pub enum Msg {
    Event(&'static str, Value),
    KeepAlive,
    End,
    Fail(u16, String),
}

#[derive(Default)]
struct Valuation {
    value: i64,
    priced: u64,
    free: u64,
    off: u64,
    seen: HashSet<u64>,
}

/// Event sink of the SSE path; the JSON path runs the same pipeline without one.
pub struct Sink {
    tx: UnboundedSender<Msg>,
    valuation: Mutex<Valuation>,
}

impl Sink {
    pub fn new(tx: UnboundedSender<Msg>) -> Self {
        Self {
            tx,
            valuation: Mutex::new(Valuation::default()),
        }
    }
    pub fn send(&self, event: &'static str, data: Value) {
        let _ = self.tx.send(Msg::Event(event, data));
    }
    pub fn finish(&self, msg: Msg) {
        let _ = self.tx.send(msg);
    }
    /// Running valuation + item preview as each item's details arrive (onChunk in Node).
    fn item(&self, id: u64, d: &Parsed, total: usize) {
        let summary = {
            let mut v = self.valuation.lock().unwrap();
            if !v.seen.insert(id) {
                return;
            }
            let (price, is_free) = resolved_price(d);
            if price.is_some_and(|p| p > 0) {
                v.value += price.unwrap_or(0);
                v.priced += 1;
            } else if is_free {
                v.free += 1;
            } else {
                v.off += 1;
            }
            json!({ "totalValueRobux": v.value, "pricedCount": v.priced, "freeCount": v.free, "offSaleCount": v.off, "seen": v.seen.len(), "total": total })
        };
        self.send("valuation", summary);
        self.send("chunk", json!({ "items": [{ "id": id, "name": d.name, "price": d.price.or(d.lowest_price), "isFree": d.is_free }] }));
    }
}

/// Price after the resale rule: an item without (or with a zero) price that has resellers is valued at the resale price.
pub(crate) fn resolved_price(d: &Parsed) -> (Option<i64>, bool) {
    let has_resale = d.resale.is_some_and(|p| p > 0);
    match d.price {
        Some(0) if has_resale => (d.resale, false),
        None if has_resale => (d.resale, false),
        price => (price, d.is_free || price == Some(0)),
    }
}

// ── Roblox lookups ──
/// Resolved user: the base record, plus the detail record when it was already fetched (numeric ids).
pub struct ResolvedUser {
    pub id: u64,
    base: Value,
    detail: Option<Value>,
}

impl ResolvedUser {
    /// Description, join date and ban state come from the detail endpoint; the profile still works without them.
    async fn complete(&self) -> Value {
        match &self.detail {
            Some(detail) => user_object(&self.base, detail),
            None => {
                let detail = get_official(
                    client(),
                    &format!("https://users.roblox.com/v1/users/{}", self.id),
                    USER_TIMEOUT,
                )
                .await
                .unwrap_or(Value::Null);
                user_object(&self.base, &detail)
            }
        }
    }
}

pub async fn resolve_user(query: &str) -> Result<ResolvedUser, ProfileErr> {
    let trimmed = query.trim();
    if trimmed.bytes().all(|b| b.is_ascii_digit()) && !trimmed.is_empty() {
        let data = get_official(
            client(),
            &format!("https://users.roblox.com/v1/users/{trimmed}"),
            USER_TIMEOUT,
        )
        .await
        .map_err(|e| ProfileErr::upstream(&e))?;
        let id = data["id"].as_u64().unwrap_or(0);
        return Ok(ResolvedUser {
            id,
            base: data.clone(),
            detail: Some(data),
        });
    }
    let neg_key = trimmed.to_lowercase();
    if UNKNOWN_USERNAMES.get(&neg_key).is_some() {
        return Err(ProfileErr::message(format!(
            "User \"{trimmed}\" was not found."
        )));
    }
    let url = "https://users.roblox.com/v1/usernames/users";
    let body = json!({ "usernames": [trimmed], "excludeBannedUsers": false });
    let mirrored = mirror(url);
    let found = retry_once(|| {
        hedge(post_once(client(), url, &body, USER_TIMEOUT), || {
            post_once(client(), &mirrored, &body, USER_TIMEOUT)
        })
    })
    .await
    .map_err(|e| {
        if e.status == Some(429) {
            ProfileErr::message("Too many requests — Roblox throttled username lookup".to_string())
        } else {
            ProfileErr::message(format!(
                "Failed to resolve username \"{trimmed}\": {}",
                ProfileErr::upstream(&e).message
            ))
        }
    })?;
    let Some(raw) = found["data"].as_array().and_then(|a| a.first()).cloned() else {
        UNKNOWN_USERNAMES.set(neg_key, true);
        return Err(ProfileErr::message(format!(
            "User \"{trimmed}\" was not found."
        )));
    };
    let id = raw["id"].as_u64().unwrap_or(0);
    // No id: nothing to look up, the base record is all there is.
    let detail = (id == 0).then_some(Value::Null);
    Ok(ResolvedUser {
        id,
        base: raw,
        detail,
    })
}

fn user_object(base: &Value, detail: &Value) -> Value {
    let mut user = Map::new();
    user.insert("id".into(), base["id"].clone());
    user.insert("name".into(), base["name"].clone());
    let display = text(&base["displayName"])
        .map(|s| json!(s))
        .unwrap_or_else(|| base["name"].clone());
    user.insert("displayName".into(), display);
    user.insert(
        "hasVerifiedBadge".into(),
        json!(base["hasVerifiedBadge"] == true),
    );
    user.insert(
        "description".into(),
        json!(text(&detail["description"]).unwrap_or("")),
    );
    if let Some(created) = detail.get("created") {
        user.insert("created".into(), created.clone());
    }
    user.insert("isBanned".into(), json!(detail["isBanned"] == true));
    Value::Object(user)
}

#[derive(Debug, Clone, PartialEq)]
pub struct BaseAsset {
    pub id: u64,
    pub name: Option<String>,
    pub asset_type: Option<i64>,
    pub asset_type_name: Option<String>,
}

/// Union of currently-wearing ids and avatar assets (names and types), in Node's insertion order.
pub fn merge_equipped(wearing: Option<&Value>, avatar: Option<&Value>) -> Vec<BaseAsset> {
    let mut assets: Vec<BaseAsset> = Vec::new();
    let mut index: HashMap<u64, usize> = HashMap::new();
    for id in wearing
        .and_then(|w| w["assetIds"].as_array())
        .into_iter()
        .flatten()
        .filter_map(json_id)
    {
        if let std::collections::hash_map::Entry::Vacant(slot) = index.entry(id) {
            slot.insert(assets.len());
            assets.push(BaseAsset {
                id,
                name: None,
                asset_type: None,
                asset_type_name: None,
            });
        }
    }
    for item in avatar
        .and_then(|a| a["assets"].as_array())
        .into_iter()
        .flatten()
    {
        let Some(id) = json_id(&item["id"]) else {
            continue;
        };
        let slot = *index.entry(id).or_insert_with(|| {
            assets.push(BaseAsset {
                id,
                name: None,
                asset_type: None,
                asset_type_name: None,
            });
            assets.len() - 1
        });
        let existing = &mut assets[slot];
        if let Some(name) = text(&item["name"]) {
            existing.name = Some(name.to_string());
        }
        let type_id = item["assetType"]["id"].as_i64().filter(|&t| t != 0);
        if type_id.is_some() {
            existing.asset_type = type_id;
        }
        if let Some(type_name) = text(&item["assetType"]["name"]) {
            existing.asset_type_name = Some(type_name.to_string());
        } else if let Some(t) = type_id {
            existing.asset_type_name = asset_type_name(t).map(str::to_string);
        }
    }
    assets
}

/// Number(x) > 0 for ids that arrive as numbers or numeric strings.
fn json_id(v: &Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|&id| id > 0)
}

async fn equipped_assets(user_id: u64) -> Vec<BaseAsset> {
    let wearing_url = format!("https://avatar.roblox.com/v1/users/{user_id}/currently-wearing");
    let avatar_url = format!("https://avatar.roblox.com/v1/users/{user_id}/avatar");
    let (wearing, avatar) = tokio::join!(
        get_official(client(), &wearing_url, AVATAR_TIMEOUT),
        get_official(client(), &avatar_url, AVATAR_TIMEOUT)
    );
    merge_equipped(wearing.as_ref().ok(), avatar.as_ref().ok())
}

async fn avatar_thumbnails(user_id: u64) -> Value {
    let base = "https://thumbnails.roblox.com/v1/users";
    let full_url =
        format!("{base}/avatar?userIds={user_id}&size=420x420&format=Webp&isCircular=false");
    let head_url = format!(
        "{base}/avatar-headshot?userIds={user_id}&size=150x150&format=Webp&isCircular=false"
    );
    let (full, head) = tokio::join!(
        get_official(client(), &full_url, AVATAR_TIMEOUT),
        get_official(client(), &head_url, AVATAR_TIMEOUT)
    );
    let first_url = |r: &Result<Value, UpErr>| {
        r.as_ref()
            .ok()
            .and_then(|v| text(&v["data"][0]["imageUrl"]).map(str::to_string))
    };
    json!({ "fullBodyUrl": first_url(&full), "headshotUrl": first_url(&head) })
}

/// A player's public groups (with icons); Err when Roblox did not answer, so callers can tell "none" apart.
pub(crate) async fn user_groups_checked(user_id: u64) -> Result<Vec<Value>, UpErr> {
    let data = get_official(
        client(),
        &format!("https://groups.roblox.com/v2/users/{user_id}/groups/roles"),
        AVATAR_TIMEOUT,
    )
    .await?;
    let Some(raw) = data["data"].as_array() else {
        return Ok(Vec::new());
    };
    let ids: Vec<u64> = raw
        .iter()
        .filter_map(|g| g["group"]["id"].as_u64())
        .collect();
    let mut icons: HashMap<u64, String> = HashMap::new();
    let mut missing = Vec::new();
    for &id in &ids {
        match GROUP_ICONS.get(&id.to_string()) {
            Some(url) => {
                icons.insert(id, url);
            }
            None => missing.push(id),
        }
    }
    let requests = missing.chunks(50).map(|chunk| async move {
        let list = chunk
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let url = format!(
            "https://thumbnails.roblox.com/v1/groups/icons?groupIds={list}&size=150x150&format=Webp"
        );
        get_official(client_for(chunk[0]), &url, AVATAR_TIMEOUT).await
    });
    for data in join_all(requests).await.into_iter().flatten() {
        for item in data["data"].as_array().into_iter().flatten() {
            if let (Some(id), Some(url)) = (item["targetId"].as_u64(), text(&item["imageUrl"])) {
                GROUP_ICONS.set(id.to_string(), url.to_string());
                icons.insert(id, url.to_string());
            }
        }
    }
    Ok(raw.iter()
        .map(|item| {
            let group = &item["group"];
            let id = group["id"].as_u64().unwrap_or(0);
            json!({
                "id": group["id"],
                "name": group["name"],
                "memberCount": group["memberCount"].as_u64().unwrap_or(0),
                "hasVerifiedBadge": group["hasVerifiedBadge"] == true,
                "roleName": item["role"]["name"],
                "roleRank": item["role"]["rank"],
                "iconUrl": icons.get(&id),
            })
        })
        .collect())
}

/// Details for one equipped asset (catalog item, then economy; economy 404 = deleted).
async fn asset_details(id: u64) -> Option<Parsed> {
    let key = id.to_string();
    if let Some(hit) = ITEM_DETAILS.get(&key) {
        return Some(hit);
    }
    match lookup_item(id, 1).await {
        Lookup::Found(item) => {
            let parsed = parse_catalog_item(&item, 1);
            ITEM_DETAILS.set(key, parsed.clone());
            Some(parsed)
        }
        // Deleted markers are not cached, like Node (it always re-checked them).
        Lookup::Deleted => Some(Parsed::deleted(id)),
        Lookup::Missing => None,
    }
}

async fn catalog_details(ids: &[u64], sink: Option<&Sink>) -> HashMap<u64, Parsed> {
    let total = ids.len();
    let mut found = HashMap::new();
    let mut lookups = futures::stream::iter(ids.to_vec())
        .map(|id| async move { (id, asset_details(id).await) })
        .buffer_unordered(DETAIL_CONCURRENCY);
    while let Some((id, details)) = lookups.next().await {
        if let Some(d) = details {
            if let Some(sink) = sink {
                sink.item(id, &d, total);
            }
            found.insert(id, d);
        }
    }
    found
}

/// FNV-1a over the sorted asset ids (computeFingerprint in Node).
pub fn fingerprint(ids: &[u64]) -> String {
    if ids.is_empty() {
        return "empty".to_string();
    }
    let mut sorted = ids.to_vec();
    sorted.sort_unstable();
    let joined = sorted
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let mut h: u32 = 2166136261;
    for b in joined.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(16777619);
    }
    format!("{h:08x}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One outfit item with pricing rules (assembleProfile in Node).
fn profile_item(
    base: &BaseAsset,
    cd: Option<&Parsed>,
    thumbnail: Option<&String>,
) -> (Value, Option<i64>, bool) {
    let id = base.id;
    let raw_name = cd
        .map(|d| d.name.clone())
        .filter(|n| !n.is_empty())
        .or_else(|| base.name.clone());
    let archived = raw_name
        .as_deref()
        .is_some_and(|n| n.starts_with(ARCHIVED_PREFIX));
    let name = if archived {
        Some(format!("Asset #{id}"))
    } else {
        raw_name
    };
    let deleted = cd.is_some_and(|d| d.is_deleted);
    let has_resale = cd.and_then(|d| d.resale).is_some_and(|p| p > 0);
    let (price, is_free) = match cd {
        Some(d) => resolved_price(d),
        None => (None, false),
    };
    let cd_for_sale = cd.is_some_and(|d| d.is_for_sale);
    let status = cd
        .and_then(|d| d.price_status.clone())
        .filter(|s| !s.is_empty());
    let is_for_sale = !deleted
        && (is_free
            || price.is_some_and(|p| p > 0)
            || (has_resale && (cd_for_sale || status.as_deref() == Some("Resale")))
            || cd_for_sale);
    let is_off_sale = !is_for_sale && !is_free;
    let price_status = match status {
        None if is_free => "Free".to_string(),
        None if is_off_sale => "OffSale".to_string(),
        None => "Resale".to_string(),
        Some(s) if has_resale && s == "OffSale" => "Resale".to_string(),
        Some(s) => s,
    };
    let type_name = cd
        .map(|d| d.asset_type_name.clone())
        .filter(|s| !s.is_empty())
        .or_else(|| base.asset_type_name.clone())
        .or_else(|| match base.asset_type {
            Some(t) => asset_type_name(t).map(str::to_string),
            None => Some("Wearable Asset".to_string()),
        });

    let mut item = Map::new();
    item.insert("id".into(), json!(id));
    item.insert(
        "name".into(),
        json!(name.unwrap_or_else(|| format!("Asset #{id}"))),
    );
    item.insert(
        "description".into(),
        json!(
            cd.map(|d| d.description.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("Equipped on avatar.")
        ),
    );
    if let Some(t) = cd
        .and_then(|d| d.asset_type)
        .filter(|&t| t != 0)
        .or(base.asset_type)
    {
        item.insert("assetType".into(), json!(t));
    }
    if let Some(t) = type_name {
        item.insert("assetTypeName".into(), json!(t));
    }
    item.insert(
        "creatorName".into(),
        json!(
            cd.map(|d| d.creator_name.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("Roblox UGC Creator")
        ),
    );
    for (key, value) in [
        ("creatorId", cd.map(|d| &d.creator_id)),
        ("creatorType", cd.map(|d| &d.creator_type)),
    ] {
        if let Some(v) = value.filter(|v| !v.is_null()) {
            item.insert(key.into(), v.clone());
        }
    }
    item.insert("price".into(), json!(price));
    item.insert("priceStatus".into(), json!(price_status));
    item.insert("lowestPrice".into(), json!(cd.and_then(|d| d.lowest_price)));
    item.insert("isForSale".into(), json!(is_for_sale));
    item.insert("isOffSale".into(), json!(is_off_sale));
    item.insert("isDeletedOrModerated".into(), json!(deleted));
    item.insert("isFree".into(), json!(is_free));
    item.insert(
        "itemRestrictions".into(),
        cd.map(|d| d.item_restrictions.clone()).unwrap_or(json!([])),
    );
    item.insert("thumbnailUrl".into(), json!(thumbnail));
    item.insert("studioLuaCommand".into(), json!(lua_command(id)));
    item.insert(
        "catalogUrl".into(),
        json!(format!("https://www.roblox.com/catalog/{id}")),
    );
    (Value::Object(item), price, is_free)
}

#[allow(clippy::too_many_arguments)] // mirrors assembleProfile's inputs one to one
pub fn assemble_profile(
    user: Value,
    thumbnails: Value,
    groups: Option<Vec<Value>>,
    equipped: &[BaseAsset],
    details: &HashMap<u64, Parsed>,
    thumbs: &HashMap<u64, String>,
    fp: &str,
    started: Instant,
) -> Value {
    let (mut total, mut off, mut free, mut priced) = (0i64, 0u64, 0u64, 0u64);
    let items: Vec<Value> = equipped
        .iter()
        .map(|base| {
            let (item, price, is_free) =
                profile_item(base, details.get(&base.id), thumbs.get(&base.id));
            match price {
                Some(p) if p > 0 => {
                    total += p;
                    priced += 1;
                }
                _ if is_free => free += 1,
                _ => off += 1,
            }
            item
        })
        .collect();
    let count = items.len();
    let mut out = json!({
        "user": user,
        "thumbnails": thumbnails,
        "outfit": {
            "totalValueRobux": total,
            "hasOffSaleItems": off > 0,
            "offSaleCount": off,
            "freeCount": free,
            "pricedCount": priced,
            "itemCount": count,
            "items": items,
        },
        "groups": groups.as_deref().unwrap_or_default(),
        "telemetry": {
            "cached": false,
            "timestamp": now_ms(),
            "responseTimeMs": started.elapsed().as_millis() as u64,
            "wearingAssetCount": count,
            "fingerprint": fp,
            "egressShards": *EGRESS_COUNT,
        },
    });
    if groups.is_none() {
        out["groupsUnavailable"] = json!(true);
    }
    out
}

fn cached_profile(key: &str, started: Instant) -> Option<Value> {
    let mut hit = PROFILES.get(key)?;
    // Never serve a cached "deleted" verdict: re-check those items (as Node did).
    let has_deleted = hit["outfit"]["items"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|i| i["isDeletedOrModerated"] == true);
    if has_deleted {
        PROFILES.remove(key);
        return None;
    }
    hit["telemetry"]["cached"] = json!(true);
    hit["telemetry"]["responseTimeMs"] = json!(started.elapsed().as_millis() as u64);
    Some(hit)
}

fn cache_profile(key: &str, profile: &Value) {
    PROFILES.set(key.to_string(), profile.clone());
    if let Some(name) = profile["user"]["name"].as_str().map(str::to_lowercase)
        && name != key
    {
        PROFILES.set(name, profile.clone());
    }
    if let Some(id) = profile["user"]["id"].as_u64().map(|id| id.to_string())
        && id != key
    {
        PROFILES.set(id, profile.clone());
    }
}

async fn load_profile(
    query: String,
    started: Instant,
    sink: Option<Arc<Sink>>,
) -> Result<Value, ProfileErr> {
    let sink = sink.as_deref();
    let resolved = resolve_user(&query).await?;
    let user_id = resolved.id;
    // The user detail lookup runs alongside the outfit/thumbnail/group calls instead of before them.
    let (user, (equipped, thumbnails, groups)) = tokio::join!(
        async {
            let user = resolved.complete().await;
            if let Some(s) = sink {
                s.send("user", json!({ "user": user }));
            }
            user
        },
        async {
            tokio::join!(
                equipped_assets(user_id),
                avatar_thumbnails(user_id),
                async { user_groups_checked(user_id).await.ok() }
            )
        }
    );
    let ids: Vec<u64> = equipped.iter().map(|a| a.id).collect();
    let fp = fingerprint(&ids);
    if let Some(s) = sink {
        s.send("equipped", json!({ "count": ids.len(), "assetIds": ids }));
        s.send("thumbnails", thumbnails.clone());
        s.send("groups", json!({ "count": groups.as_ref().map_or(0, Vec::len) }));
        s.send(
            "fingerprint",
            json!({ "fingerprint": fp, "egressShards": *EGRESS_COUNT }),
        );
    }
    let (thumbs, details) = tokio::join!(
        async {
            let thumbs = asset_thumbnails(&ids).await;
            if let Some(s) = sink {
                s.send("assetThumbnails", json!({ "count": thumbs.len() }));
            }
            thumbs
        },
        catalog_details(&ids, sink),
    );
    let profile = assemble_profile(
        user, thumbnails, groups, &equipped, &details, &thumbs, &fp, started,
    );
    // A profile missing its groups is not cached: the next load retries them.
    if profile.get("groupsUnavailable").is_none() {
        cache_profile(&query.trim().to_lowercase(), &profile);
    }
    Ok(profile)
}

/// JSON path: cache, then one shared pipeline for identical concurrent requests.
pub async fn full_profile(query: &str, fresh: bool) -> Result<Value, ProfileErr> {
    let started = Instant::now();
    if fresh {
        return load_profile(query.to_string(), started, None).await;
    }
    let key = query.trim().to_lowercase();
    if let Some(hit) = cached_profile(&key, started) {
        return Ok(hit);
    }
    let shared = {
        let mut pending = PENDING.lock().unwrap();
        pending
            .entry(key.clone())
            .or_insert_with(|| {
                let (query, key) = (query.to_string(), key.clone());
                async move {
                    let result = load_profile(query, started, None).await;
                    PENDING.lock().unwrap().remove(&key);
                    result
                }
                .boxed()
                .shared()
            })
            .clone()
    };
    // If every waiter leaves, the shared future is dropped and the Roblox work stops (as Node aborted it).
    let result = shared.await;
    if result.is_err() {
        PENDING.lock().unwrap().remove(&key);
    }
    result
}

/// SSE path: same pipeline, emitting progress events (streamFullProfile in Node).
pub async fn stream_profile(query: &str, fresh: bool, sink: Arc<Sink>) -> Result<(), ProfileErr> {
    let started = Instant::now();
    let key = query.trim().to_lowercase();
    if !fresh && let Some(hit) = cached_profile(&key, started) {
        sink.send("user", json!({ "user": hit["user"] }));
        sink.send("done", hit);
        return Ok(());
    }
    let profile = load_profile(query.to_string(), started, Some(sink.clone())).await?;
    sink.send("done", profile);
    Ok(())
}

// ── User search (typeahead) ──
pub async fn search_users(keyword: &str) -> Result<Value, UpErr> {
    let key = keyword.trim().to_lowercase();
    if let Some(hit) = USER_SEARCH.get(&key) {
        return Ok(hit);
    }
    let mut url = url::Url::parse("https://users.roblox.com/v1/users/search").unwrap();
    // Roblox only accepts 10, 25, 50 or 100 here.
    url.query_pairs_mut()
        .append_pair("keyword", keyword.trim())
        .append_pair("limit", "10")
        .append_pair("sortOrder", "Asc");
    // No retry: suggestions are typed live, a stale retry only competes with the next keystroke.
    let data = get_hedged(
        client(),
        [url.as_str(), &mirror(url.as_str())],
        Duration::from_secs(6),
    )
    .await?;
    let users: Vec<Value> = data["data"]
        .as_array()
        .map(|a| a.iter().take(8).cloned().collect())
        .unwrap_or_default();
    let ids: Vec<u64> = users
        .iter()
        .filter_map(|u| u["id"].as_u64())
        .filter(|&id| id > 0)
        .collect();
    let mut headshots: HashMap<u64, String> = HashMap::new();
    if !ids.is_empty() {
        let list = ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        let thumbs_url = format!(
            "https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds={list}&size=150x150&format=Webp&isCircular=false"
        );
        // Suggestions are still useful when the thumbnail service is unavailable.
        if let Ok(thumbs) = get_official(client(), &thumbs_url, Duration::from_secs(7)).await {
            for t in thumbs["data"].as_array().into_iter().flatten() {
                if let (Some(id), Some(url)) = (t["targetId"].as_u64(), text(&t["imageUrl"])) {
                    headshots.insert(id, url.to_string());
                }
            }
        }
    }
    let results: Vec<Value> = users
        .iter()
        .map(|u| {
            let id = u["id"].as_u64().unwrap_or(0);
            json!({
                "id": id,
                "name": u["name"],
                "displayName": text(&u["displayName"]).map(|s| json!(s)).unwrap_or_else(|| u["name"].clone()),
                "hasVerifiedBadge": u["hasVerifiedBadge"] == true,
                "headshotUrl": headshots.get(&id),
            })
        })
        .collect();
    let value = json!(results);
    USER_SEARCH.set(key, value.clone());
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(raw: Value) -> Parsed {
        parse_catalog_item(&raw, 1)
    }

    #[test]
    fn fingerprint_matches_node_fnv1a() {
        // Values computed with computeFingerprint() from server/robloxService.ts.
        assert_eq!(fingerprint(&[]), "empty");
        assert_eq!(fingerprint(&[3, 1, 2]), fingerprint(&[1, 2, 3]));
        assert_eq!(fingerprint(&[1, 2, 3]), "21cdd3d7");
        assert_eq!(fingerprint(&[607702162, 301811432, 2510230574]), "3306ac36");
    }

    #[test]
    fn valuation_rules() {
        let base = |id| BaseAsset {
            id,
            name: None,
            asset_type: Some(8),
            asset_type_name: Some("Hat".into()),
        };
        let on_sale = parsed(
            json!({ "id": 1, "assetType": 8, "name": "Hat", "price": 80, "lowestPrice": 80, "lowestResalePrice": 0 }),
        );
        let off_sale = parsed(
            json!({ "id": 2, "assetType": 8, "name": "Old", "price": 5, "lowestPrice": 5, "lowestResalePrice": 0, "priceStatus": "Off Sale", "isOffSale": true }),
        );
        let limited = parsed(
            json!({ "id": 3, "assetType": 8, "name": "Ltd", "price": null, "lowestPrice": 482, "lowestResalePrice": 482, "priceStatus": "Off Sale", "isOffSale": true }),
        );
        let free = parsed(
            json!({ "id": 4, "assetType": 8, "name": "Free", "price": 0, "priceStatus": "Free" }),
        );
        let details: HashMap<u64, Parsed> = [
            (1, on_sale),
            (2, off_sale),
            (3, limited),
            (4, free),
            (5, Parsed::deleted(5)),
        ]
        .into_iter()
        .collect();
        let equipped: Vec<BaseAsset> = (1..=6).map(base).collect();
        let p = assemble_profile(
            json!({}),
            json!({}),
            Some(vec![]),
            &equipped,
            &details,
            &HashMap::new(),
            "fp",
            Instant::now(),
        );
        let outfit = &p["outfit"];
        assert_eq!(outfit["totalValueRobux"], 80 + 482);
        assert_eq!(
            (
                outfit["pricedCount"].clone(),
                outfit["freeCount"].clone(),
                outfit["offSaleCount"].clone()
            ),
            (json!(2), json!(1), json!(3))
        );
        let items = outfit["items"].as_array().unwrap();
        assert_eq!(
            (
                items[0]["priceStatus"].clone(),
                items[0]["isForSale"].clone()
            ),
            (json!("Resale"), json!(true))
        ); // Node's label for plain on-sale items
        assert_eq!(
            (items[1]["price"].clone(), items[1]["isOffSale"].clone()),
            (Value::Null, json!(true))
        );
        assert_eq!(
            (
                items[2]["price"].clone(),
                items[2]["priceStatus"].clone(),
                items[2]["isForSale"].clone()
            ),
            (json!(482), json!("Resale"), json!(true))
        );
        assert_eq!(
            (items[3]["isFree"].clone(), items[3]["price"].clone()),
            (json!(true), json!(0))
        );
        assert_eq!(
            (
                items[4]["name"].clone(),
                items[4]["isDeletedOrModerated"].clone()
            ),
            (json!("Asset #5"), json!(true))
        );
        // No details at all: avatar name/type fallbacks, off sale, no creator fields.
        assert_eq!(
            (items[5]["name"].clone(), items[5]["description"].clone()),
            (json!("Asset #6"), json!("Equipped on avatar."))
        );
        assert!(items[5].get("creatorId").is_none());
        assert_eq!(items[5]["assetTypeName"], "Hat");
    }

    #[test]
    fn equipped_merge_keeps_order_and_avatar_names() {
        let wearing = json!({ "assetIds": [10, 11, "12", 0] });
        let avatar = json!({ "assets": [
            { "id": 11, "name": "Cap", "assetType": { "id": 8, "name": "Hat" } },
            { "id": 13, "name": "Face", "assetType": { "id": 18 } },
        ] });
        let merged = merge_equipped(Some(&wearing), Some(&avatar));
        assert_eq!(
            merged.iter().map(|a| a.id).collect::<Vec<_>>(),
            vec![10, 11, 12, 13]
        );
        assert_eq!(merged[1].name.as_deref(), Some("Cap"));
        assert_eq!(merged[3].asset_type_name.as_deref(), Some("Face"));
        assert!(merge_equipped(None, None).is_empty());
    }

    #[test]
    fn error_mapping_matches_express() {
        let e = |status, msg: &str| {
            profile_error(&ProfileErr {
                status,
                message: msg.into(),
            })
        };
        assert_eq!(e(Some(404), "x"), (404, "User not found.".into()));
        assert_eq!(
            e(None, "User \"abc\" was not found."),
            (404, "User \"abc\" was not found.".into())
        );
        assert_eq!(
            e(None, "Too many requests — Roblox throttled username lookup").0,
            429
        );
        assert_eq!(e(Some(503), "x").0, 503);
        assert_eq!(e(None, "boom").0, 500);
    }

    #[tokio::test]
    async fn cached_profile_answers_by_name_and_id() {
        // Seeded cache entry: both callers resolve from it without touching Roblox.
        let profile = json!({ "user": { "id": 77, "name": "Shared" }, "outfit": { "items": [] }, "telemetry": { "cached": false } });
        cache_profile("shared", &profile);
        let (a, b) = tokio::join!(full_profile("Shared", false), full_profile("77", false));
        assert_eq!(a.unwrap()["telemetry"]["cached"], true);
        assert_eq!(b.unwrap()["user"]["id"], 77);
    }

    // A failed groups call must not look like "no groups" (the network would drop verified memberships).
    #[test]
    fn unavailable_groups_are_flagged() {
        let p = assemble_profile(json!({}), json!({}), None, &[], &HashMap::new(), &HashMap::new(), "fp", Instant::now());
        assert_eq!(p["groups"], json!([]));
        assert_eq!(p["groupsUnavailable"], true);
        let p = assemble_profile(json!({}), json!({}), Some(vec![]), &[], &HashMap::new(), &HashMap::new(), "fp", Instant::now());
        assert_eq!(p.get("groupsUnavailable"), None);
    }

}
