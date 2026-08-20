use matcha_agent::session::history::HistoryCatalog;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Session {
    pub(crate) endpoint_session_id: String,
    pub(crate) updated_at: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Listed(Vec<Session>),
    Unavailable,
}

pub(crate) fn project(catalog: HistoryCatalog) -> Vec<Session> {
    catalog
        .sessions()
        .iter()
        .map(|session| Session {
            endpoint_session_id: session.session_id().as_str().to_owned(),
            updated_at: None,
        })
        .collect()
}
