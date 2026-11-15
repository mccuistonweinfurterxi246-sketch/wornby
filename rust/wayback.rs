//! Wayback Machine sources for the outfit archive: snapshot index, fetch and parsers for archived
//! Roblox pages and API answers. Archived content never changes, so results are cached hard.

use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Semaphore;

use crate::outfits::{normalize_saved_outfit_assets, normalize_saved_outfits};
use crate::upstream::Ttl;

const WAYBACK_TIMEOUT: Duration = Duration::from_secs(12);
// Prefix searches (needed for outfit lists, whose archived URLs carry query strings) take 25-60s on the CDX server.
const PREFIX_TIMEOUT: Duration = Duration::from_secs(55);
// Profile pages after 2020 render in the browser, so their archived HTML holds no avatar data.
const LAST_HTML_PROFILE_YEAR: &str = "2021";
// Wayback throttles bursts: at most this many requests in flight per instance.
static PERMITS: Semaphore = Semaphore::const_new(3);
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent("WornbyArchive/1.0")
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("wayback client")
});
static INDEX: LazyLock<Ttl<Value>> = LazyLock::new(|| Ttl::new(24 * 60 * 60, 2000));
static SNAPSHOTS: LazyLock<Ttl<Value>> = LazyLock::new(|| Ttl::new(24 * 60 * 60, 5000));

/// What an archived URL holds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Outfits,
    Wearing,
    Avatar,
    Profile,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "outfits" => Self::Outfits,
            "wearing" => Self::Wearing,
            "avatar" => Self::Avatar,
            "profile" => Self::Profile,
            _ => return None,
        })
    }
    fn name(self) -> &'static str {
        match self {
            Self::Outfits => "outfits",
            Self::Wearing => "wearing",
            Self::Avatar => "avatar",
            Self::Profile => "profile",
        }
    }
    /// Archived URL prefixes (scheme-less) of this player's data.
    fn prefixes(self, uid: u64) -> Vec<String> {
        match self {
            Self::Outfits => vec![
                format!("avatar.roblox.com/v1/users/{uid}/outfits"),
                format!("avatar.roblox.com/v2/avatar/users/{uid}/outfits"),
            ],
            Self::Wearing => vec![format!(
                "avatar.roblox.com/v1/users/{uid}/currently-wearing"
            )],
            Self::Avatar => vec![
                format!("avatar.roblox.com/v1/users/{uid}/avatar"),
                format!("avatar.roblox.com/v2/avatar/users/{uid}/avatar"),
            ],
            Self::Profile => vec![format!("www.roblox.com/users/{uid}/profile")],
        }
    }
}

/// The URL belongs to this player and kind (keeps the snapshot route from fetching arbitrary pages).
pub fn allowed(kind: Kind, uid: u64, url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(&lower);
    // Old captures carry the default port ("www.roblox.com:80/users/...").
    let rest = rest
        .replacen(".com:80/", ".com/", 1)
        .replacen(".com:443/", ".com/", 1);
    !url.contains(char::is_whitespace)
        && kind.prefixes(uid).iter().any(|p| {
            rest.strip_prefix(p.as_str())
                .is_some_and(|tail| tail.is_empty() || tail.starts_with(['?', '/']))
        })
}

fn date(ts: &str) -> String {
    format!("{}-{}-{}", &ts[..4], &ts[4..6], &ts[6..8])
}

/// Body of a Wayback URL; None when it stays unavailable after a careful retry.
async fn fetch(url: &str) -> Option<String> {
    fetch_within(url, WAYBACK_TIMEOUT, 3).await
}

async fn fetch_within(url: &str, timeout: Duration, attempts: u64) -> Option<String> {
    let _permit = PERMITS.acquire().await.ok()?;
    for attempt in 0..attempts {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(1500 * attempt)).await;
        }
        let Ok(res) = CLIENT.get(url).timeout(timeout).send().await else {
            continue;
        };
        match res.status().as_u16() {
            200 => return res.text().await.ok(),
            429 | 500..=599 => continue,
            _ => return None,
        }
    }
    eprintln!(
        "[wayback] unavailable: {}",
        url.split('?').next().unwrap_or(url)
    );
    None
}

/// CDX rows (timestamp, original, digest) for a URL, as a prefix or an exact match.
async fn cdx(url: &str, prefix: bool, collapse: &str) -> Option<Vec<(String, String, String)>> {
    // Same index and answer format; the timemap endpoint stayed responsive for prefix searches
    // while the CDX endpoint timed out or answered 503.
    let endpoint = if prefix {
        "https://web.archive.org/web/timemap/json"
    } else {
        "https://web.archive.org/cdx/search/cdx?output=json"
    };
    let mut q = url::Url::parse(endpoint).unwrap();
    q.query_pairs_mut()
        .append_pair("url", url)
        .append_pair("matchType", if prefix { "prefix" } else { "exact" })
        .append_pair("fl", "timestamp,original,digest")
        .append_pair("filter", "statuscode:200")
        .append_pair("collapse", collapse)
        .append_pair("limit", "2000");
    let body = if prefix {
        fetch_within(q.as_str(), PREFIX_TIMEOUT, 2).await?
    } else {
        fetch(q.as_str()).await?
    };
    let rows: Vec<Vec<String>> = serde_json::from_str(&body).ok().unwrap_or_default();
    Some(
        rows.into_iter()
            .skip(1)
            .filter_map(|r| match r.as_slice() {
                [ts, original, digest]
                    if ts.len() >= 8 && ts.bytes().all(|b| b.is_ascii_digit()) =>
                {
                    Some((ts.clone(), original.clone(), digest.clone()))
                }
                _ => None,
            })
            .collect(),
    )
}

/// Archived snapshots of one kind of the player's data; identical content (same digest) is listed once.
/// Outfit lists need a prefix search (slow); the other kinds live at fixed URLs (exact search, fast).
pub async fn index(uid: u64, kind: Kind) -> Value {
    let key = format!("{uid}:{}", kind.name());
    if let Some(hit) = INDEX.get(&key) {
        return hit;
    }
    let prefixes = kind.prefixes(uid);
    let prefix = kind == Kind::Outfits;
    // Profile HTML differs on every capture, so sample it monthly; JSON answers dedupe by content.
    let collapse = if kind == Kind::Profile {
        "timestamp:6"
    } else {
        "digest"
    };
    let answers =
        futures::future::join_all(prefixes.iter().map(|p| cdx(p, prefix, collapse))).await;
    let mut complete = true;
    let mut seen = HashSet::new();
    let mut snapshots = Vec::new();
    for rows in answers {
        let Some(rows) = rows else {
            complete = false;
            continue;
        };
        for (ts, original, digest) in rows {
            if kind == Kind::Profile && ts.as_str() >= LAST_HTML_PROFILE_YEAR {
                continue;
            }
            if seen.insert(digest) {
                snapshots.push(json!({ "kind": kind.name(), "ts": ts, "url": original }));
            }
        }
    }
    snapshots.sort_by(|a, b| a["ts"].as_str().cmp(&b["ts"].as_str()));
    let result = json!({ "snapshots": snapshots, "complete": complete });
    if complete {
        INDEX.set(key, result.clone());
    }
    result
}

fn look(asset_ids: Vec<u64>, items: Vec<Value>, render_url: Option<String>) -> Value {
    json!({ "assetIds": asset_ids, "items": items, "renderUrl": render_url })
}

/// One snapshot reduced to what the archive shows; `Value::Null` content when nothing usable was archived.
pub fn parse_snapshot(kind: Kind, ts: &str, body: &str) -> Value {
    let data: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let mut out = json!({ "kind": kind.name(), "date": date(ts) });
    match kind {
        Kind::Outfits => {
            let outfits: Vec<Value> = normalize_saved_outfits(&data["data"])
                .into_iter()
                .map(|o| json!({ "id": o["id"], "name": o["name"] }))
                .collect();
            out["outfits"] = json!(outfits);
        }
        Kind::Wearing => {
            let ids: Vec<u64> = data["assetIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_u64)
                .collect();
            if !ids.is_empty() {
                out["look"] = look(ids, vec![], None);
            }
        }
        Kind::Avatar => {
            let items: Vec<Value> = data["assets"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| {
                    Some(json!({ "id": a["id"].as_u64()?, "name": a["name"], "assetTypeName": a["assetType"]["name"] }))
                })
                .collect();
            if !items.is_empty() {
                let ids = items.iter().filter_map(|i| i["id"].as_u64()).collect();
                out["look"] = look(ids, items, None);
            }
        }
        Kind::Profile => {
            if let Some(p) = parse_profile_html(body) {
                let ids = p.items.iter().map(|(id, _)| *id).collect();
                let items = p
                    .items
                    .into_iter()
                    .map(|(id, name)| json!({ "id": id, "name": name }))
                    .collect();
                // The render is long gone from Roblox's CDN; Wayback serves its archived copy.
                let render = p
                    .render_url
                    .map(|u| format!("https://web.archive.org/web/{ts}im_/{u}"));
                out["look"] = look(ids, items, render);
            }
        }
    }
    out
}

/// Fetch and parse one archived snapshot (url already checked with `allowed`).
pub async fn snapshot(kind: Kind, ts: &str, url: &str) -> Option<Value> {
    let key = format!("{ts}|{url}");
    if let Some(hit) = SNAPSHOTS.get(&key) {
        return Some(hit);
    }
    let body = fetch(&format!("https://web.archive.org/web/{ts}id_/{url}")).await?;
    let parsed = parse_snapshot(kind, ts, &body);
    SNAPSHOTS.set(key, parsed.clone());
    Some(parsed)
}

/// Archived contents of an outfit that no longer exists on Roblox (from captured details answers).
pub async fn archived_outfit(id: u64) -> Option<Value> {
    let key = format!("outfit:{id}");
    if let Some(hit) = SNAPSHOTS.get(&key) {
        return Some(hit);
    }
    let mut rows = Vec::new();
    for v in ["v1", "v3"] {
        rows.extend(
            cdx(
                &format!("avatar.roblox.com/{v}/outfits/{id}/details"),
                false,
                "digest",
            )
            .await?,
        );
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0)); // newest capture first
    for (ts, original, _) in rows {
        let Some(body) = fetch(&format!("https://web.archive.org/web/{ts}id_/{original}")).await
        else {
            continue;
        };
        let data: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        if !data["assets"].is_array() {
            continue;
        }
        let result = json!({
            "id": id,
            "name": data["name"],
            "assets": normalize_saved_outfit_assets(&data["assets"]),
            "archivedAt": date(&ts),
        });
        SNAPSHOTS.set(key, result.clone());
        return Some(result);
    }
    let none = json!({ "id": id, "assets": null });
    SNAPSHOTS.set(key, none.clone());
    Some(none)
}

/// Worn look recovered from an archived profile page (2015–2020 layout).
#[derive(Debug, PartialEq)]
pub struct ProfileLook {
    /// (asset id, item name) in page order.
    pub items: Vec<(u64, String)>,
    /// Avatar render URL as it appeared on the page (dead on Roblox's CDN, archived by Wayback).
    pub render_url: Option<String>,
}

/// Value of the first `attr=` (quoted or not) inside `tag`.
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let start = tag.find(&format!("{name}="))? + name.len() + 1;
    let rest = &tag[start..];
    let (open, body) = match rest.chars().next()? {
        q @ ('"' | '\'') => (Some(q), &rest[1..]),
        _ => (None, rest),
    };
    let end = match open {
        Some(q) => body.find(q)?,
        None => body
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(body.len()),
    };
    Some(&body[..end])
}

/// Asset id from an item link: `/catalog/123/...` or `...-item?id=123`.
fn link_id(href: &str) -> Option<u64> {
    let digits = if let Some(i) = href.find("/catalog/") {
        &href[i + 9..]
    } else {
        &href[href.find("id=")? + 3..]
    };
    let n: String = digits.chars().take_while(char::is_ascii_digit).collect();
    n.parse().ok().filter(|&id| id > 0)
}

/// Items of the "Currently Wearing" list and the avatar render, read only from that section so
/// favorites and creations elsewhere on the page are never mistaken for worn items.
pub fn parse_profile_html(html: &str) -> Option<ProfileLook> {
    let lower = html.to_ascii_lowercase();
    let section = lower.find("currently wearing")?;
    let list_start = section + lower[section..].find("accoutrement-items-container")?;
    let list_end = list_start + lower[list_start..].find("</ul>")?;
    let render_url = lower[section..list_start].find("<img").and_then(|i| {
        let tag = &html[section + i..list_start];
        let tag = &tag[..tag.find('>').unwrap_or(tag.len())];
        attr(tag, "src").map(str::to_string)
    });
    let mut items = Vec::new();
    let list = &html[list_start..list_end];
    for chunk in list.split("<a ").skip(1) {
        let tag = &chunk[..chunk.find('>').unwrap_or(chunk.len())];
        let Some(id) = attr(tag, "href").and_then(link_id) else {
            continue;
        };
        let name = chunk
            .find("<img")
            .and_then(|i| attr(&chunk[i..], "title").or_else(|| attr(&chunk[i..], "alt")))
            .unwrap_or("")
            .to_string();
        if !items.iter().any(|(seen, _)| *seen == id) {
            items.push((id, name));
        }
    }
    (!items.is_empty()).then_some(ProfileLook { items, render_url })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_worn_items_and_render_from_2016_and_2019_profiles() {
        let old = parse_profile_html(include_str!("fixtures/profile-2016.html")).unwrap();
        assert_eq!(old.items.len(), 5);
        assert_eq!(old.items[0], (42070576, "Epic Face".to_string()));
        assert_eq!(
            old.render_url.as_deref(),
            Some("http://t3.rbxcdn.com/12f802116f9b9fd8a2accc3e85b23318")
        );

        let newer = parse_profile_html(include_str!("fixtures/profile-2019.html")).unwrap();
        assert_eq!(newer.items.len(), 8); // first page of the 14-item slider
        assert!(newer.items.iter().all(|(id, _)| *id > 0));
        assert_eq!(
            newer.render_url.as_deref(),
            Some("https://t4.rbxcdn.com/d9a5c547789f894c3f9be4a4df257256")
        );
    }

    #[test]
    fn snapshot_urls_must_belong_to_the_player_and_kind() {
        assert!(allowed(
            Kind::Outfits,
            261,
            "https://avatar.roblox.com/v2/avatar/users/261/outfits?page=1"
        ));
        assert!(allowed(
            Kind::Wearing,
            261,
            "https://avatar.roblox.com/v1/users/261/currently-wearing"
        ));
        assert!(!allowed(
            Kind::Wearing,
            261,
            "https://avatar.roblox.com/v1/users/2610/currently-wearing"
        ));
        assert!(!allowed(
            Kind::Outfits,
            261,
            "https://avatar.roblox.com/v1/users/261/currently-wearing"
        ));
        assert!(!allowed(
            Kind::Profile,
            261,
            "https://evil.example/www.roblox.com/users/261/profile"
        ));
        // Old captures carry the default port.
        assert!(allowed(
            Kind::Profile,
            261,
            "http://www.roblox.com:80/users/261/profile"
        ));
    }

    #[test]
    fn snapshots_reduce_to_outfits_or_looks() {
        let list = parse_snapshot(
            Kind::Outfits,
            "20221106000000",
            r#"{"data":[{"id":5,"name":"maidy","isEditable":true},{"id":6,"name":"bundle","isEditable":false}]}"#,
        );
        assert_eq!(list["date"], "2022-11-06");
        assert_eq!(list["outfits"], json!([{ "id": 5, "name": "maidy" }]));

        let worn = parse_snapshot(Kind::Wearing, "20210822000000", r#"{"assetIds":[3,1,2]}"#);
        assert_eq!(worn["look"]["assetIds"], json!([3, 1, 2]));

        let avatar = parse_snapshot(
            Kind::Avatar,
            "20230101000000",
            r#"{"assets":[{"id":9,"name":"Hat","assetType":{"id":8,"name":"Hat"}}]}"#,
        );
        assert_eq!(avatar["look"]["items"][0]["assetTypeName"], "Hat");

        let page = parse_snapshot(
            Kind::Profile,
            "20160103060258",
            include_str!("fixtures/profile-2016.html"),
        );
        assert_eq!(
            page["look"]["renderUrl"],
            "https://web.archive.org/web/20160103060258im_/http://t3.rbxcdn.com/12f802116f9b9fd8a2accc3e85b23318"
        );
        // An HTML error page archived instead of JSON yields no content, not an error.
        assert!(
            parse_snapshot(Kind::Wearing, "20210101000000", "<html>")
                .get("look")
                .is_none()
        );
    }

    #[test]
    fn pages_without_the_wearing_section_give_nothing() {
        assert_eq!(
            parse_profile_html("<html><a href=/catalog/5>x</a></html>"),
            None
        );
    }
}
