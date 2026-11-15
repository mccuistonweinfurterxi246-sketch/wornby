//! Catalog data: item normalisation (parseCatalogItem rules), group store, group info,
//! store status and new items.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use futures::StreamExt;
use futures::future::join_all;

use crate::upstream::{
    Ttl, UpErr, asset_thumbnails, bundle_thumbnails, client_for, get_hedged, get_official, get_resilient, mirror,
};

pub const CATALOG_TIMEOUT: Duration = Duration::from_secs(5);
const GROUP_TIMEOUT: Duration = Duration::from_secs(5);
// catalog v1/search/items/details only accepts these page sizes (Node sent 100 and always got a 400).
const DETAIL_LIMITS: [u32; 3] = [10, 28, 30];
// Stop chaining catalog calls for one store page after this long.
const CHAIN_BUDGET: Duration = Duration::from_secs(6);
pub const ARCHIVED_PREFIX: &str = "__ARCHIVED__:";
const DETAIL_TIMEOUT: Duration = Duration::from_secs(6);
// Parallel per-item lookups (one wave for a typical outfit); the roproxy mirror handled bursts of 15.
pub const DETAIL_CONCURRENCY: usize = 16;

static GROUP_INFO: LazyLock<Ttl<Value>> = LazyLock::new(|| Ttl::new(30 * 60, 2000));
static STORE_PAGES: LazyLock<Ttl<Value>> = LazyLock::new(|| Ttl::new(5 * 60, 300));
static STORE_STATUS: LazyLock<Ttl<bool>> = LazyLock::new(|| Ttl::new(10 * 60, 2000));
static STORE_SUMMARY: LazyLock<Ttl<Value>> = LazyLock::new(|| Ttl::new(10 * 60, 1000));
// Counting stops at 10 id pages (1,200 items) per section; the answer then says "more".
const SUMMARY_MAX_PAGES: usize = 10;

// ── Item normalisation ──
pub fn asset_type_name(id: i64) -> Option<&'static str> {
    Some(match id {
        2 => "T-Shirt",
        8 => "Hat",
        11 => "Shirt",
        12 => "Pants",
        17 => "Head",
        18 => "Face",
        19 => "Gear",
        27 => "Torso",
        28 => "Right Arm",
        29 => "Left Arm",
        30 => "Left Leg",
        31 => "Right Leg",
        41 => "Hair Accessory",
        42 => "Face Accessory",
        43 => "Neck Accessory",
        44 => "Shoulder Accessory",
        45 => "Front Accessory",
        46 => "Back Accessory",
        47 => "Waist Accessory",
        48 => "Climb Animation",
        49 => "Death Animation",
        50 => "Fall Animation",
        51 => "Idle Animation",
        52 => "Jump Animation",
        53 => "Run Animation",
        54 => "Swim Animation",
        55 => "Walk Animation",
        56 => "Pose Animation",
        61 => "Emote Animation",
        64 => "T-Shirt Accessory",
        65 => "Shirt Accessory",
        66 => "Pants Accessory",
        67 => "Jacket Accessory",
        68 => "Sweater Accessory",
        69 => "Shorts Accessory",
        70 => "Left Shoe Accessory",
        71 => "Right Shoe Accessory",
        72 => "Dress Skirt Accessory",
        76 => "Eyebrow Accessory",
        77 => "Eyelash Accessory",
        78 => "Mood Animation",
        79 => "Dynamic Head",
        88 => "Face Makeup",
        89 => "Lip Makeup",
        90 => "Eye Makeup",
        92 => "Avatar Background",
        _ => return None,
    })
}

pub fn type_label(id: i64) -> String {
    asset_type_name(id)
        .map(str::to_string)
        .unwrap_or_else(|| format!("Type {id}"))
}

/// JS truthiness for strings: missing, null and "" are all falsy.
pub fn text(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}

fn is_off_sale_status(s: &str) -> bool {
    s == "Off Sale" || s == "OffSale"
}

/// Normalised catalog data for one item (parseCatalogItem in the Node backend), or a deleted marker.
#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub name: String,
    pub description: String,
    pub asset_type: Option<i64>,
    pub asset_type_name: String,
    pub creator_name: String,
    pub creator_id: Value,
    pub creator_type: Value,
    pub price: Option<i64>,
    pub price_status: Option<String>,
    /// Reported lowest price (equals the normal price for ordinary items); passed through to clients.
    pub lowest_price: Option<i64>,
    /// Real reseller price, the only value that counts as resale.
    pub resale: Option<i64>,
    pub is_for_sale: bool,
    pub is_off_sale: bool,
    pub is_free: bool,
    pub is_deleted: bool,
    pub item_restrictions: Value,
    pub is_bundle: bool,
    /// For a bundle: its one wearable Dynamic Head asset (the id that works in Roblox), if it has one.
    pub bundle_head: Option<u64>,
}

impl Parsed {
    /// Asset that no longer exists (economy 404), shown as archived.
    pub fn deleted(id: u64) -> Self {
        Self {
            name: format!("{ARCHIVED_PREFIX}{id}"),
            description: String::new(),
            asset_type: None,
            asset_type_name: String::new(),
            creator_name: String::new(),
            creator_id: Value::Null,
            creator_type: Value::Null,
            price: None,
            price_status: None,
            lowest_price: None,
            resale: None,
            is_for_sale: false,
            is_off_sale: true,
            is_free: false,
            is_deleted: true,
            item_restrictions: json!([]),
            is_bundle: false,
            bundle_head: None,
        }
    }
}

pub fn parse_catalog_item(item: &Value, item_type: u8) -> Parsed {
    let id = &item["id"];
    let fallback = if item_type == 2 {
        "Avatar Bundle / Pack"
    } else {
        "Accessory / Wearable"
    };
    let raw_price = item["price"].as_i64();
    // JS `a ?? b ?? null`: null/undefined fall through, 0 does not.
    let lowest = item["lowestPrice"]
        .as_i64()
        .or_else(|| item["lowestResalePrice"].as_i64());
    // Only a real reseller price counts as resale. Node used `lowestPrice` here, which marked
    // off-sale clothing (price 5, lowestPrice 5, lowestResalePrice 0) as "Resale" and for sale.
    let resale = item["lowestResalePrice"].as_i64().filter(|&p| p > 0);
    let status = text(&item["priceStatus"]).unwrap_or("");
    let has_resale = resale.is_some();
    let marked_off = (is_off_sale_status(status) || item["isOffSale"] == true) && !has_resale;
    // Price 0 means free only while the item is on sale; off-sale items keep price 0 on Roblox.
    let is_free = status == "Free" || (raw_price == Some(0) && !has_resale && !marked_off);
    let effective = if is_free {
        Some(0)
    } else if raw_price.is_some_and(|p| p > 0) {
        raw_price
    } else if has_resale {
        resale
    } else {
        raw_price
    };
    let price_one = effective.is_some_and(|p| p <= 1) && !is_free && !has_resale;
    let explicit_off = marked_off || price_one;
    let is_for_sale = !explicit_off && (is_free || effective.is_some_and(|p| p > 1));
    let is_off_sale = explicit_off || (!is_for_sale && !is_free);
    let normalized = if has_resale && is_off_sale_status(status) {
        "Resale"
    } else if is_off_sale {
        "Off Sale"
    } else {
        status
    };
    let price_status = if normalized.is_empty() {
        item["priceStatus"].as_str().map(str::to_string)
    } else {
        Some(normalized.to_string())
    };
    let asset_type = item["assetType"].as_i64();
    let asset_type_name = match (item_type, asset_type) {
        (2, _) => fallback.to_string(),
        (_, Some(t)) if t != 0 => type_label(t),
        _ => fallback.to_string(),
    };
    Parsed {
        name: text(&item["name"])
            .map(str::to_string)
            .unwrap_or_else(|| format!("{fallback} #{id}")),
        description: text(&item["description"]).unwrap_or("").to_string(),
        asset_type,
        asset_type_name,
        creator_name: text(&item["creatorName"])
            .unwrap_or("Roblox User / UGC")
            .to_string(),
        creator_id: item["creatorTargetId"].clone(),
        creator_type: item["creatorType"].clone(),
        price: if is_off_sale { None } else { effective },
        price_status,
        lowest_price: lowest,
        resale,
        is_for_sale,
        is_off_sale,
        is_free,
        is_deleted: false,
        item_restrictions: if item["itemRestrictions"].is_array() {
            item["itemRestrictions"].clone()
        } else {
            json!([])
        },
        is_bundle: item_type == 2,
        bundle_head: bundle_head(item),
    }
}

/// The single Dynamic Head asset (type 79) inside a bundle; None for bundles without exactly one.
fn bundle_head(item: &Value) -> Option<u64> {
    let mut heads = item["bundledItems"]
        .as_array()?
        .iter()
        .filter(|b| b["type"] == "Asset" && b["assetType"] == 79)
        .filter_map(|b| b["id"].as_u64());
    let head = heads.next()?;
    heads.next().is_none().then_some(head)
}

/// Economy v2 asset details reshaped into a catalog entry, so one rule set (parse_catalog_item) applies.
/// None when the answer has no name (Node treated that as "no data").
pub fn economy_as_catalog(id: u64, data: &Value) -> Option<Value> {
    let name = text(&data["Name"])?;
    let public_domain = data["IsPublicDomain"] == true;
    let for_sale = data["IsForSale"] == true;
    let status = if public_domain {
        "Free"
    } else if !for_sale {
        "Off Sale"
    } else {
        ""
    };
    let creator = &data["Creator"];
    // CreatorTargetId is the user/group id; Creator.Id is an internal id for groups (Node returned that).
    let creator_id = if creator["CreatorTargetId"].is_null() {
        creator["Id"].clone()
    } else {
        creator["CreatorTargetId"].clone()
    };
    Some(json!({
        "id": id,
        "itemType": "Asset",
        "assetType": data["AssetTypeId"],
        "name": name,
        "description": data["Description"],
        "creatorName": creator["Name"],
        "creatorTargetId": creator_id,
        "creatorType": creator["CreatorType"],
        "price": data["PriceInRobux"],
        "lowestPrice": data["PriceInRobux"],
        "lowestResalePrice": data["CollectiblesItemDetails"]["CollectibleLowestResalePrice"],
        "priceStatus": status,
        "isOffSale": !for_sale && !public_domain,
    }))
}

pub enum Lookup {
    /// Catalog-shaped entry (straight from the catalog, or economy reshaped by economy_as_catalog).
    Found(Value),
    /// Economy answered 404: the asset no longer exists.
    Deleted,
    /// No data (throttled, timed out, or unknown to every source).
    Missing,
}

/// Details for one item: catalog item endpoint (mirror first), then economy for assets.
/// Only a real 404 means deleted; timeouts and throttling must not mark items as deleted.
pub async fn lookup_item(id: u64, item_type: u8) -> Lookup {
    let kind = if item_type == 2 { "Bundle" } else { "Asset" };
    let catalog =
        format!("https://catalog.roblox.com/v1/catalog/items/{id}/details?itemType={kind}");
    let pool = client_for(id);
    if let Ok(item) = get_hedged(pool, [&mirror(&catalog), &catalog], DETAIL_TIMEOUT).await
        && text(&item["name"]).is_some()
    {
        return Lookup::Found(item);
    }
    if item_type == 2 {
        return Lookup::Missing;
    }
    let economy = format!("https://economy.roblox.com/v2/assets/{id}/details");
    match get_resilient(pool, [&mirror(&economy), &economy], DETAIL_TIMEOUT).await {
        Ok(data) => economy_as_catalog(id, &data).map_or(Lookup::Missing, Lookup::Found),
        Err(e) if e.status == Some(404) => Lookup::Deleted,
        Err(_) => Lookup::Missing,
    }
}

/// One store grid item (the getGroupStore merge on top of parseCatalogItem).
pub fn store_item(
    id: u64,
    d: Option<&Parsed>,
    group_name: &str,
    creator: Creator,
    thumbnail: Option<&String>,
) -> Value {
    let group_id = creator.id();
    let name = d
        .map(|d| d.name.as_str())
        .filter(|n| !n.is_empty() && !n.starts_with(ARCHIVED_PREFIX))
        .map(str::to_string)
        .unwrap_or_else(|| format!("Item #{id}"));
    let raw_price = d.and_then(|d| d.price);
    let status = d.and_then(|d| d.price_status.clone()).unwrap_or_default();
    let is_free = raw_price == Some(0) || status == "Free" || d.is_some_and(|d| d.is_free);
    let price_one = raw_price.is_some_and(|p| p <= 1) && !is_free;
    let explicit_off = is_off_sale_status(&status)
        || d.is_some_and(|d| d.is_off_sale)
        || price_one
        || (raw_price.is_none() && !is_free);
    let is_for_sale = !explicit_off && (is_free || raw_price.is_some_and(|p| p > 1));
    let is_off_sale = explicit_off || (!is_for_sale && !is_free);
    let asset_type = d.and_then(|d| d.asset_type).filter(|&t| t > 0);
    let type_name = match (d, asset_type) {
        (Some(d), _) if !d.asset_type_name.is_empty() => d.asset_type_name.clone(),
        (_, Some(t)) => type_label(t),
        _ => "Wearable".to_string(),
    };
    let creator_id = d
        .map(|d| d.creator_id.clone())
        .filter(|v| v.as_u64().is_some_and(|n| n > 0) || text(v).is_some())
        .unwrap_or(json!(group_id));

    let mut item = Map::new();
    item.insert("id".into(), json!(id));
    item.insert("name".into(), json!(name));
    item.insert(
        "description".into(),
        json!(d.map(|d| d.description.as_str()).unwrap_or("")),
    );
    item.insert(
        "price".into(),
        json!(if is_off_sale {
            None
        } else if is_free {
            Some(0)
        } else {
            raw_price
        }),
    );
    let lowest = if is_off_sale {
        None
    } else {
        d.and_then(|d| d.lowest_price).or(raw_price)
    };
    item.insert("lowestPrice".into(), json!(lowest));
    item.insert(
        "priceStatus".into(),
        json!(if is_off_sale {
            "Off Sale".to_string()
        } else {
            status
        }),
    );
    item.insert("isForSale".into(), json!(is_for_sale));
    item.insert("isOffSale".into(), json!(is_off_sale));
    item.insert("isFree".into(), json!(is_free));
    item.insert(
        "isDeletedOrModerated".into(),
        json!(d.is_some_and(|d| d.is_deleted)),
    );
    item.insert(
        "creatorName".into(),
        json!(
            d.map(|d| d.creator_name.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(group_name)
        ),
    );
    item.insert("creatorId".into(), creator_id);
    item.insert("creatorType".into(), json!(creator.type_name()));
    if let Some(t) = asset_type {
        item.insert("assetType".into(), json!(t));
    }
    item.insert("assetTypeName".into(), json!(type_name));
    item.insert(
        "itemRestrictions".into(),
        d.map(|d| d.item_restrictions.clone()).unwrap_or(json!([])),
    );
    item.insert("thumbnailUrl".into(), json!(thumbnail));
    // A bundle id is not an asset id (Roblox 404s it on /catalog/ and in LoadAsset): bundles link to
    // /bundles/ and copy their wearable head asset.
    let is_bundle = d.is_some_and(|d| d.is_bundle);
    let wear = if is_bundle { d.and_then(|d| d.bundle_head) } else { Some(id) };
    item.insert("wearAssetId".into(), json!(wear));
    item.insert("studioLuaCommand".into(), json!(wear.map(lua_command).unwrap_or_default()));
    item.insert(
        "catalogUrl".into(),
        json!(if is_bundle {
            format!("https://www.roblox.com/bundles/{id}")
        } else {
            format!("https://www.roblox.com/catalog/{id}")
        }),
    );
    Value::Object(item)
}

pub fn lua_command(id: u64) -> String {
    format!("game:GetService(\"InsertService\"):LoadAsset({id}).Parent = workspace")
}

// ── Group info ──
pub async fn group_info(group_id: u64) -> Result<Option<Value>, UpErr> {
    let key = group_id.to_string();
    if let Some(hit) = GROUP_INFO.get(&key) {
        return Ok(Some(hit));
    }
    let data = match get_official(
        client_for(group_id),
        &format!("https://groups.roblox.com/v1/groups/{group_id}"),
        GROUP_TIMEOUT,
    )
    .await
    {
        Ok(data) => data,
        Err(e) if e.is_final() => return Ok(None),
        Err(e) => return Err(e),
    };
    if data.get("id").and_then(Value::as_u64).is_none() {
        return Ok(None);
    }
    let mut out = Map::new();
    out.insert("id".into(), data["id"].clone());
    if let Some(name) = data.get("name") {
        out.insert("name".into(), name.clone());
    }
    out.insert(
        "memberCount".into(),
        data.get("memberCount")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!(0)),
    );
    for field in ["description", "owner", "created", "updated"] {
        if let Some(v) = data.get(field) {
            out.insert(field.into(), v.clone());
        }
    }
    let info = Value::Object(out);
    GROUP_INFO.set(key, info.clone());
    Ok(Some(info))
}

// ── Creator store (group store, user creations) ──
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Creator {
    User(u64),
    Group(u64),
}

impl Creator {
    pub fn id(&self) -> u64 {
        match *self {
            Creator::User(id) | Creator::Group(id) => id,
        }
    }
    /// Roblox catalog creatorType code.
    pub fn type_code(&self) -> &'static str {
        match self {
            Creator::User(_) => "1",
            Creator::Group(_) => "2",
        }
    }
    fn type_name(&self) -> &'static str {
        match self {
            Creator::User(_) => "User",
            Creator::Group(_) => "Group",
        }
    }
}

/// Drops rows that name a different creator (search must never leak other creators' items).
/// Id-only fallback rows carry no creator fields and are kept: they came from the filtered search.
pub fn own_rows(rows: Vec<Value>, c: Creator) -> Vec<Value> {
    rows.into_iter()
        .filter(|r| match (r["creatorType"].as_str(), r["creatorTargetId"].as_u64()) {
            (Some(t), Some(id)) => t == c.type_name() && id == c.id(),
            _ => true,
        })
        .collect()
}

pub struct StoreQuery {
    pub cursor: String,
    pub limit: u32,
    pub sort_type: &'static str,
    pub sort_order: &'static str,
    pub thumbnails: bool,
    /// One store section; None = the whole catalog (store status, new items, player creations).
    pub section: Option<Section>,
}

impl StoreQuery {
    fn category(&self) -> &'static str {
        self.section.map_or("All", |s| s.category())
    }
}

/// Store sections, each asked of Roblox as its own catalog category and verified row by row.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Section {
    Clothing,
    Accessories,
    Heads,
    Animations,
}

pub const SECTIONS: [Section; 4] = [Section::Clothing, Section::Accessories, Section::Heads, Section::Animations];

impl Section {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "clothing" => Self::Clothing,
            "accessories" => Self::Accessories,
            "heads" => Self::Heads,
            "animations" => Self::Animations,
            _ => None?,
        })
    }
    pub fn key(&self) -> &'static str {
        match self {
            Self::Clothing => "clothing",
            Self::Accessories => "accessories",
            Self::Heads => "heads",
            Self::Animations => "animations",
        }
    }
    /// Roblox catalog category id (names are unreliable: an unknown one silently means "All").
    pub fn category(&self) -> &'static str {
        match self {
            Self::Clothing => "3",
            Self::Accessories => "11",
            Self::Heads => "18",
            Self::Animations => "12",
        }
    }
    /// Does this catalog row belong here? Rows without type info (id-only fallback) pass.
    pub fn accepts(&self, row: &Value) -> bool {
        let bundle = row["itemType"] == "Bundle";
        let t = if bundle { row["bundleType"].as_i64() } else { row["assetType"].as_i64() };
        let Some(t) = t else { return true };
        match (self, bundle) {
            (Self::Clothing, false) => matches!(t, 2 | 11 | 12 | 64..=72),
            (Self::Clothing, true) => t == 3,
            (Self::Accessories, false) => matches!(t, 8 | 41..=47 | 57 | 58),
            // Counted from bundle types alone, so the section is exactly its Dynamic Head bundles.
            (Self::Heads, false) => false,
            (Self::Heads, true) => t == 4,
            (Self::Animations, false) => matches!(t, 48..=56 | 61 | 78),
            (Self::Animations, true) => t == 2,
            (Self::Accessories, true) => false,
        }
    }
}

/// Catalog search URL on the roproxy mirror (the anonymous official catalog is throttled hard, so the mirror goes first).
fn search_url(
    path: &str,
    creator: Creator,
    limit: u32,
    cursor: &str,
    sort_type: &str,
    sort_order: &str,
    category: &str,
) -> url::Url {
    let mut url =
        url::Url::parse(&format!("https://catalog.roproxy.com/v1/search/{path}")).unwrap();
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("category", category)
            .append_pair("creatorTargetId", &creator.id().to_string())
            .append_pair("creatorType", creator.type_code())
            .append_pair("limit", &limit.to_string());
        if !cursor.is_empty() {
            qp.append_pair("cursor", cursor);
        }
        qp.append_pair("sortType", sort_type)
            .append_pair("sortOrder", sort_order)
            .append_pair("includeNotForSale", "true");
    }
    url
}

async fn catalog_search(url: &url::Url, group_id: u64) -> Result<Value, UpErr> {
    let official = url
        .as_str()
        .replacen("catalog.roproxy.com", "catalog.roblox.com", 1);
    get_resilient(
        client_for(group_id),
        [url.as_str(), &official],
        CATALOG_TIMEOUT,
    )
    .await
}

pub async fn group_store(group_id: u64, q: &StoreQuery) -> Result<Value, UpErr> {
    creator_store(Creator::Group(group_id), q).await.map(|(page, _)| page)
}

/// One page of a creator's catalog items, `({ items, nextPageCursor }, complete)`; a short or
/// placeholder page is not complete (callers must not cache it).
pub async fn creator_store(creator: Creator, q: &StoreQuery) -> Result<(Value, bool), UpErr> {
    let group_id = creator.id();
    let cache_key = format!(
        "{}:{}:{group_id}:{}:{}:{}:{}:{}",
        creator.type_code(),
        q.category(),
        q.cursor,
        q.limit,
        q.sort_type,
        q.sort_order,
        if q.thumbnails { "full" } else { "fast" }
    );
    if let Some(hit) = STORE_PAGES.get(&cache_key) {
        return Ok((hit, true));
    }
    let per_call = DETAIL_LIMITS
        .into_iter()
        .find(|&l| l >= q.limit)
        .unwrap_or(30);
    // First page: a single call so the grid paints fast (the store modal auto-loads the rest);
    // later pages chain details-search calls up to the requested size.
    let calls = if q.cursor.is_empty() {
        1
    } else {
        q.limit.div_ceil(per_call).max(1)
    };
    let mut raw: Vec<Value> = Vec::new();
    let mut cursor = q.cursor.clone();
    let mut next = Value::Null;
    let mut complete = true;
    let started = Instant::now();
    for call in 0..calls {
        // Slow upstream: return the shorter page now (`next` already points at the following page).
        if call > 0 && started.elapsed() > CHAIN_BUDGET {
            complete = false;
            break;
        }
        match store_page(creator, per_call, &cursor, q).await {
            Ok(page) => {
                raw.extend(page["data"].as_array().cloned().unwrap_or_default());
                match page["nextPageCursor"].as_str().filter(|c| !c.is_empty()) {
                    Some(c) => {
                        cursor = c.to_string();
                        next = json!(c);
                    }
                    None => {
                        next = Value::Null;
                        break;
                    }
                }
            }
            // Keep what already loaded: the client resumes from the failed page's cursor.
            Err(_) if call > 0 => {
                next = json!(cursor);
                complete = false;
                break;
            }
            Err(e) => return Err(e),
        }
    }
    let raw: Vec<Value> = own_rows(raw, creator)
        .into_iter()
        .filter(|r| q.section.is_none_or(|s| s.accepts(r)))
        .collect();
    let refs: Vec<(u64, u8, &Value)> = raw
        .iter()
        .filter_map(|it| {
            let id = it["id"]
                .as_u64()
                .or_else(|| it["itemId"].as_u64())
                .filter(|&id| id > 0)?;
            Some((id, if it["itemType"] == "Bundle" { 2 } else { 1 }, it))
        })
        .collect();
    if refs.is_empty() {
        return Ok((json!({ "items": [], "nextPageCursor": next }), complete));
    }
    let thumbs = if q.thumbnails {
        let ids_of = |t: u8| refs.iter().filter(|r| r.1 == t).map(|r| r.0).collect::<Vec<_>>();
        let (asset_ids, bundle_ids) = (ids_of(1), ids_of(2));
        let (mut assets, bundles) =
            tokio::join!(asset_thumbnails(&asset_ids), bundle_thumbnails(&bundle_ids));
        assets.extend(bundles);
        assets
    } else {
        HashMap::new()
    };
    let details: Vec<Option<Parsed>> = refs
        .iter()
        .map(|&(id, t, it)| {
            if it[DELETED_KEY] == true {
                Some(Parsed::deleted(id))
            } else {
                text(&it["name"]).map(|_| parse_catalog_item(it, t))
            }
        })
        .collect();
    // The group name is only a label for items without details (possible on the fallback path).
    let missing = details.iter().any(Option::is_none);
    complete &= !missing;
    let group_name = match (missing, creator) {
        (true, Creator::User(_)) => Some(format!("User #{group_id}")),
        (true, Creator::Group(_)) => group_info(group_id)
            .await
            .ok()
            .flatten()
            .and_then(|i| i["name"].as_str().map(str::to_string)),
        (false, _) => None,
    }
    .unwrap_or_else(|| format!("Group #{group_id}"));
    let items: Vec<Value> = refs
        .iter()
        .zip(&details)
        .map(|(&(id, _, _), d)| store_item(id, d.as_ref(), &group_name, creator, thumbs.get(&id)))
        .collect();
    let result = json!({ "items": items, "nextPageCursor": next });
    if complete {
        STORE_PAGES.set(cache_key, result.clone());
    }
    Ok((result, complete))
}

// Marks an item the fallback path found deleted (economy 404) inside the raw page data.
const DELETED_KEY: &str = "__deleted";

/// One page of store items with details. The details-search GET carries everything in one call
/// (the batched details POST allows ~1 call/30s per IP). When it is throttled, the id-only search
/// (same page, same cursors) plus parallel per-item lookups keeps the store loading.
async fn store_page(
    creator: Creator,
    per_call: u32,
    cursor: &str,
    q: &StoreQuery,
) -> Result<Value, UpErr> {
    let group_id = creator.id();
    let details_url = search_url(
        "items/details",
        creator,
        per_call,
        cursor,
        q.sort_type,
        q.sort_order,
        q.category(),
    );
    match catalog_search(&details_url, group_id).await {
        Err(e) if !e.is_final() => {
            eprintln!(
                "[store] details search unavailable for creator {group_id}, using per-item lookups"
            );
            let ids_url = search_url(
                "items",
                creator,
                per_call,
                cursor,
                q.sort_type,
                q.sort_order,
                q.category(),
            );
            let page = catalog_search(&ids_url, group_id).await?;
            let refs: Vec<(u64, u8)> = page["data"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|it| {
                    let id = it["id"]
                        .as_u64()
                        .or_else(|| it["itemId"].as_u64())
                        .filter(|&id| id > 0)?;
                    Some((id, if it["itemType"] == "Bundle" { 2 } else { 1 }))
                })
                .collect();
            let mut found: HashMap<u64, Value> = futures::stream::iter(refs.clone())
                .map(|(id, t)| async move { (id, lookup_item(id, t).await) })
                .buffer_unordered(DETAIL_CONCURRENCY)
                .filter_map(|(id, lookup)| async move {
                    match lookup {
                        Lookup::Found(item) => Some((id, item)),
                        Lookup::Deleted => Some((id, json!({ "id": id, DELETED_KEY: true }))),
                        Lookup::Missing => None,
                    }
                })
                .collect()
                .await;
            let data: Vec<Value> = refs
                .iter()
                .map(|&(id, t)| {
                    found.remove(&id).unwrap_or_else(
                        || json!({ "id": id, "itemType": if t == 2 { "Bundle" } else { "Asset" } }),
                    )
                })
                .collect();
            Ok(json!({ "data": data, "nextPageCursor": page["nextPageCursor"] }))
        }
        other => other,
    }
}

/// Dynamic Head bundles made by `c` in a batch bundle-details answer.
pub fn count_heads(details: &Value, c: Creator) -> u64 {
    details
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| {
            b["bundleType"] == "DynamicHead"
                && b["creator"]["id"].as_u64() == Some(c.id())
                && b["creator"]["type"] == c.type_name()
        })
        .count() as u64
}

/// Ids in one section (id-only search, 120 a page, flagged bundle or not) and whether the cap cut it.
async fn section_ids(c: Creator, s: Section) -> Result<(Vec<(u64, bool)>, bool), UpErr> {
    let mut ids = Vec::new();
    let mut cursor = String::new();
    for _ in 0..SUMMARY_MAX_PAGES {
        let url = search_url("items", c, 120, &cursor, "RecentlyCreated", "Desc", s.category());
        let page = catalog_search(&url, c.id()).await?;
        for it in page["data"].as_array().into_iter().flatten() {
            if let Some(id) = it["id"].as_u64().filter(|&id| id > 0) {
                ids.push((id, it["itemType"] == "Bundle"));
            }
        }
        match page["nextPageCursor"].as_str().filter(|c| !c.is_empty()) {
            Some(next) => cursor = next.to_string(),
            None => return Ok((ids, false)),
        }
    }
    Ok((ids, true))
}

/// Exact item count of one section. Heads: category 18 also holds body bundles and hair, so its
/// bundles are typed through batch bundle details (100 per call, in parallel).
async fn section_count(c: Creator, s: Section) -> Result<(u64, bool), UpErr> {
    let (ids, more) = section_ids(c, s).await?;
    if s != Section::Heads {
        return Ok((ids.len() as u64, more));
    }
    let bundles: Vec<u64> = ids.iter().filter(|r| r.1).map(|r| r.0).collect();
    let calls = bundles.chunks(100).map(|chunk| async move {
        let list = chunk.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        get_official(
            client_for(chunk[0]),
            &format!("https://catalog.roblox.com/v1/bundles/details?bundleIds={list}"),
            CATALOG_TIMEOUT,
        )
        .await
    });
    let mut count = 0;
    for details in join_all(calls).await {
        count += count_heads(&details?, c);
    }
    Ok((count, more))
}

/// Item counts per store section: `{ clothing: { count, more }, accessories, heads, animations }`.
pub async fn store_summary(group_id: u64) -> Result<Value, UpErr> {
    let key = group_id.to_string();
    if let Some(hit) = STORE_SUMMARY.get(&key) {
        return Ok(hit);
    }
    let c = Creator::Group(group_id);
    let (clothing, accessories, heads, animations) = tokio::join!(
        section_count(c, Section::Clothing),
        section_count(c, Section::Accessories),
        section_count(c, Section::Heads),
        section_count(c, Section::Animations),
    );
    let mut out = Map::new();
    for (s, result) in SECTIONS.iter().zip([clothing, accessories, heads, animations]) {
        let (count, more) = result?;
        out.insert(s.key().into(), json!({ "count": count, "more": more }));
    }
    let summary = Value::Object(out);
    STORE_SUMMARY.set(key, summary.clone());
    Ok(summary)
}

/// Does the group sell anything? (cheap id-only search, 10 items)
pub async fn store_status(group_id: u64) -> Result<bool, UpErr> {
    let key = group_id.to_string();
    if let Some(hit) = STORE_STATUS.get(&key) {
        return Ok(hit);
    }
    let page = catalog_search(
        &search_url("items", Creator::Group(group_id), 10, "", "RecentlyCreated", "Desc", "All"),
        group_id,
    )
    .await?;
    let has_items = page["data"].as_array().into_iter().flatten().any(|it| {
        it["id"]
            .as_u64()
            .or_else(|| it["itemId"].as_u64())
            .is_some_and(|id| id > 0)
    });
    STORE_STATUS.set(key, has_items);
    Ok(has_items)
}

/// Most recent group items for the saved-groups folder. Node asked for limit=5, which the catalog rejects
/// (allowed: 10, 28, 30…), so it always returned no items; this asks for 10 and trims.
pub async fn new_items(group_id: u64, limit: usize) -> Result<Value, UpErr> {
    let url = search_url("items/details", Creator::Group(group_id), 10, "", "RecentlyCreated", "Desc", "All");
    let page = catalog_search(&url, group_id).await?;
    let items: Vec<Value> = page["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|it| {
            let id = it["id"]
                .as_u64()
                .or_else(|| it["itemId"].as_u64())
                .filter(|&id| id > 0)?;
            let parsed = parse_catalog_item(it, if it["itemType"] == "Bundle" { 2 } else { 1 });
            // Same shape as Node: price is the listed price (0 when free) even when off sale, as economy reported it.
            let price = if parsed.is_free {
                Some(0)
            } else {
                it["price"].as_i64()
            };
            let mut item = Map::new();
            item.insert("id".into(), json!(id));
            item.insert(
                "name".into(),
                json!(
                    text(&it["name"])
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("Item #{id}"))
                ),
            );
            item.insert("price".into(), json!(price));
            item.insert("isForSale".into(), json!(parsed.is_for_sale));
            // The saved-groups folder compares this with the copy time to flag new items.
            if let Some(created) = text(&it["itemCreatedUtc"]) {
                item.insert("created".into(), json!(created));
            }
            Some(Value::Object(item))
        })
        .take(limit)
        .collect();
    Ok(json!({ "items": items }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_url_uses_creator_type() {
        let u = search_url("items", Creator::User(5), 10, "", "RecentlyCreated", "Desc", "All");
        assert!(u.as_str().contains("creatorTargetId=5&creatorType=1"), "{u}");
        let g = search_url("items", Creator::Group(7), 10, "", "RecentlyCreated", "Desc", "All");
        assert!(g.as_str().contains("creatorTargetId=7&creatorType=2"), "{g}");
    }

    // A bundle id is not an asset id: Roblox 404s it on /catalog/ and in LoadAsset, so links and
    // copy targets must use /bundles/ and the wearable Dynamic Head asset inside the bundle.
    #[test]
    fn bundles_link_to_bundles_and_expose_the_wearable_head() {
        let raw = json!({ "id": 231497873499598u64, "itemType": "Bundle", "bundleType": 4, "name": "low quality small grin", "price": 75,
            "bundledItems": [
                { "id": 14618207727u64, "type": "Asset", "assetType": 78 },
                { "id": 95289478498426u64, "type": "Asset", "assetType": 79 },
                { "id": 2365553616590600u64, "type": "UserOutfit" } ] });
        let item = store_item(231497873499598, Some(&parse_catalog_item(&raw, 2)), "G", Creator::Group(9), None);
        assert_eq!(item["catalogUrl"], "https://www.roblox.com/bundles/231497873499598");
        assert_eq!(item["wearAssetId"], 95289478498426u64);
        assert!(item["studioLuaCommand"].as_str().unwrap().contains("LoadAsset(95289478498426)"));

        // A body bundle has no single wearable asset: no copy target, no insert command.
        let body = json!({ "id": 5, "itemType": "Bundle", "bundleType": 1, "name": "Body", "price": 50,
            "bundledItems": [ { "id": 10, "type": "Asset", "assetType": 27 }, { "id": 11, "type": "Asset", "assetType": 28 } ] });
        let item = store_item(5, Some(&parse_catalog_item(&body, 2)), "G", Creator::Group(9), None);
        assert_eq!(item["catalogUrl"], "https://www.roblox.com/bundles/5");
        assert_eq!(item["wearAssetId"], Value::Null);
        assert_eq!(item["studioLuaCommand"], "");

        // Ordinary assets keep their own id everywhere.
        let hat = json!({ "id": 7, "itemType": "Asset", "assetType": 8, "name": "Hat", "price": 10 });
        let item = store_item(7, Some(&parse_catalog_item(&hat, 1)), "G", Creator::Group(9), None);
        assert_eq!(item["catalogUrl"], "https://www.roblox.com/catalog/7");
        assert_eq!(item["wearAssetId"], 7);
    }

    #[test]
    fn user_items_say_user() {
        let item = store_item(6, None, "User #5", Creator::User(5), None);
        assert_eq!((item["creatorType"].clone(), item["creatorId"].clone()), (json!("User"), json!(5)));
        let item = store_item(6, None, "G", Creator::Group(9), None);
        assert_eq!(item["creatorType"], "Group");
    }

    #[test]
    fn sections_query_their_own_catalog_category() {
        let codes: Vec<_> = ["clothing", "accessories", "heads", "animations"]
            .iter()
            .map(|s| Section::parse(s).map(|s| s.category()))
            .collect();
        assert_eq!(codes, vec![Some("3"), Some("11"), Some("18"), Some("12")]);
        assert!(Section::parse("bogus").is_none());
        let u = search_url("items", Creator::Group(7), 10, "", "RecentlyCreated", "Desc", "11");
        assert!(u.as_str().contains("category=11&"), "{u}");
    }

    // Category 18 also returns body bundles and hair for some creators: every row is checked.
    #[test]
    fn section_rows_are_verified() {
        let asset = |t: i64| json!({ "itemType": "Asset", "assetType": t });
        let bundle = |t: i64| json!({ "itemType": "Bundle", "bundleType": t });
        assert!(Section::Clothing.accepts(&asset(11)) && Section::Clothing.accepts(&asset(67)) && Section::Clothing.accepts(&bundle(3)));
        assert!(!Section::Clothing.accepts(&asset(8)));
        assert!(Section::Accessories.accepts(&asset(42)) && !Section::Accessories.accepts(&bundle(4)));
        assert!(Section::Heads.accepts(&bundle(4)));
        assert!(!Section::Heads.accepts(&bundle(1)) && !Section::Heads.accepts(&asset(41)) && !Section::Heads.accepts(&asset(79)));
        assert!(Section::Animations.accepts(&asset(61)) && Section::Animations.accepts(&bundle(2)));
        // Id-only fallback rows carry no type: they came from the category search itself.
        assert!(Section::Heads.accepts(&json!({ "id": 1, "itemType": "Asset" })));
    }

    // Batch bundle details name the type as text; only Dynamic Heads by this creator count.
    #[test]
    fn heads_count_only_dynamic_head_bundles_by_the_group() {
        let details = json!([
            { "id": 1, "bundleType": "DynamicHead", "creator": { "id": 9, "type": "Group" } },
            { "id": 2, "bundleType": "BodyParts", "creator": { "id": 9, "type": "Group" } },
            { "id": 3, "bundleType": "DynamicHead", "creator": { "id": 5, "type": "Group" } },
            { "id": 4, "bundleType": "DynamicHead", "creator": { "id": 9, "type": "Group" } } ]);
        assert_eq!(count_heads(&details, Creator::Group(9)), 2);
    }

    #[test]
    fn drops_foreign_creator_rows() {
        let rows = vec![
            json!({ "id": 1, "creatorType": "User", "creatorTargetId": 5 }),
            json!({ "id": 2, "creatorType": "User", "creatorTargetId": 9 }),
            json!({ "id": 3, "creatorType": "Group", "creatorTargetId": 5 }),
            json!({ "id": 4, "itemType": "Asset" }), // id-only fallback row: nothing to compare
        ];
        let kept: Vec<u64> = own_rows(rows, Creator::User(5))
            .iter()
            .map(|r| r["id"].as_u64().unwrap())
            .collect();
        assert_eq!(kept, vec![1, 4]);
    }

    #[test]
    fn regular_asset_keeps_price_and_type() {
        let raw = json!({ "id": 1, "itemType": "Asset", "assetType": 11, "name": "Suit", "creatorName": "TIX", "creatorTargetId": 9,
            "price": 5, "lowestPrice": 5, "lowestResalePrice": 0, "itemRestrictions": [] });
        let item = store_item(1, Some(&parse_catalog_item(&raw, 1)), "G", Creator::Group(9), None);
        assert_eq!(item["price"], 5);
        assert_eq!(item["lowestPrice"], 5);
        assert_eq!(item["isForSale"], true);
        assert_eq!(item["isOffSale"], false);
        assert_eq!(item["assetType"], 11);
        assert_eq!(item["assetTypeName"], "Shirt");
        assert_eq!(item["priceStatus"], "");
        assert_eq!(item["creatorId"], 9);
    }

    #[test]
    fn off_sale_and_one_robux_items_are_off_sale() {
        let off = json!({ "id": 2, "itemType": "Asset", "assetType": 12, "name": "P", "priceStatus": "Off Sale" });
        let item = store_item(2, Some(&parse_catalog_item(&off, 1)), "G", Creator::Group(9), None);
        assert_eq!(
            (
                item["isOffSale"].clone(),
                item["price"].clone(),
                item["priceStatus"].clone()
            ),
            (json!(true), Value::Null, json!("Off Sale"))
        );
        let one =
            json!({ "id": 3, "itemType": "Asset", "assetType": 11, "name": "Old", "price": 1 });
        let item = store_item(3, Some(&parse_catalog_item(&one, 1)), "G", Creator::Group(9), None);
        assert_eq!(
            (item["isOffSale"].clone(), item["price"].clone()),
            (json!(true), Value::Null)
        );
    }

    #[test]
    fn off_sale_clothing_with_lowest_price_is_not_resale() {
        // Real catalog answer for 16775385048 (Off Sale on Roblox).
        let raw = json!({ "id": 16775385048u64, "itemType": "Asset", "assetType": 11, "name": "Shirt", "price": 5, "lowestPrice": 5,
            "lowestResalePrice": 0, "priceStatus": "Off Sale", "isOffSale": true, "hasResellers": false });
        let item = store_item(
            16775385048,
            Some(&parse_catalog_item(&raw, 1)),
            "G",
            Creator::Group(9),
            None,
        );
        assert_eq!(
            (
                item["isOffSale"].clone(),
                item["price"].clone(),
                item["priceStatus"].clone()
            ),
            (json!(true), Value::Null, json!("Off Sale"))
        );
        // A limited with resellers stays buyable at the resale price.
        let limited = json!({ "id": 7, "itemType": "Asset", "assetType": 8, "name": "Limited", "price": null, "lowestPrice": 482,
            "lowestResalePrice": 482, "priceStatus": "Off Sale", "isOffSale": true, "hasResellers": true });
        let item = store_item(7, Some(&parse_catalog_item(&limited, 1)), "G", Creator::Group(9), None);
        assert_eq!(
            (
                item["isForSale"].clone(),
                item["price"].clone(),
                item["priceStatus"].clone()
            ),
            (json!(true), json!(482), json!("Resale"))
        );
    }

    #[test]
    fn free_item_and_bundle_without_asset_type() {
        let free = json!({ "id": 4, "itemType": "Asset", "assetType": 8, "name": "Hat", "price": 0, "priceStatus": "Free" });
        let item = store_item(4, Some(&parse_catalog_item(&free, 1)), "G", Creator::Group(9), None);
        assert_eq!(
            (
                item["isFree"].clone(),
                item["price"].clone(),
                item["isForSale"].clone()
            ),
            (json!(true), json!(0), json!(true))
        );
        let bundle = json!({ "id": 5, "itemType": "Bundle", "name": "Smirk", "price": 75, "lowestPrice": 75 });
        let item = store_item(5, Some(&parse_catalog_item(&bundle, 2)), "G", Creator::Group(9), None);
        assert!(item.get("assetType").is_none());
        assert_eq!(item["assetTypeName"], "Avatar Bundle / Pack");
        assert_eq!(item["price"], 75);
    }

    #[test]
    fn missing_details_fall_back_like_node() {
        let item = store_item(6, None, "My Group", Creator::Group(42), None);
        assert_eq!(item["name"], "Item #6");
        assert_eq!(item["creatorName"], "My Group");
        assert_eq!(item["creatorId"], 42);
        assert_eq!(item["assetTypeName"], "Wearable");
        assert_eq!(item["isOffSale"], true);
    }

    #[test]
    fn economy_answers_follow_catalog_rules() {
        // Real economy answer shape for an off-sale group shirt.
        let off = json!({ "Name": "Shirt", "PriceInRobux": 5, "IsForSale": false, "AssetTypeId": 11, "IsPublicDomain": false,
            "Creator": { "Id": 1699459963u64, "CreatorTargetId": 6712731, "CreatorType": "Group", "Name": "G" },
            "CollectiblesItemDetails": { "CollectibleLowestResalePrice": null } });
        let parsed = parse_catalog_item(&economy_as_catalog(1, &off).unwrap(), 1);
        assert!(parsed.is_off_sale && !parsed.is_for_sale && parsed.price.is_none());
        assert_eq!(parsed.creator_id, json!(6712731));
        let on = json!({ "Name": "Hat", "PriceInRobux": 80, "IsForSale": true, "AssetTypeId": 8, "Creator": { "Id": 1, "CreatorType": "User", "Name": "U" } });
        let parsed = parse_catalog_item(&economy_as_catalog(2, &on).unwrap(), 1);
        assert_eq!(
            (parsed.price, parsed.is_for_sale, parsed.creator_id.clone()),
            (Some(80), true, json!(1))
        );
        let free = json!({ "Name": "Free", "PriceInRobux": null, "IsForSale": true, "IsPublicDomain": true, "AssetTypeId": 8, "Creator": {} });
        assert!(parse_catalog_item(&economy_as_catalog(3, &free).unwrap(), 1).is_free);
        assert!(economy_as_catalog(4, &json!({ "Name": "" })).is_none());
    }

    #[test]
    fn zero_price_off_sale_is_not_free() {
        let catalog = json!({ "id": 8, "itemType": "Asset", "assetType": 11, "name": "S", "price": 0,
            "priceStatus": "Off Sale", "isOffSale": true });
        let economy = json!({ "Name": "S", "PriceInRobux": 0, "IsForSale": false, "AssetTypeId": 11, "Creator": {} });
        for raw in [catalog, economy_as_catalog(8, &economy).unwrap()] {
            let parsed = parse_catalog_item(&raw, 1);
            assert!(!parsed.is_free && parsed.is_off_sale && !parsed.is_for_sale);
            assert_eq!(crate::profile::resolved_price(&parsed), (None, false));
            let item = store_item(8, Some(&parsed), "G", Creator::Group(9), None);
            assert_eq!(
                (
                    item["isFree"].clone(),
                    item["isOffSale"].clone(),
                    item["price"].clone()
                ),
                (json!(false), json!(true), Value::Null)
            );
        }
        // On-sale price 0 without a status is still free.
        let free = json!({ "id": 9, "itemType": "Asset", "assetType": 8, "name": "H", "price": 0 });
        assert!(parse_catalog_item(&free, 1).is_free);
    }
}
