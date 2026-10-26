//! The one World JSON codec. All domain u64/i64 fields use decimal strings; bytes remain arrays.
use serde::{
    Deserialize, Serialize,
    de::{DeserializeOwned, DeserializeSeed, MapAccess, SeqAccess, Visitor},
};
use std::{collections::BTreeSet, fmt};

pub const MAX_DEPTH: usize = 64;
#[derive(Debug)]
pub enum CodecFailure {
    SizeLimit,
    DepthLimit,
    DuplicateKey,
    JsonSyntax { line: usize, column: usize },
    UnexpectedEof { line: usize, column: usize },
    ContractData { line: usize, column: usize },
    Encode,
}
impl fmt::Display for CodecFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::SizeLimit => "world frame exceeds its byte limit",
            Self::DepthLimit => "world frame exceeds its depth limit",
            Self::DuplicateKey => "world frame contains a duplicate key",
            Self::JsonSyntax { .. } => "world frame has invalid JSON syntax",
            Self::UnexpectedEof { .. } => "world frame is incomplete",
            Self::ContractData { .. } => "world frame does not match its contract",
            Self::Encode => "world frame could not be encoded",
        })
    }
}
impl std::error::Error for CodecFailure {}

struct StrictSeed<'a> {
    depth: usize,
    violation: &'a std::cell::Cell<Option<Violation>>,
}
#[derive(Clone, Copy)]
enum Violation {
    Depth,
    Duplicate,
}
impl<'de> DeserializeSeed<'de> for StrictSeed<'_> {
    type Value = serde_json::Value;
    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        if self.depth == 0 {
            self.violation.set(Some(Violation::Depth));
            return Err(serde::de::Error::custom("depth limit"));
        }
        deserializer.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for StrictSeed<'_> {
    type Value = serde_json::Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded strict JSON")
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(serde_json::Value::Null)
    }
    fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(serde_json::Value::Null)
    }
    fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Self::Value, E> {
        Ok(v.into())
    }
    fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
        Ok(v.into())
    }
    fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
        Ok(v.into())
    }
    fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
        serde_json::Number::from_f64(v)
            .map(serde_json::Value::Number)
            .ok_or_else(|| E::custom("invalid number"))
    }
    fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(v.into())
    }
    fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Self::Value, E> {
        Ok(v.into())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = access.next_element_seed(StrictSeed {
            depth: self.depth - 1,
            violation: self.violation,
        })? {
            values.push(value);
        }
        Ok(values.into())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
        let mut keys = BTreeSet::new();
        let mut values = serde_json::Map::new();
        while let Some(key) = access.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                self.violation.set(Some(Violation::Duplicate));
                return Err(serde::de::Error::custom("duplicate key"));
            }
            let value = access.next_value_seed(StrictSeed {
                depth: self.depth - 1,
                violation: self.violation,
            })?;
            values.insert(key, value);
        }
        Ok(values.into())
    }
}
pub fn decode<T: DeserializeOwned>(bytes: &[u8], maximum: usize) -> Result<T, CodecFailure> {
    if bytes.len() > maximum {
        return Err(CodecFailure::SizeLimit);
    }
    let violation = std::cell::Cell::new(None);
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = StrictSeed {
        depth: MAX_DEPTH,
        violation: &violation,
    }
    .deserialize(&mut deserializer)
    .map_err(|e| match violation.get() {
        Some(Violation::Depth) => CodecFailure::DepthLimit,
        Some(Violation::Duplicate) => CodecFailure::DuplicateKey,
        None => classify(&e),
    })?;
    deserializer.end().map_err(|e| classify(&e))?;
    serde_json::from_value(value).map_err(|e| classify(&e))
}
pub fn encode<T: Serialize>(value: &T, maximum: usize) -> Result<Vec<u8>, CodecFailure> {
    let bytes = serde_json::to_vec(value).map_err(|_| CodecFailure::Encode)?;
    if bytes.len() > maximum {
        return Err(CodecFailure::SizeLimit);
    }
    Ok(bytes)
}
fn classify(e: &serde_json::Error) -> CodecFailure {
    match e.classify() {
        serde_json::error::Category::Syntax => CodecFailure::JsonSyntax {
            line: e.line(),
            column: e.column(),
        },
        serde_json::error::Category::Eof => CodecFailure::UnexpectedEof {
            line: e.line(),
            column: e.column(),
        },
        _ => CodecFailure::ContractData {
            line: e.line(),
            column: e.column(),
        },
    }
}

macro_rules! decimal_codec {
    ($name:ident, $optional:ident, $ty:ty) => {
        pub mod $name {
            use super::*;
            pub fn serialize<S: serde::Serializer>(
                value: &$ty,
                serializer: S,
            ) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&value.to_string())
            }
            pub fn deserialize<'de, D: serde::Deserializer<'de>>(
                deserializer: D,
            ) -> Result<$ty, D::Error> {
                let text = String::deserialize(deserializer)?;
                let value: $ty = text
                    .parse()
                    .map_err(|_| serde::de::Error::custom("invalid decimal integer"))?;
                if value.to_string() != text {
                    return Err(serde::de::Error::custom("noncanonical decimal integer"));
                }
                Ok(value)
            }
        }
        pub mod $optional {
            use super::*;
            pub fn serialize<S: serde::Serializer>(
                value: &Option<$ty>,
                serializer: S,
            ) -> Result<S::Ok, S::Error> {
                value.map(|v| v.to_string()).serialize(serializer)
            }
            pub fn deserialize<'de, D: serde::Deserializer<'de>>(
                deserializer: D,
            ) -> Result<Option<$ty>, D::Error> {
                Option::<String>::deserialize(deserializer)?
                    .map(|text| {
                        let value: $ty = text
                            .parse()
                            .map_err(|_| serde::de::Error::custom("invalid decimal integer"))?;
                        if value.to_string() != text {
                            return Err(serde::de::Error::custom("noncanonical decimal integer"));
                        }
                        Ok(value)
                    })
                    .transpose()
            }
        }
    };
}
decimal_codec!(u64_decimal, optional_u64_decimal, u64);
decimal_codec!(i64_decimal, optional_i64_decimal, i64);
