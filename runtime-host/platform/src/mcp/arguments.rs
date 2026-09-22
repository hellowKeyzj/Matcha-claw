use serde_json::{Map, Value};

pub fn strict_object(value: Option<&Value>) -> Result<&Map<String, Value>, ()> {
    value.and_then(Value::as_object).ok_or(())
}

pub fn require_exact_keys(object: &Map<String, Value>, allowed: &[&str]) -> Result<(), ()> {
    object
        .keys()
        .all(|key| allowed.contains(&key.as_str()))
        .then_some(())
        .ok_or(())
}

pub fn require_required_keys(object: &Map<String, Value>, required: &[&str]) -> Result<(), ()> {
    required
        .iter()
        .all(|key| object.contains_key(*key))
        .then_some(())
        .ok_or(())
}

pub fn required_string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, ()> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(())
}

pub fn optional_string(object: &Map<String, Value>, key: &str) -> Result<Option<String>, ()> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        _ => Err(()),
    }
}

pub fn array<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a Vec<Value>, ()> {
    object
        .get(key)
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())
        .ok_or(())
}
