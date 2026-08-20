use std::fmt;

macro_rules! define_topology_identity {
    ($name:ident, $invalid_name:ident, $label:literal) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            pub fn try_new(value: impl Into<String>) -> Result<Self, $invalid_name> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err($invalid_name);
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct $invalid_name;

        impl fmt::Display for $invalid_name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(concat!($label, " must not be empty"))
            }
        }

        impl std::error::Error for $invalid_name {}
    };
}

define_topology_identity!(NodeId, InvalidNodeId, "node ID");
define_topology_identity!(WorkloadId, InvalidWorkloadId, "workload ID");
define_topology_identity!(RuntimeId, InvalidRuntimeId, "runtime ID");
