#[derive(Clone, Debug, PartialEq)]
pub struct UsageEntry {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: Option<f64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UsageReadError {
    Unavailable,
}
