use serde::Serialize;
use serde_json::{Map, Value};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct ChannelCatalogEntry {
    pub(crate) id: String,
    pub(crate) label: String,
    #[serde(rename = "detailLabel")]
    pub(crate) detail_label: String,
    #[serde(rename = "systemImage", skip_serializing_if = "Option::is_none")]
    pub(crate) system_image: Option<String>,
    pub(crate) configured: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct ChannelCatalog {
    pub(crate) entries: Vec<ChannelCatalogEntry>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChannelConfigureOutcome {
    Confirmed,
    TargetRejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChannelConfigureFieldKind {
    Text,
    Password,
    Boolean,
    Number,
    Select,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct ChannelConfigureField {
    pub(crate) key: String,
    pub(crate) label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    pub(crate) kind: ChannelConfigureFieldKind,
    pub(crate) required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) options: Option<Vec<String>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct ChannelConfigureForm {
    pub(crate) fields: Vec<ChannelConfigureField>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ChannelConfigureFormOutcome {
    Form(ChannelConfigureForm),
    TargetRejected,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ChannelCatalogOutcome {
    Catalog(ChannelCatalog),
    Rejected,
    Unknown,
}

pub(crate) fn parse_patch(bytes: Zeroizing<Vec<u8>>) -> Result<Map<String, Value>, ()> {
    parse_values(bytes)
}

fn parse_values(mut bytes: Zeroizing<Vec<u8>>) -> Result<Map<String, Value>, ()> {
    let parsed = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| match value {
            Value::Object(object) if !object.is_empty() => Some(object),
            _ => None,
        });
    bytes.zeroize();
    parsed.ok_or(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_values_rejects_empty_or_non_object_payloads() {
        assert!(parse_values(Zeroizing::new(b"{}".to_vec())).is_err());
        assert!(parse_values(Zeroizing::new(b"[]".to_vec())).is_err());
        assert!(parse_values(Zeroizing::new(b"null".to_vec())).is_err());
        assert!(parse_values(Zeroizing::new(Vec::new())).is_err());
    }

    #[test]
    fn parse_values_accepts_non_empty_object_and_returns_its_keys() {
        let values = parse_values(Zeroizing::new(br#"{"apiKey":"secret"}"#.to_vec()))
            .expect("object values");
        assert_eq!(
            values.get("apiKey"),
            Some(&Value::String("secret".to_owned()))
        );
    }

    #[test]
    fn empty_source_backed_form_serializes_as_empty_fields() {
        let form = ChannelConfigureForm { fields: Vec::new() };
        assert_eq!(
            serde_json::to_value(form).unwrap(),
            serde_json::json!({"fields": []})
        );
    }
}
