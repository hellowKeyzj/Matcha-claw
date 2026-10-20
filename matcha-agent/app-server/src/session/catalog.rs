use std::{collections::BTreeMap, ops::Bound, sync::Arc};

use crate::rpc;

use super::Session;

#[derive(Default)]
pub(super) struct Catalog {
    by_id: BTreeMap<String, Entry>,
    by_created: BTreeMap<(u64, String), Arc<Session>>,
    by_agent: BTreeMap<String, BTreeMap<(u64, String), Arc<Session>>>,
}

struct Entry {
    created_at_ms: u64,
    agent_id: String,
    session: Arc<Session>,
}

impl Catalog {
    pub fn get(&self, session_id: &str) -> Option<&Arc<Session>> {
        self.by_id.get(session_id).map(|entry| &entry.session)
    }

    pub fn values(&self) -> impl Iterator<Item = &Arc<Session>> {
        self.by_id.values().map(|entry| &entry.session)
    }

    pub fn insert(
        &mut self,
        session_id: String,
        created_at_ms: u64,
        agent_id: String,
        session: Arc<Session>,
    ) {
        self.remove(&session_id);
        // Identity, creation time and Agent never change during a Session's life.
        // All indexes share the sessions lock; mutable Records stay in Execution.
        let key = (created_at_ms, session_id.clone());
        self.by_created.insert(key.clone(), session.clone());
        self.by_agent
            .entry(agent_id.clone())
            .or_default()
            .insert(key, session.clone());
        self.by_id.insert(
            session_id,
            Entry {
                created_at_ms,
                agent_id,
                session,
            },
        );
    }

    pub fn remove(&mut self, session_id: &str) {
        let Some(entry) = self.by_id.remove(session_id) else {
            return;
        };
        let key = (entry.created_at_ms, session_id.to_owned());
        self.by_created.remove(&key);
        let agent = self
            .by_agent
            .get_mut(&entry.agent_id)
            .expect("indexed session Agent");
        agent.remove(&key);
        if agent.is_empty() {
            self.by_agent.remove(&entry.agent_id);
        }
    }

    pub fn page(
        &self,
        agent_id: Option<&str>,
        before_session_id: Option<&str>,
        limit: usize,
    ) -> rpc::Result<Vec<Arc<Session>>> {
        // Resolve against all managed Sessions, even for an Agent-filtered page.
        let before = match before_session_id {
            Some(id) => {
                let entry = self
                    .by_id
                    .get(id)
                    .ok_or_else(|| rpc::Error::not_found("Session cursor"))?;
                Bound::Excluded((entry.created_at_ms, id.to_owned()))
            }
            None => Bound::Unbounded,
        };
        let ordered = match agent_id {
            Some(id) => match self.by_agent.get(id) {
                Some(ordered) => ordered,
                None => return Ok(Vec::new()),
            },
            None => &self.by_created,
        };
        Ok(ordered
            .range((Bound::Unbounded, before))
            .rev()
            .take(limit)
            .map(|(_, session)| session.clone())
            .collect())
    }
}
