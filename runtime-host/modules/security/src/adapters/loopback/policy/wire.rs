const BEARER_PREFIX: &str = "Bearer ";

pub fn bearer_token(authorization: Option<&str>) -> Option<&str> {
    authorization
        .and_then(|value| value.strip_prefix(BEARER_PREFIX))
        .filter(|value| !value.is_empty())
}

pub struct Request {
    pub method: String,
    pub path: String,
    pub authorization: Option<String>,
    pub trace_id: Option<String>,
    pub body: Vec<u8>,
}
