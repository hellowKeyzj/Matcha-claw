use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiRevision {
    id: String,
    size: u64,
    modified_at_ms: u64,
}

impl WikiRevision {
    pub fn new(id: String, size: u64, modified_at_ms: u64) -> Self {
        Self {
            id,
            size,
            modified_at_ms,
        }
    }

    pub fn for_bytes(bytes: &[u8], modified_at_ms: u64) -> Self {
        Self {
            id: stable_content_hash(bytes),
            size: bytes.len() as u64,
            modified_at_ms,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub const fn size(&self) -> u64 {
        self.size
    }

    pub const fn modified_at_ms(&self) -> u64 {
        self.modified_at_ms
    }
}

pub fn now_ms() -> u64 {
    system_time_ms(SystemTime::now())
}

pub fn system_time_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

pub fn stable_content_hash(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
