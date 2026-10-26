mod investigation;
mod projection;
mod verify;

pub(crate) use projection::PROJECTION_ENV;
pub use projection::{ProjectionError, WorldRuntimeHost};
pub use verify::{VerificationFailure, Verifier};

pub fn schema() -> Result<Vec<u8>, world_protocol::schema::SchemaFailure> {
    world_protocol::schema::public_api()
}
