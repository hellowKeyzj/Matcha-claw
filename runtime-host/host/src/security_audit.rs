#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Query {
    pub(crate) page: u64,
    pub(crate) page_size: u64,
}

impl Query {
    pub(crate) fn new(page: u64, page_size: u64) -> Option<Self> {
        openclaw::operations::security_audit::SecurityAuditQuery::new(page, page_size)
            .map(|_| Self { page, page_size })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Item {
    pub(crate) ts: u64,
    pub(crate) tool_name: String,
    pub(crate) risk: String,
    pub(crate) action: String,
    pub(crate) decision: String,
    pub(crate) rule_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Receipt {
    pub(crate) page: u64,
    pub(crate) page_size: u64,
    pub(crate) total: u64,
    pub(crate) items: Vec<Item>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Observed(Receipt),
    Rejected,
    Unavailable,
    Unknown,
}
