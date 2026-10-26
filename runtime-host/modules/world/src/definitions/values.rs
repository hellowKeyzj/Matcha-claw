pub(crate) use world_protocol::value::{validate_value, validate_value_type};
use world_protocol::{ids::ResourceRef, value::Value};

pub(crate) fn value_resources(value: &Value, result: &mut Vec<ResourceRef>) {
    let mut values = vec![value];
    while let Some(value) = values.pop() {
        match value {
            Value::Object { id } => result.push(ResourceRef::Object { id: id.clone() }),
            Value::Relation { id } => result.push(ResourceRef::Relation { id: id.clone() }),
            Value::List { items } => values.extend(items),
            Value::Record { fields } => values.extend(fields.values()),
            _ => {}
        }
    }
}
