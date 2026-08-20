use crate::secret_ref::FleetSecretRef;

pub enum FleetSecretResolution<S> {
    Resolved(S),
    AccessDenied,
    NotFound,
}

pub trait FleetSecretResolverPort {
    type Secret;
    type Error;

    fn resolve(
        &mut self,
        secret_ref: &FleetSecretRef,
    ) -> Result<FleetSecretResolution<Self::Secret>, Self::Error>;
}
