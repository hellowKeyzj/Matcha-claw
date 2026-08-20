use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use super::{MediaHandle, ResolvedWorkspaceMedia};

const ENTRY_TTL: Duration = Duration::from_secs(30);
const MAX_ENTRIES: usize = 64;

pub(super) struct MediaStore {
    entries: Mutex<HashMap<(String, MediaHandle), Entry>>,
}

struct Entry {
    content: Vec<u8>,
    expires_at: Instant,
}

impl MediaStore {
    pub(super) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub(super) fn insert(
        &self,
        session_key: &str,
        handle: MediaHandle,
        content: Vec<u8>,
    ) -> Result<(), ()> {
        let mut entries = self.entries.lock().map_err(|_| ())?;
        let now = Instant::now();
        entries.retain(|_, entry| entry.expires_at > now);
        if entries.len() == MAX_ENTRIES
            && let Some(key) = entries.keys().next().cloned()
        {
            entries.remove(&key);
        }
        entries.insert(
            (session_key.to_owned(), handle),
            Entry {
                content,
                expires_at: now + ENTRY_TTL,
            },
        );
        Ok(())
    }

    pub(super) fn take(
        &self,
        session_key: &str,
        handle: &MediaHandle,
    ) -> Option<ResolvedWorkspaceMedia> {
        let mut entries = self.entries.lock().ok()?;
        let entry = entries.remove(&(session_key.to_owned(), handle.clone()))?;
        (entry.expires_at > Instant::now()).then_some(ResolvedWorkspaceMedia {
            content: entry.content,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_reports_a_poisoned_store_lock() {
        let store = MediaStore::new();
        let _ = std::panic::catch_unwind(|| {
            let _guard = store.entries.lock().expect("store lock must start healthy");
            panic!("poison media store lock");
        });

        let handle = MediaHandle("media_0123456789abcdef0123456789abcdef".to_owned());
        assert!(store.insert("agent:main:session", handle, vec![1]).is_err());
    }
}
