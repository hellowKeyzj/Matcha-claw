use environment::ProviderAccount;

const MINIMAX_PORTAL_PROVIDER_KEY: &str = "minimax-portal";
const ZAI_PROVIDER_KEY: &str = "zai";

pub(crate) fn base_provider_key(account: &ProviderAccount) -> Option<String> {
    let provider = account.provider().as_str().strip_prefix("provider:")?;
    Some(match provider {
        "minimax-portal-cn" => MINIMAX_PORTAL_PROVIDER_KEY.to_owned(),
        "zai-global" => ZAI_PROVIDER_KEY.to_owned(),
        "custom" | "ollama" => multi_instance_provider_key(provider, account.id().as_str()),
        _ => provider.to_owned(),
    })
}

pub(crate) fn is_single_slot_provider_key(provider_key: &str) -> bool {
    matches!(
        provider_key,
        ZAI_PROVIDER_KEY
            | "qianfan"
            | "stepfun"
            | "tencent-tokenhub"
            | "tencent-tokenplan"
            | "xiaomi"
            | "xiaomi-token-plan"
            | "qwen"
            | "qwen-token-plan"
            | "kimi"
            | "volcengine-plan"
            | "opencode"
            | "opencode-go"
            | "github-copilot"
    )
}

fn multi_instance_provider_key(provider: &str, provider_id: &str) -> String {
    if provider_id == provider {
        return provider.to_owned();
    }
    let suffix_source = provider_id
        .strip_prefix(provider)
        .and_then(|suffix| suffix.strip_prefix('-'))
        .unwrap_or(provider_id);
    let suffix = normalize_provider_key_part(suffix_source);
    let suffix = uuid_head(&suffix).unwrap_or(&suffix);
    let mut key = String::with_capacity(provider.len() + 1 + suffix.len());
    key.push_str(provider);
    key.push('-');
    key.push_str(suffix);
    key
}

fn normalize_provider_key_part(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' => {
                normalized.push(char::from(byte));
            }
            b'-' if !normalized.is_empty() && !normalized.ends_with('-') => {
                normalized.push('-');
            }
            _ => {}
        }
    }
    if normalized.ends_with('-') {
        normalized.pop();
    }
    normalized
}

fn uuid_head(value: &str) -> Option<&str> {
    let bytes = value.as_bytes();
    if bytes.len() >= 9
        && bytes[8] == b'-'
        && bytes[..8].iter().all(|byte| byte.is_ascii_hexdigit())
    {
        Some(&value[..8])
    } else {
        None
    }
}
