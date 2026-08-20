pub mod assembler;
pub mod events;
pub mod facts;
pub(crate) mod ingest;
pub mod operation;
pub mod projection;
pub mod protocol;

pub use projection::CanonicalIngressResult;
