use serde::Serialize;

/// Encodes a typed public value in its canonical JSON wire form.
///
/// Callers must use typed DTOs with a fixed field order. This avoids accepting
/// unordered caller-provided objects as identity keys.
pub fn encode<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("canonical public DTOs must serialize")
}

#[cfg(test)]
mod tests {
    use serde::Serialize;

    use super::encode;

    #[derive(Serialize)]
    struct Vector<'a> {
        #[serde(rename = "type")]
        wire_type: &'a str,
        kind: &'a str,
    }

    #[test]
    fn preserves_declared_wire_field_order() {
        assert_eq!(
            encode(&Vector {
                wire_type: "runtime-scope",
                kind: "app",
            }),
            r#"{"type":"runtime-scope","kind":"app"}"#
        );
    }
}
