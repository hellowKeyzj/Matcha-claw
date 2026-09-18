use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidOrganizationReference {
    kind: &'static str,
}

impl fmt::Display for InvalidOrganizationReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} reference must not be blank", self.kind)
    }
}

impl std::error::Error for InvalidOrganizationReference {}

macro_rules! reference {
    ($name:ident, $kind:literal) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidOrganizationReference> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err(InvalidOrganizationReference { kind: $kind });
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

reference!(ManagedAgentReference, "managed agent");
reference!(RuntimeEndpointReference, "runtime endpoint");
reference!(EndpointSessionId, "endpoint session");
reference!(SessionWindowReference, "session window");
reference!(DeliveryReference, "delivery");
reference!(IdempotencyKey, "idempotency key");
reference!(DeliveryReceiptReference, "delivery receipt");
reference!(LeaseReference, "lease");
