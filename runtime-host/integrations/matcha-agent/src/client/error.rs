use std::fmt;

use serde_json::Value;

use crate::protocol::wire::JsonRpcError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Delivery {
    NotSent,
    Unknown,
    ResponseReceived,
}

#[derive(Clone)]
pub struct Error {
    reason: Reason,
    delivery: Delivery,
}

#[derive(Clone)]
enum Reason {
    Local(&'static str),
    Remote(JsonRpcError),
}

impl Error {
    pub(super) fn local(kind: &'static str, delivery: Delivery) -> Self {
        Self {
            reason: Reason::Local(kind),
            delivery,
        }
    }

    pub(super) fn remote(error: JsonRpcError) -> Self {
        Self {
            reason: Reason::Remote(error),
            delivery: Delivery::ResponseReceived,
        }
    }

    pub(super) fn with_delivery(mut self, delivery: Delivery) -> Self {
        self.delivery = delivery;
        self
    }

    pub fn code(&self) -> Option<i64> {
        match &self.reason {
            Reason::Local(_) => None,
            Reason::Remote(error) => Some(error.code),
        }
    }

    pub fn kind(&self) -> &str {
        match &self.reason {
            Reason::Local(kind) => kind,
            Reason::Remote(error) => error.kind(),
        }
    }

    pub fn data(&self) -> Option<&Value> {
        match &self.reason {
            Reason::Local(_) => None,
            Reason::Remote(error) => error.data(),
        }
    }

    pub fn delivery(&self) -> Delivery {
        self.delivery
    }

    pub fn is_cancelled(&self) -> bool {
        matches!(self.reason, Reason::Local("cancelled"))
    }
}

impl fmt::Debug for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut output = formatter.debug_struct("Error");
        match &self.reason {
            Reason::Local(kind) => output.field("kind", kind),
            // A remote kind is untrusted data too; only explicit adapters read it.
            Reason::Remote(error) => output
                .field("remote_code", &error.code)
                .field("has_data", &error.data().is_some()),
        };
        output.field("delivery", &self.delivery).finish()
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.reason {
            Reason::Remote(_) => formatter.write_str("Matcha App Server rejected the operation"),
            Reason::Local(kind) => write!(formatter, "Matcha App Server transport: {kind}"),
        }
    }
}

impl std::error::Error for Error {}
