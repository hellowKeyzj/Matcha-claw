const BEARER_PREFIX: &str = "Bearer ";

pub(crate) fn bearer_token(authorization: Option<&str>) -> Option<&str> {
    authorization
        .and_then(|value| value.strip_prefix(BEARER_PREFIX))
        .filter(|value| !value.is_empty())
}

pub(crate) struct Request {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) authorization: Option<String>,
    pub(crate) trace_id: Option<String>,
    pub(crate) body: Vec<u8>,
}
