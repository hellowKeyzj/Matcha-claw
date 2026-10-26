mod investigation;
mod projection;
mod verify;

pub(crate) use projection::PROJECTION_ENV;
pub use projection::{ProjectionError, WorldRuntimeHost};
pub use verify::{NativeExecution, Requester, VerificationFailure, VerifiedCall, Verifier};

/// Tool parameters come from the actual World wire types, not a parallel plugin schema.
pub fn schema() -> Result<Vec<u8>, world_protocol::schema::SchemaFailure> {
    world_protocol::schema::public_api()
}
