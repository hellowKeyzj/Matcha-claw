use serde::Serialize;
use serde_json::{Map, Value};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ChannelCatalogEntry {
    pub id: String,
    pub label: String,
    #[serde(rename = "detailLabel")]
    pub detail_label: String,
    #[serde(rename = "systemImage", skip_serializing_if = "Option::is_none")]
    pub system_image: Option<String>,
    pub configured: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ChannelCatalog {
    pub entries: Vec<ChannelCatalogEntry>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelConfigureOutcome {
    Confirmed,
    TargetRejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelConfigureFieldKind {
    Text,
    Password,
    Boolean,
    Number,
    Select,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ChannelConfigureField {
    pub key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub kind: ChannelConfigureFieldKind,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ChannelConfigureForm {
    pub fields: Vec<ChannelConfigureField>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelConfigureFormOutcome {
    Form(ChannelConfigureForm),
    TargetRejected,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelCatalogOutcome {
    Catalog(ChannelCatalog),
    Rejected,
    Unknown,
}

pub fn parse_patch(bytes: Zeroizing<Vec<u8>>) -> Result<Map<String, Value>, ()> {
    parse_values(bytes)
}

fn parse_values(mut bytes: Zeroizing<Vec<u8>>) -> Result<Map<String, Value>, ()> {
    let parsed = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| match value {
            Value::Object(object) => Some(object),
            _ => None,
        });
    bytes.zeroize();
    parsed.ok_or(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_patch_rejects_invalid_or_non_object_payloads() {
        for bytes in [
            b"[]".as_slice(),
            b"null",
            b"true",
            b"1",
            b"\"text\"",
            b"{",
            b"",
        ] {
            assert!(parse_patch(Zeroizing::new(bytes.to_vec())).is_err());
        }
    }

    #[test]
    fn parse_patch_accepts_empty_object() {
        assert!(
            parse_patch(Zeroizing::new(b"{}".to_vec()))
                .unwrap()
                .is_empty()
        );
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
