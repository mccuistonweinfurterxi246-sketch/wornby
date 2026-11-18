//! Saved outfits ("fits") of a user and the wearable items of one outfit (server/savedOutfits.ts + RobloxService).

use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{Value, json};

use crate::upstream::{Ttl, UpErr, asset_thumbnails, client, get_hedged, get_official, mirror};

const OUTFIT_TIMEOUT: Duration = Duration::from_secs(9);
const CLOTHING_TYPES: [i64; 12] = [2, 11, 12, 64, 65, 66, 67, 68, 69, 70, 71, 72];
const ACCESSORY_TYPES: [i64; 10] = [8, 41, 42, 43, 44, 45, 46, 47, 76, 77];

static SAVED: LazyLock<Ttl<Value>> = LazyLock::new(|| Ttl::new(2 * 60, 300));
static DETAILS: LazyLock<Ttl<Value>> = LazyLock::new(|| Ttl::new(5 * 60, 500));

/// Number(x) as a positive safe integer, for ids that arrive as numbers or numeric strings.
fn safe_id(v: &Value) -> Option<u64> {
    let n = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    (n.fract() == 0.0 && n > 0.0 && n <= 9_007_199_254_740_991.0).then_some(n as u64)
}

fn trimmed_name(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Only user-created avatar fits (editable, outfitType Avatar), de-duplicated.
pub fn normalize_saved_outfits(data: &Value) -> Vec<Value> {
    let mut seen = HashSet::new();
    data.as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = safe_id(&entry["id"])?;
            // JS: `entry.outfitType && entry.outfitType !== 'Avatar'` rejects.
            let kind = &entry["outfitType"];
            let truthy = match kind {
                Value::Null => false,
                Value::Bool(b) => *b,
                Value::Number(n) => n.as_f64() != Some(0.0),
                Value::String(s) => !s.is_empty(),
                _ => true,
            };
            let avatar = !truthy || kind == "Avatar";
            if seen.contains(&id) || entry["isEditable"] != true || !avatar {
                return None;
            }
            seen.insert(id);
            let name = trimmed_name(&entry["name"]).unwrap_or_else(|| format!("Fit #{id}"));
            Some(json!({ "id": id, "name": name, "thumbnailUrl": null }))
        })
        .collect()
}

/// Wearable clothing, accessories and gear of an outfit; body parts and animations are skipped.
pub fn normalize_saved_outfit_assets(data: &Value) -> Vec<Value> {
    let mut seen = HashSet::new();
    data.as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = safe_id(&entry["id"])?;
            let type_id = safe_id(&entry["assetType"]["id"])
                .map(|t| t as i64)
                .unwrap_or(0);
            let kind = if CLOTHING_TYPES.contains(&type_id) {
                "clothing"
            } else if ACCESSORY_TYPES.contains(&type_id) {
                "accessory"
            } else if type_id == 19 {
                "gear"
            } else {
                return None;
            };
            if !seen.insert(id) {
                return None;
            }
            Some(json!({
                "id": id,
                "name": trimmed_name(&entry["name"]).unwrap_or_else(|| format!("Item #{id}")),
                "assetTypeName": entry["assetType"]["name"].as_str().unwrap_or(""),
                "kind": kind,
                "thumbnailUrl": null,
            }))
        })
        .collect()
}

pub async fn saved_outfits(user_id: u64, page_token: &str) -> Result<Value, UpErr> {
    let key = format!("{user_id}:{page_token}");
    if let Some(hit) = SAVED.get(&key) {
        return Ok(hit);
    }
    let mut url = url::Url::parse(&format!(
        "https://avatar.roblox.com/v2/avatar/users/{user_id}/outfits"
    ))
    .unwrap();
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("outfitType", "Avatar")
            .append_pair("isEditable", "true")
            .append_pair("itemsPerPage", "50");
        if !page_token.is_empty() {
            qp.append_pair("paginationToken", page_token);
        }
    }
    let data = get_official(client(), url.as_str(), OUTFIT_TIMEOUT).await?;
    if !data["data"].is_array() {
        return Err(UpErr::network());
    }
    let mut outfits = normalize_saved_outfits(&data["data"]);
    let next = data["paginationToken"].as_str().filter(|t| !t.is_empty());

    let mut pending = false;
    if !outfits.is_empty() {
        let mut images = std::collections::HashMap::new();
        let mut waiting: Vec<u64> = outfits.iter().filter_map(|o| o["id"].as_u64()).collect();
        // Roblox renders outfit thumbnails lazily ("Pending"); ask once more for those after a short wait.
        for attempt in 0..2 {
            if waiting.is_empty() {
                break;
            }
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(800)).await;
            }
            let list = waiting
                .iter()
                .map(u64::to_string)
                .collect::<Vec<_>>()
                .join(",");
            let thumbs = format!(
                "https://thumbnails.roblox.com/v1/users/outfits?userOutfitIds={list}&size=420x420&format=Webp&isCircular=false"
            );
            let Ok(answer) = get_hedged(
                client(),
                [&thumbs, &mirror(&thumbs)],
                Duration::from_secs(8),
            )
            .await
            else {
                // Names and ids still work when thumbnails are blocked; no image is shown, like Node.
                pending = true;
                images.clear();
                waiting.clear();
                break;
            };
            waiting.clear();
            for image in answer["data"].as_array().into_iter().flatten() {
                let Some(id) = image["targetId"].as_u64() else {
                    continue;
                };
                match (image["state"].as_str(), image["imageUrl"].as_str()) {
                    (Some("Completed"), Some(u)) if u.starts_with("https://") => {
                        images.insert(id, u.to_string());
                    }
                    (Some("Pending"), _) => waiting.push(id),
                    _ => {}
                }
            }
        }
        pending |= !waiting.is_empty();
        for outfit in &mut outfits {
            let image = outfit["id"]
                .as_u64()
                .and_then(|id| images.get(&id).cloned());
            outfit["thumbnailUrl"] = json!(image);
        }
    }
    let result = json!({ "outfits": outfits, "nextPageToken": next });
    // Pending thumbnails: keep the answer only briefly so the next open picks up the rendered images.
    SAVED.set_for(
        key,
        result.clone(),
        Duration::from_secs(if pending { 10 } else { 120 }),
    );
    Ok(result)
}

pub async fn outfit_details(outfit_id: u64) -> Result<Value, UpErr> {
    let key = outfit_id.to_string();
    if let Some(hit) = DETAILS.get(&key) {
        return Ok(hit);
    }
    let data = get_official(
        client(),
        &format!("https://avatar.roblox.com/v3/outfits/{outfit_id}/details"),
        OUTFIT_TIMEOUT,
    )
    .await?;
    if !data["assets"].is_array() {
        return Err(UpErr::network());
    }
    let mut assets = normalize_saved_outfit_assets(&data["assets"]);
    if !assets.is_empty() {
        let ids: Vec<u64> = assets.iter().filter_map(|a| a["id"].as_u64()).collect();
        let images = asset_thumbnails(&ids).await;
        for asset in &mut assets {
            let image = asset["id"].as_u64().and_then(|id| images.get(&id).cloned());
            asset["thumbnailUrl"] = json!(image);
        }
    }
    let name = data["name"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| format!("Fit #{outfit_id}"));
    let result = json!({ "id": outfit_id, "name": name, "assets": assets });
    DETAILS.set(key, result.clone());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from tests/savedOutfits.test.ts.
    #[test]
    fn keeps_only_user_created_avatar_fits() {
        let fits = normalize_saved_outfits(&json!([
            { "id": 10, "name": "Street fit", "isEditable": true, "outfitType": "Avatar" },
            { "id": 11, "name": "Purchased bundle", "isEditable": false, "outfitType": "Avatar" },
            { "id": 12, "name": "Dynamic head", "isEditable": true, "outfitType": "DynamicHead" },
            { "id": 10, "name": "Duplicate", "isEditable": true, "outfitType": "Avatar" },
            { "id": 13, "name": "", "isEditable": true, "outfitType": "Avatar" },
        ]));
        assert_eq!(
            Value::Array(fits),
            json!([{ "id": 10, "name": "Street fit", "thumbnailUrl": null }, { "id": 13, "name": "Fit #13", "thumbnailUrl": null }])
        );
    }

    #[test]
    fn shows_wearable_clothing_and_accessories_without_body_parts_or_animations() {
        let assets = normalize_saved_outfit_assets(&json!([
            { "id": 1, "name": "Shirt", "assetType": { "id": 11, "name": "Shirt" } },
            { "id": 2, "name": "Layered sweater", "assetType": { "id": 68, "name": "SweaterAccessory" } },
            { "id": 3, "name": "Hat", "assetType": { "id": 8, "name": "Hat" } },
            { "id": 4, "name": "Head", "assetType": { "id": 79, "name": "DynamicHead" } },
            { "id": 5, "name": "Mood", "assetType": { "id": 78, "name": "MoodAnimation" } },
            { "id": 6, "name": "Torso", "assetType": { "id": 27, "name": "Torso" } },
        ]));
        let kinds: Vec<(Value, Value)> = assets
            .iter()
            .map(|a| (a["id"].clone(), a["kind"].clone()))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (json!(1), json!("clothing")),
                (json!(2), json!("clothing")),
                (json!(3), json!("accessory"))
            ]
        );
    }
}
