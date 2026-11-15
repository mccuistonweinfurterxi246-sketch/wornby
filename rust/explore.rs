//! Explore feeds: group members, experiences and creator assets (public, anonymous, paged).

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;

use futures::future::join_all;
use serde_json::{Value, json};

use crate::catalog::{Creator, group_info, text};
use crate::upstream::{Ttl, UpErr, asset_thumbnails, client_for, get_official};

const FEED_TIMEOUT: Duration = Duration::from_secs(6);
const MEMBERS_PAGE: u32 = 50;

static MEMBERS: LazyLock<Ttl<Value>> = LazyLock::new(|| Ttl::new(5 * 60, 500));
static GAMES: LazyLock<Ttl<Value>> = LazyLock::new(|| Ttl::new(10 * 60, 500));
static ASSETS: LazyLock<Ttl<Value>> = LazyLock::new(|| Ttl::new(10 * 60, 500));

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AssetKind {
    Model,
    Decal,
    Mesh,
}

pub const ASSET_KINDS: [AssetKind; 3] = [AssetKind::Model, AssetKind::Decal, AssetKind::Mesh];

impl AssetKind {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "model" => Self::Model,
            "decal" => Self::Decal,
            "mesh" => Self::Mesh,
            _ => return None,
        })
    }
    /// Toolbox marketplace category id.
    pub fn category(&self) -> u32 {
        match self {
            Self::Model => 10,
            Self::Decal => 13,
            Self::Mesh => 40,
        }
    }
    pub fn key(&self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::Decal => "decal",
            Self::Mesh => "mesh",
        }
    }
}

fn plural(c: Creator) -> &'static str {
    match c {
        Creator::User(_) => "users",
        Creator::Group(_) => "groups",
    }
}

/// Roblox cursors are opaque base64; anything longer is not one of theirs.
pub fn valid_cursor(cursor: &str) -> bool {
    cursor.len() <= 1024
}

/// `base` + `cursor=` when a cursor is given (url-encoded).
fn paged(base: &str, cursor: &str) -> String {
    if cursor.is_empty() {
        return base.to_string();
    }
    let enc: String = url::form_urlencoded::byte_serialize(cursor.as_bytes()).collect();
    format!("{base}&cursor={enc}")
}

/// Thumbnail urls by target id (`prefix` ends with `...Ids=`), 100 per call, and whether every call
/// answered. Ids without an image (blocked or deleted) are simply absent.
async fn thumbs(prefix: &str, ids: &[u64]) -> (HashMap<u64, String>, bool) {
    let requests = ids.chunks(100).map(|chunk| async move {
        let list = chunk.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        get_official(client_for(chunk[0]), &format!("{prefix}{list}"), FEED_TIMEOUT).await
    });
    let mut out = HashMap::new();
    let results = join_all(requests).await;
    let all_ok = results.iter().all(Result::is_ok);
    for data in results.into_iter().flatten() {
        for t in data["data"].as_array().into_iter().flatten() {
            if let (Some(id), Some(url)) = (t["targetId"].as_u64(), text(&t["imageUrl"])) {
                out.insert(id, url.to_string());
            }
        }
    }
    (out, all_ok)
}

pub fn parse_members(v: &Value) -> Vec<Value> {
    v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let user = &row["user"];
            let id = user["userId"].as_u64().filter(|&id| id > 0)?;
            let name = text(&user["username"])?;
            Some(json!({
                "id": id,
                "name": name,
                "displayName": text(&user["displayName"]).unwrap_or(name),
                "verified": user["hasVerifiedBadge"] == true,
                "role": { "name": row["role"]["name"], "rank": row["role"]["rank"] },
            }))
        })
        .collect()
}

/// The answer when Roblox won't list a group's members: no members, and the owner the group record still names.
pub fn hidden_members(info: &Value) -> Value {
    let o = &info["owner"];
    let owner = o["userId"].as_u64().filter(|&id| id > 0).map(|id| {
        let name = text(&o["username"]).unwrap_or("");
        json!({ "id": id, "name": name, "displayName": text(&o["displayName"]).unwrap_or(name) })
    });
    json!({ "members": [], "nextPageCursor": null, "hidden": true, "owner": owner })
}

/// One page of a group's members with headshots: `({ members, nextPageCursor }, complete)`.
pub async fn members(group_id: u64, cursor: &str) -> Result<(Value, bool), UpErr> {
    let key = format!("{group_id}:{cursor}");
    if let Some(hit) = MEMBERS.get(&key) {
        return Ok((hit, true));
    }
    let base = format!(
        "https://groups.roblox.com/v1/groups/{group_id}/users?limit={MEMBERS_PAGE}&sortOrder=Desc"
    );
    let data = match get_official(client_for(group_id), &paged(&base, cursor), FEED_TIMEOUT).await {
        Ok(data) => data,
        // A 400 for a group that exists: Roblox hides this group's member list from anonymous viewers.
        Err(e) if e.status == Some(400) => match group_info(group_id).await {
            Ok(Some(info)) => {
                let page = hidden_members(&info);
                MEMBERS.set(key, page.clone());
                return Ok((page, true));
            }
            _ => return Err(e),
        },
        Err(e) => return Err(e),
    };
    let mut list = parse_members(&data);
    let ids: Vec<u64> = list.iter().filter_map(|m| m["id"].as_u64()).collect();
    let (heads, complete) = thumbs(
        "https://thumbnails.roblox.com/v1/users/avatar-headshot?size=150x150&format=Png&isCircular=false&userIds=",
        &ids,
    )
    .await;
    for m in &mut list {
        let url = m["id"].as_u64().and_then(|id| heads.get(&id).cloned());
        m["headshotUrl"] = json!(url);
    }
    let page = json!({ "members": list, "nextPageCursor": text(&data["nextPageCursor"]) });
    if complete {
        MEMBERS.set(key, page.clone());
    }
    Ok((page, complete))
}

pub fn parse_games(v: &Value) -> Vec<Value> {
    v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| {
            let universe_id = g["id"].as_u64().filter(|&id| id > 0)?;
            let description = text(&g["description"]);
            Some(json!({
                "universeId": universe_id,
                "placeId": g["rootPlace"]["id"],
                "name": text(&g["name"]).unwrap_or("Untitled experience"),
                "description": description.filter(|d| *d != "[ Content Deleted ]"),
                "moderated": description == Some("[ Content Deleted ]"),
                "visits": g["placeVisits"].as_u64().unwrap_or(0),
                "created": g["created"],
                "updated": g["updated"],
            }))
        })
        .collect()
}

/// One page of a creator's public experiences with icons: `({ experiences, nextPageCursor }, complete)`.
pub async fn experiences(c: Creator, cursor: &str) -> Result<(Value, bool), UpErr> {
    let key = format!("{}:{}:{cursor}", c.type_code(), c.id());
    if let Some(hit) = GAMES.get(&key) {
        return Ok((hit, true));
    }
    let base = format!(
        "https://games.roblox.com/v2/{}/{}/games?accessFilter=Public&limit=50&sortOrder=Desc",
        plural(c),
        c.id()
    );
    let data = get_official(client_for(c.id()), &paged(&base, cursor), FEED_TIMEOUT).await?;
    let mut list = parse_games(&data);
    let ids: Vec<u64> = list.iter().filter_map(|g| g["universeId"].as_u64()).collect();
    let (icons, complete) = thumbs(
        "https://thumbnails.roblox.com/v1/games/icons?size=150x150&format=Png&universeIds=",
        &ids,
    )
    .await;
    for g in &mut list {
        let url = g["universeId"].as_u64().and_then(|id| icons.get(&id).cloned());
        g["iconUrl"] = json!(url);
    }
    let page = json!({ "experiences": list, "nextPageCursor": text(&data["nextPageCursor"]) });
    if complete {
        GAMES.set(key, page.clone());
    }
    Ok((page, complete))
}

pub fn total_results(v: &Value) -> u64 {
    v["totalResults"].as_u64().unwrap_or(0)
}

/// Exact count per asset kind (the toolbox search reports its total): `{ model, decal, mesh }`.
pub async fn assets_summary(c: Creator) -> Result<Value, UpErr> {
    let key = format!("{}:{}:summary", c.type_code(), c.id());
    if let Some(hit) = ASSETS.get(&key) {
        return Ok(hit);
    }
    let calls = ASSET_KINDS.map(|kind| async move {
        let url = format!(
            "https://apis.roblox.com/toolbox-service/v1/marketplace/{}?creatorTargetId={}&creatorType={}&limit=10",
            kind.category(),
            c.id(),
            c.type_code()
        );
        get_official(client_for(c.id()), &url, FEED_TIMEOUT).await.map(|v| (kind, total_results(&v)))
    });
    let mut out = serde_json::Map::new();
    for result in join_all(calls).await {
        let (kind, n) = result?;
        out.insert(kind.key().into(), json!(n));
    }
    let summary = Value::Object(out);
    ASSETS.set(key, summary.clone());
    Ok(summary)
}

/// Toolbox details rows made by `c` (rows naming another creator are dropped).
pub fn parse_toolbox_details(v: &Value, c: Creator) -> Vec<Value> {
    let creator_type = c.type_code().parse::<u64>().unwrap_or(0);
    v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| {
            row["creator"]["id"].as_u64() == Some(c.id())
                && row["creator"]["type"].as_u64() == Some(creator_type)
        })
        .filter_map(|row| {
            let a = &row["asset"];
            let id = a["id"].as_u64().filter(|&id| id > 0)?;
            Some(json!({
                "id": id,
                "name": text(&a["name"]).unwrap_or("Untitled"),
                "typeId": a["typeId"],
                "created": a["createdUtc"],
                "updated": a["updatedUtc"],
            }))
        })
        .collect()
}

/// One page of a creator's toolbox assets of one kind: `({ assets, nextPageCursor }, complete)`.
pub async fn assets(c: Creator, kind: AssetKind, cursor: &str) -> Result<(Value, bool), UpErr> {
    let key = format!("{}:{}:{}:{cursor}", c.type_code(), c.id(), kind.category());
    if let Some(hit) = ASSETS.get(&key) {
        return Ok((hit, true));
    }
    let base = format!(
        "https://apis.roblox.com/toolbox-service/v1/marketplace/{}?creatorTargetId={}&creatorType={}&limit=30",
        kind.category(),
        c.id(),
        c.type_code()
    );
    let search = get_official(client_for(c.id()), &paged(&base, cursor), FEED_TIMEOUT).await?;
    let ids: Vec<u64> = search["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r["id"].as_u64())
        .collect();
    let next = text(&search["nextPageCursor"]).map(str::to_string);
    if ids.is_empty() {
        return Ok((json!({ "assets": [], "nextPageCursor": next }), true));
    }
    let list = ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
    let details = get_official(
        client_for(c.id()),
        &format!("https://apis.roblox.com/toolbox-service/v1/items/details?assetIds={list}"),
        FEED_TIMEOUT,
    )
    .await?;
    let mut rows = parse_toolbox_details(&details, c);
    let images = asset_thumbnails(&ids).await;
    for r in &mut rows {
        let url = r["id"].as_u64().and_then(|id| images.get(&id).cloned());
        r["thumbnailUrl"] = json!(url);
    }
    // Details answered for every id: complete (audio has no thumbnail, so images don't count).
    let complete = details["data"].as_array().map_or(0, Vec::len) == ids.len();
    let page = json!({ "assets": rows, "nextPageCursor": next });
    if complete {
        ASSETS.set(key, page.clone());
    }
    Ok((page, complete))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let path = format!("{}/rust/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn parse_members_fixture() {
        let members = parse_members(&fixture("group_members.json"));
        let first = &members[0];
        assert_eq!(first["id"], 2761213);
        assert_eq!(first["name"], "thhp");
        assert_eq!(first["displayName"], "4399");
        assert_eq!(first["verified"], false);
        assert_eq!(first["role"]["rank"], 1);
    }

    #[test]
    fn parse_members_skips_rows_without_user_id() {
        // The fixture's 4th row has no userId.
        assert_eq!(parse_members(&fixture("group_members.json")).len(), 3);
    }

    #[test]
    fn parse_games_fixture() {
        let games = parse_games(&fixture("user_games.json"));
        let g = &games[0];
        assert_eq!(g["name"], "Crossroads but with a million people");
        assert_eq!(g["moderated"], true);
        assert_eq!(g["visits"], 24861);
        assert_eq!(g["placeId"], 6504969480u64);
        assert_eq!(g["universeId"], 2434560046u64);
        assert_eq!(games[1]["moderated"], false);
    }

    #[test]
    fn parse_games_null_description() {
        let games = parse_games(&fixture("user_games.json"));
        assert_eq!(games[2]["description"], Value::Null);
        assert_eq!(games[1]["description"], Value::Null, "empty description is null too");
    }

    #[test]
    fn asset_kind_parse() {
        assert_eq!(AssetKind::parse("model").map(|k| k.category()), Some(10));
        assert_eq!(AssetKind::parse("decal").map(|k| k.category()), Some(13));
        assert_eq!(AssetKind::parse("mesh").map(|k| k.category()), Some(40));
        // Audio and plugins have nothing to do with avatars: not offered.
        assert!(AssetKind::parse("audio").is_none() && AssetKind::parse("plugin").is_none());
        assert!(AssetKind::parse("bogus").is_none());
    }

    #[test]
    fn asset_totals_read_the_toolbox_count() {
        assert_eq!(total_results(&json!({ "totalResults": 34, "data": [] })), 34);
        assert_eq!(total_results(&json!({ "data": [] })), 0);
    }

    #[test]
    fn parse_toolbox_fixture() {
        let assets = parse_toolbox_details(&fixture("toolbox_details.json"), Creator::User(156));
        assert_eq!(assets[0]["id"], 32252);
        assert_eq!(assets[0]["name"], "Builderman");
        assert_eq!(assets[0]["typeId"], 10);
        assert_eq!(assets.len(), 2);
    }

    #[test]
    fn assets_drop_foreign_creator() {
        let data = fixture("toolbox_details.json");
        assert!(parse_toolbox_details(&data, Creator::User(999)).is_empty());
        assert!(parse_toolbox_details(&data, Creator::Group(156)).is_empty(), "type 1 is a user");
    }

    // Roblox refuses some groups' member lists anonymously (400 "The user is invalid or does not exist").
    #[test]
    fn hidden_member_list_names_the_owner() {
        let info = json!({ "id": 53751792, "name": "scene puke party",
            "owner": { "userId": 3711233831u64, "username": "TouhouInflation", "displayName": "Touhou" } });
        let page = hidden_members(&info);
        assert_eq!(page["members"], json!([]));
        assert_eq!(page["nextPageCursor"], Value::Null);
        assert_eq!(page["hidden"], true);
        assert_eq!(page["owner"], json!({ "id": 3711233831u64, "name": "TouhouInflation", "displayName": "Touhou" }));
        assert_eq!(hidden_members(&json!({ "id": 1, "owner": null }))["owner"], Value::Null);
    }

    #[test]
    fn cursor_validation() {
        assert!(valid_cursor(""));
        assert!(valid_cursor(&"a".repeat(1024)));
        assert!(!valid_cursor(&"a".repeat(1025)));
    }
}
