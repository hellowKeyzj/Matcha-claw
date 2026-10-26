mod admission;
mod authority;
mod commit;
mod configure;
mod derived;
mod evaluation;
mod evaluation_install;
mod grant;
mod ingress;
mod investigation;
mod maintenance;
mod native;
mod online;
mod permit;
mod policies;
mod prepared;
mod read;
mod retention;
mod scope;
mod state;

pub(crate) use admission::{
    Admission, admit, check_admitted_output, check_admitted_output_read, check_impact_read,
    check_impact_read_decision,
    check_impact_read_output, check_output, check_output_read, check_state_output_read, recheck,
    recheck_read, refresh_state, read_recovery_admit,
};
pub(crate) use authority::{ApprovalRecord, Revoke, approve};
pub use authority::{AuthorityRoot, PrincipalRecord};
pub(crate) use commit::{AdmissionCommit, commit_admission};
pub(crate) use configure::{configure_policy, configure_retention};
pub(crate) use derived::{action_approval, derive_action, derive_action_recovery};
pub(crate) use evaluation::{EvaluationBinding, require_evaluation_execution_model};
pub use evaluation::{EvaluationAuthority, EvaluationPrincipal, InitialEvaluation};
pub use evaluation_install::{EvaluationGrant, EvaluationRecipient, InstallEvaluation};
pub(crate) use evaluation_install::{InstalledEvaluation, backfill_evaluation, install_evaluation, installation_digest, read_evaluation, reserve_evaluation};
pub use grant::GrantRequest;
pub(crate) use grant::grant_access;
pub(crate) use ingress::{
    NativeContext, RequestBinding, RestartIdentity, ServiceIngress, VerifiedInvocation,
};
pub use investigation::InvestigationBinding;
pub(crate) use investigation::{InvestigationWork, mint_investigation, mint_investigation_recovery};
pub use maintenance::{InitialMaintenance, MaintenanceAuthority};
pub(crate) use maintenance::MaintenanceVerification;
pub(crate) use native::NativeIngress;
pub use native::{
    NativeClaims, NativeFacts, NativeProof, NativeProofIssuer, NativeRequester,
    NativeVerificationError, NativeVerifier, NativeWorldInvestigation,
};
pub(crate) use online::OnlineOracleBinding;
pub(crate) use permit::{
    AuthorizedEffect, EffectBinding, EffectPermit, PermitConsumption, consume_permit,
    effect_digests, issue_permit,
};
pub use policies::{InitialPolicy, InitialRetention};
pub(crate) use policies::{
    MaterialPolicies, case_read_impact, material_policies, material_read, material_read_impact,
    material_read_impact_snapshot, material_scopes, policy_reference, require_case_policies,
    require_material_policies, source_capture_impact, source_capture_policy,
    source_directory_impact,
};
pub(crate) use prepared::PreparedPolicy;
pub(crate) use retention::world_deletion_roots;
pub(crate) use scope::{AccessGrant, actual_impact};
pub use world_protocol::authorization::PolicyRule;

use crate::store::StoreError;
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest as _, Sha256};
use std::fmt;
use world_protocol::{
    authorization::{Actor, AuthorizationFailure},
    ids::{ActorId, Digest},
    time::Timestamp,
};

pub(crate) enum AuthError {
    Denied(AuthorizationFailure),
    Store(StoreError),
    Codec(serde_json::Error),
}

impl From<AuthorizationFailure> for AuthError {
    fn from(reason: AuthorizationFailure) -> Self {
        Self::Denied(reason)
    }
}
impl From<StoreError> for AuthError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Denied(_) => f.write_str("world.authorization_denied"),
            Self::Store(error) => error.fmt(f),
            Self::Codec(_) => f.write_str("world.authorization_internal_fault"),
        }
    }
}
impl fmt::Debug for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Denied(reason) => f.debug_tuple("Authorization").field(reason).finish(),
            Self::Store(error) => error.fmt(f),
            Self::Codec(_) => f.write_str("AuthorizationCodecError"),
        }
    }
}
impl std::error::Error for AuthError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Store(error) => Some(error),
            Self::Codec(error) => Some(error),
            Self::Denied(_) => None,
        }
    }
}

pub(crate) fn actor_id(actor: &Actor) -> &ActorId {
    match actor {
        Actor::Human { id } | Actor::Service { id } => id,
    }
}
fn actor_kind(actor: &Actor) -> &'static str {
    match actor {
        Actor::Human { .. } => "human",
        Actor::Service { .. } => "service",
    }
}
fn encode(value: &impl Serialize) -> Result<serde_json::Value, AuthError> {
    serde_json::to_value(value).map_err(AuthError::Codec)
}
fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, AuthError> {
    serde_json::from_value(value).map_err(AuthError::Codec)
}
fn digest(value: &impl Serialize) -> Result<Digest, AuthError> {
    let bytes = serde_json::to_vec(value).map_err(AuthError::Codec)?;
    bytes_digest(&bytes)
}
fn bytes_digest(bytes: &[u8]) -> Result<Digest, AuthError> {
    Digest::try_new(format!("sha256:{:x}", Sha256::digest(bytes)))
        .map_err(|_| AuthorizationFailure::InternalFault.into())
}
fn timestamp(millis: i64) -> Result<Timestamp, AuthError> {
    let instant = chrono::DateTime::from_timestamp_millis(millis)
        .ok_or(AuthorizationFailure::InternalFault)?;
    Timestamp::try_new(instant.to_rfc3339()).map_err(|_| AuthorizationFailure::InternalFault.into())
}
fn expiry(row: &tokio_postgres::Row) -> Result<Option<Timestamp>, AuthError> {
    row.try_get::<_, Option<i64>>("expires_ms")
        .map_err(|_| AuthorizationFailure::InternalFault)?
        .map(timestamp)
        .transpose()
}
fn active(
    row: &tokio_postgres::Row,
    now: &Timestamp,
    failure: AuthorizationFailure,
) -> Result<Option<Timestamp>, AuthError> {
    let until = expiry(row)?;
    if !row
        .try_get::<_, bool>("active")
        .map_err(|_| AuthorizationFailure::InternalFault)?
        || until.as_ref().is_some_and(|until| until <= now)
    {
        return Err(failure.into());
    }
    Ok(until)
}
fn cap_expiry(current: &mut Timestamp, until: Option<Timestamp>) {
    if let Some(until) = until {
        if until < *current {
            *current = until;
        }
    }
}
