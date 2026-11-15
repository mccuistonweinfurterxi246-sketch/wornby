//! Outfit archive: the live part (inventory privacy + every saved outfit). The history part comes
//! from Wayback snapshots (wayback.rs); the browser merges both and keeps its own captures.

use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{Value, json};

use crate::outfits::saved_outfits;
use crate::upstream::{Ttl, UpErr, client, get_official};

// A player with thousands of outfits still lists in under ~40 pages of 50.
const MAX_PAGES: usize = 40;
static PRIVACY: LazyLock<Ttl<&'static str>> = LazyLock::new(|| Ttl::new(10 * 60, 5000));

/// "public", "private" or "unknown" (check failed). Outfits are shown only when "public".
pub async fn privacy(uid: u64) -> &'static str {
    let key = uid.to_string();
    if let Some(hit) = PRIVACY.get(&key) {
        return hit;
    }
    let url = format!("https://inventory.roblox.com/v1/users/{uid}/can-view-inventory");
    let state = match get_official(client(), &url, Duration::from_secs(6)).await {
        Ok(v) if v["canView"] == true => "public",
        Ok(v) if v["canView"] == false => "private",
        _ => return "unknown",
    };
    PRIVACY.set(key, state);
    state
}

/// Every user-made outfit currently listed (all pages, thumbnails included), or none when private.
pub async fn live(uid: u64) -> Result<Value, UpErr> {
    let inventory = privacy(uid).await;
    let mut outfits: Vec<Value> = Vec::new();
    let mut complete = true;
    if inventory != "private" {
        let mut token = String::new();
        for page in 0..MAX_PAGES {
            match saved_outfits(uid, &token).await {
                Ok(v) => {
                    outfits.extend(v["outfits"].as_array().cloned().unwrap_or_default());
                    match v["nextPageToken"]
                        .as_str()
                        .filter(|t| !t.is_empty() && *t != token)
                    {
                        Some(t) => token = t.to_string(),
                        None => break,
                    }
                }
                Err(e) if page == 0 => return Err(e),
                // Keep the pages that loaded; the client shows the archive as incomplete.
                Err(_) => {
                    complete = false;
                    break;
                }
            }
            if page + 1 == MAX_PAGES {
                complete = false;
            }
        }
    }
    Ok(json!({ "inventory": inventory, "outfits": outfits, "complete": complete }))
}
