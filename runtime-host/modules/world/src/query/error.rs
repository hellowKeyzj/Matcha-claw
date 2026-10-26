use std::{error::Error, fmt};
use world_protocol::{query::QueryFailure, expression::ExpressionFailure, compiler::CompileFailure, failure::FailureStage, commit::CommitFailure};
use crate::{authorization::AuthError, store::StoreError};

pub(crate) enum QueryError {
    Rejected(QueryFailure), Store(StoreError), Authorization(AuthError),
    Identity(crate::identity::IdentityError), Source(crate::sources::connectors::SourceError),
    Mapping(crate::sources::mapping::MappingError), Sync(crate::sources::sync::SyncError),
    Release(Box<crate::releases::Error>), Definition(crate::definitions::DefinitionError),
    Fact(crate::facts::assertions::Error), Provenance(world_protocol::provenance::ProvenanceFailure),
    Invocation { failure: world_protocol::process::HostFailure, cause: Box<dyn Error + Send + Sync> },
}
impl From<QueryFailure> for QueryError { fn from(value: QueryFailure) -> Self { Self::Rejected(value) } }
impl From<StoreError> for QueryError { fn from(value: StoreError) -> Self { Self::Store(value) } }
impl From<AuthError> for QueryError { fn from(value: AuthError) -> Self { Self::Authorization(value) } }
impl From<ExpressionFailure> for QueryError { fn from(failure: ExpressionFailure) -> Self { QueryFailure::Expression { failure }.into() } }
impl From<CompileFailure> for QueryError { fn from(failure: CompileFailure) -> Self { QueryFailure::Compile { failure }.into() } }
impl From<crate::identity::IdentityError> for QueryError { fn from(value: crate::identity::IdentityError) -> Self { Self::Identity(value) } }
impl From<crate::sources::connectors::SourceError> for QueryError { fn from(value: crate::sources::connectors::SourceError) -> Self { Self::Source(value) } }
impl From<crate::sources::mapping::MappingError> for QueryError { fn from(value: crate::sources::mapping::MappingError) -> Self { Self::Mapping(value) } }
impl From<crate::sources::sync::SyncError> for QueryError { fn from(value: crate::sources::sync::SyncError) -> Self { Self::Sync(value) } }
impl From<crate::releases::Error> for QueryError { fn from(value: crate::releases::Error) -> Self { Self::Release(Box::new(value)) } }
impl From<crate::definitions::DefinitionError> for QueryError { fn from(value: crate::definitions::DefinitionError) -> Self { Self::Definition(value) } }
impl From<world_protocol::definitions::DefinitionFailure> for QueryError { fn from(value: world_protocol::definitions::DefinitionFailure) -> Self { Self::Definition(crate::definitions::DefinitionError::Rejected(value)) } }
impl From<crate::facts::assertions::Error> for QueryError { fn from(value: crate::facts::assertions::Error) -> Self { Self::Fact(value) } }
impl From<world_protocol::provenance::ProvenanceFailure> for QueryError { fn from(value: world_protocol::provenance::ProvenanceFailure) -> Self { Self::Provenance(value) } }
impl fmt::Display for QueryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { match self { Self::Rejected(_) => f.write_str("world.query_rejected"), Self::Store(e) => e.fmt(f), Self::Authorization(e) => e.fmt(f), Self::Identity(e) => e.fmt(f), Self::Source(e) => e.fmt(f), Self::Mapping(e) => e.fmt(f), Self::Sync(e) => e.fmt(f), Self::Release(e) => e.fmt(f), Self::Definition(e) => e.fmt(f), Self::Fact(e) => e.fmt(f), Self::Provenance(_) => f.write_str("world.query_provenance_rejected"), Self::Invocation { cause, .. } => cause.fmt(f) } }
}
impl fmt::Debug for QueryError { fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Display::fmt(self, f) } }
impl Error for QueryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> { match self { Self::Rejected(_) => None, Self::Store(e) => Some(e), Self::Authorization(e) => Some(e), Self::Identity(e) => Some(e), Self::Source(e) => Some(e), Self::Mapping(e) => Some(e), Self::Sync(e) => Some(e), Self::Release(e) => Some(e.as_ref()), Self::Definition(e) => Some(e), Self::Fact(e) => Some(e), Self::Provenance(_) => None, Self::Invocation { cause, .. } => Some(cause.as_ref()) } }
}
impl QueryError {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use world_protocol::{operation::OperationFailure as Operation, process::HostFailure as Host};
        match self {
            Self::Rejected(failure) => Host::Query(failure.clone()),
            Self::Invocation { failure, .. } => failure.clone(),
            Self::Store(error) | Self::Authorization(AuthError::Store(error)) => Host::Operation(Operation::Commit(error.reason.clone())),
            Self::Authorization(AuthError::Denied(failure)) => Host::Authorization(failure.clone()),
            Self::Authorization(AuthError::Codec(_)) => Host::InternalFault,
            Self::Identity(crate::identity::IdentityError::Rejected(failure)) => Host::Operation(Operation::Identity(failure.clone())),
            Self::Identity(crate::identity::IdentityError::Store(error)) => Host::Operation(Operation::Commit(error.reason.clone())),
            Self::Identity(crate::identity::IdentityError::Fact(error)) | Self::Fact(error) => error.host_failure(),
            Self::Source(error) => Host::Source(error.failure.clone()),
            Self::Mapping(crate::sources::mapping::MappingError::Mapping(failure)) => Host::Operation(Operation::Mapping(failure.clone())),
            Self::Mapping(crate::sources::mapping::MappingError::Authorization(error)) => auth_host(error),
            Self::Mapping(crate::sources::mapping::MappingError::Store(error)) => Host::Operation(Operation::Commit(error.reason.clone())),
            Self::Mapping(crate::sources::mapping::MappingError::Definition(error)) | Self::Definition(error) => definition_host(error),
            Self::Mapping(crate::sources::mapping::MappingError::Release(error)) | Self::Release(error) => error.host_failure(),
            Self::Sync(error) => error.host_failure(),
            Self::Provenance(failure) => Host::Operation(Operation::Fact(world_protocol::facts::FactFailure::Provenance { failure: failure.clone() })),
        }
    }
}
fn auth_host(error: &AuthError) -> world_protocol::process::HostFailure {
    use world_protocol::{operation::OperationFailure, process::HostFailure};
    match error { AuthError::Denied(failure) => HostFailure::Authorization(failure.clone()), AuthError::Store(error) => HostFailure::Operation(OperationFailure::Commit(error.reason.clone())), AuthError::Codec(_) => HostFailure::InternalFault }
}
fn definition_host(error: &crate::definitions::DefinitionError) -> world_protocol::process::HostFailure {
    use world_protocol::{operation::OperationFailure, process::HostFailure};
    match error { crate::definitions::DefinitionError::Rejected(failure) => HostFailure::Operation(OperationFailure::Definition(failure.clone())),
        crate::definitions::DefinitionError::Compile(failure) => HostFailure::Operation(OperationFailure::Compile(failure.clone())),
        crate::definitions::DefinitionError::Store(error) => HostFailure::Operation(OperationFailure::Commit(error.reason.clone())), crate::definitions::DefinitionError::Codec(_) => HostFailure::InternalFault }
}
impl From<QueryError> for crate::owner::Error {
    fn from(error: QueryError) -> Self {
        use world_protocol::{api::ApiFailure, failure::Recovery, operation::OperationFailure};
        match error {
            QueryError::Rejected(failure) => Self::new("world.query_rejected", FailureStage::Read, "查询未满足当前读取条件。", ApiFailure::Query(failure), Recovery::Refresh),
            QueryError::Store(error) => error.into(), QueryError::Authorization(error) => error.into(),
            QueryError::Identity(error) => crate::facts::assertions::Error::from(error).into(),
            QueryError::Source(error) => Self::new("world.source_failed", error.stage, "来源读取未完成。", ApiFailure::Operation(OperationFailure::Source(error.failure.clone())), Recovery::Refresh).caused(error),
            QueryError::Mapping(error) => crate::facts::assertions::Error::from(error).into(),
            QueryError::Sync(error) => error.into(), QueryError::Release(error) => (*error).into(),
            QueryError::Definition(error) => crate::facts::assertions::Error::from(error).into(),
            QueryError::Fact(error) => error.into(),
            error @ QueryError::Invocation { .. } => Self::from_host_failure(error.host_failure(), FailureStage::Execute).caused(error),
            QueryError::Provenance(failure) => crate::facts::assertions::Error::from(world_protocol::facts::FactFailure::Provenance { failure }).into(),
        }
    }
}
pub(super) fn decode<T: serde::de::DeserializeOwned>(body: serde_json::Value) -> Result<T, QueryError> {
    serde_json::from_value(body).map_err(|e| StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Read, e).into())
}
pub(super) fn encode(value: &impl serde::Serialize) -> Result<serde_json::Value, QueryError> {
    serde_json::to_value(value).map_err(|e| StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Commit, e).into())
}
pub(super) fn invalid(field: &str) -> QueryError {
    QueryFailure::InvalidQuery { field: world_protocol::failure::FieldPath(field.split('.').map(str::to_owned).collect()) }.into()
}
