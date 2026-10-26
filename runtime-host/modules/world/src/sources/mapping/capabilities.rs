use world_protocol::sources::{
    ChangeStreamCapability, SourceCapabilities, SourceCapability, SourceFailure,
};

pub(super) fn require_change_stream(
    capabilities: &SourceCapabilities,
) -> Result<(), SourceFailure> {
    if capabilities.change_stream != ChangeStreamCapability::None {
        Ok(())
    } else {
        Err(SourceFailure::CapabilityMissing {
            capability: SourceCapability::ChangeStream,
        })
    }
}
