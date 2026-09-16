use matcha_agent::session::history::local::LocalHistoryCatalog;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Session {
    pub(crate) endpoint_session_id: String,
    pub(crate) updated_at: Option<u64>,
}

impl Session {
    pub(crate) fn endpoint_session_id(&self) -> &str {
        &self.endpoint_session_id
    }

    pub(crate) const fn updated_at(&self) -> Option<u64> {
        self.updated_at
    }

    #[cfg(test)]
    pub(crate) fn test_only(endpoint_session_id: String, updated_at: Option<u64>) -> Self {
        Self {
            endpoint_session_id,
            updated_at,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Listed(Vec<Session>),
    Unavailable,
}

pub(crate) fn project_local(catalog: LocalHistoryCatalog) -> Vec<Session> {
    catalog
        .sessions()
        .iter()
        .map(|session| Session {
            endpoint_session_id: session.session_id().as_str().to_owned(),
            updated_at: session.updated_at(),
        })
        .collect()
}
