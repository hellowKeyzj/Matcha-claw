mod basis;
mod branch;
mod check;
mod formal;
mod online;
mod prepared;
mod read;
mod resolve;
pub(crate) use read::{list_authorized, read_authorized, recall, recalled};
pub(crate) use prepared::PreparedAbstraction;
mod retention;
pub(crate) use retention::{retain_contract, retain_draft};
pub(crate) use online::{execute_online, online_impact, prepare_online_strategy, require_online_action, require_online_strategy, strategy_step_retention_roots};
pub(crate) mod strategy;

pub(crate) use branch::{BindingExecution, execute_branch as execute_bindings, impact as branch_binding_impact, expressions as binding_expressions};
pub(crate) use check::contract as check_contract;
pub(crate) use basis::{record_impact, require_branch};

pub(crate) use resolve::{ConcreteStrategy, ConcreteTask, ConcreteWitness, PreparedResolution, Resolution, ResolutionPlan, concrete_strategy, replan_concrete, execute, prepare, commit};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    abstraction::{AbstractionContract, AbstractionDraft, AbstractionFailure, Assurance},
    ids::{AbstractionId, Revision, WriterDomain},
    learning::{Candidate, CandidateOrigin, ChangeStatus, TaskContract},
    releases::{BranchRef, WorldBranch},
};
use crate::{authorization::Admission, content::Content, extensions::invocation::CallBudget, store::{WorldTransaction, StoreError, StoreFuture}};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRevision {
    contract: AbstractionContract,
    verified: Option<formal::VerifiedBooleanPlan>,
}

fn decode_stored(body: serde_json::Value) -> Result<StoredRevision, Error> {
    let bytes = serde_json::to_vec(&body).map_err(|_| AbstractionFailure::InternalFault)?;
    let stored: StoredRevision = world_protocol::wire::decode(&bytes, bytes.len()).map_err(|_| AbstractionFailure::InternalFault)?;
    if (stored.contract.assurance == Assurance::Verified) != stored.verified.is_some() {
        return Err(AbstractionFailure::AssuranceUnsupported { requested: stored.contract.assurance }.into());
    }
    Ok(stored)
}

/// Decodes the single owner storage format; it does not grant assurance or current access.
pub(crate) fn decode_revision(body: serde_json::Value) -> Result<AbstractionContract, Error> {
    Ok(decode_stored(body)?.contract)
}

pub(crate) enum Error {
    Rejected(AbstractionFailure), Store(StoreError), Authorization(crate::authorization::AuthError),
    Definition(crate::definitions::DefinitionError), Compile(world_protocol::compiler::CompileFailure),
    Expression(world_protocol::expression::ExpressionFailure), Query(crate::query::QueryError),
    Evaluation(crate::evaluation::Error), Release(crate::releases::Error),
    Identity(crate::identity::IdentityError), Fact(crate::facts::assertions::Error),
    State(crate::extensions::migration::StateError),
}
impl From<AbstractionFailure> for Error { fn from(value: AbstractionFailure) -> Self { Self::Rejected(value) } }
impl From<StoreError> for Error { fn from(value: StoreError) -> Self { Self::Store(value) } }
impl From<crate::authorization::AuthError> for Error { fn from(value: crate::authorization::AuthError) -> Self { Self::Authorization(value) } }
impl From<crate::definitions::DefinitionError> for Error { fn from(value: crate::definitions::DefinitionError) -> Self { Self::Definition(value) } }
impl From<world_protocol::compiler::CompileFailure> for Error { fn from(value: world_protocol::compiler::CompileFailure) -> Self { Self::Compile(value) } }
impl From<world_protocol::expression::ExpressionFailure> for Error { fn from(value: world_protocol::expression::ExpressionFailure) -> Self { Self::Expression(value) } }
impl From<crate::query::QueryError> for Error { fn from(value: crate::query::QueryError) -> Self { Self::Query(value) } }
impl From<crate::evaluation::Error> for Error { fn from(value: crate::evaluation::Error) -> Self { Self::Evaluation(value) } }
impl From<crate::releases::Error> for Error { fn from(value: crate::releases::Error) -> Self { Self::Release(value) } }
impl From<crate::identity::IdentityError> for Error { fn from(value: crate::identity::IdentityError) -> Self { Self::Identity(value) } }
impl From<crate::facts::assertions::Error> for Error { fn from(value: crate::facts::assertions::Error) -> Self { Self::Fact(value) } }
impl From<crate::extensions::migration::StateError> for Error { fn from(value: crate::extensions::migration::StateError) -> Self { Self::State(value) } }
impl std::fmt::Debug for Error { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { std::fmt::Display::fmt(self, f) } }
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => error.fmt(f), Self::Authorization(error) => error.fmt(f), Self::Definition(error) => error.fmt(f),
            Self::Query(error) => error.fmt(f), Self::Evaluation(error) => error.fmt(f), Self::Release(error) => error.fmt(f),
            Self::Identity(error) => error.fmt(f), Self::Fact(error) => error.fmt(f), Self::State(error) => error.fmt(f), _ => f.write_str("world.abstraction_rejected"),
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Store(error) => Some(error), Self::Authorization(error) => Some(error), Self::Definition(error) => Some(error),
            Self::Query(error) => Some(error), Self::Evaluation(error) => Some(error), Self::Release(error) => Some(error),
            Self::Identity(error) => Some(error), Self::Fact(error) => Some(error), Self::State(error) => Some(error), _ => None,
        }
    }
}

impl Error {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use world_protocol::{operation::OperationFailure as Operation, process::HostFailure as Host};
        match self {
            Self::Rejected(reason) => Host::Input(world_protocol::failure::InputFailure::InvalidValue { field: world_protocol::failure::FieldPath(vec![match reason {
                AbstractionFailure::SlotUnbound { .. } | AbstractionFailure::DuplicateBinding { .. } | AbstractionFailure::TypeMismatch { .. } => "bindingMap",
                AbstractionFailure::GuardFalse | AbstractionFailure::GuardUnknown => "guard",
                AbstractionFailure::AssuranceUnsupported { .. } => "assurance", AbstractionFailure::EvidenceMissing => "evidence",
                AbstractionFailure::BasisChanged => "basis", AbstractionFailure::BudgetExceeded => return Host::BudgetExceeded { dimension: world_protocol::budget::BudgetDimension::Steps },
                AbstractionFailure::Cancelled => return Host::Cancelled, AbstractionFailure::InternalFault => return Host::InternalFault,
            }.into()]) }),
            Self::Store(error) => Host::Operation(Operation::Commit(error.reason.clone())),
            Self::Authorization(crate::authorization::AuthError::Denied(reason)) => Host::Authorization(reason.clone()),
            Self::Authorization(crate::authorization::AuthError::Store(error)) => Host::Operation(Operation::Commit(error.reason.clone())),
            Self::Authorization(crate::authorization::AuthError::Codec(_)) => Host::InternalFault,
            Self::Compile(reason) => Host::Operation(Operation::Compile(reason.clone())),
            Self::Expression(reason) => Host::Query(world_protocol::query::QueryFailure::Expression { failure: reason.clone() }),
            Self::Definition(crate::definitions::DefinitionError::Rejected(reason)) => Host::Operation(Operation::Definition(reason.clone())),
            Self::Definition(crate::definitions::DefinitionError::Compile(reason)) => Host::Operation(Operation::Compile(reason.clone())),
            Self::Definition(crate::definitions::DefinitionError::Store(error)) => Host::Operation(Operation::Commit(error.reason.clone())),
            Self::Definition(crate::definitions::DefinitionError::Codec(_)) => Host::InternalFault,
            Self::Query(error) => error.host_failure(), Self::Evaluation(error) => error.host_failure(), Self::Release(error) => error.host_failure(),
            Self::Identity(crate::identity::IdentityError::Rejected(reason)) => Host::Operation(Operation::Identity(reason.clone())),
            Self::Identity(crate::identity::IdentityError::Store(error)) => Host::Operation(Operation::Commit(error.reason.clone())),
            Self::Identity(crate::identity::IdentityError::Fact(error)) | Self::Fact(error) => Host::Operation(Operation::Fact(error.safe_failure().details)),
            Self::State(error) => error.host_failure(),
        }
    }
}
impl From<Error> for crate::owner::Error {
    fn from(error: Error) -> Self {
        use world_protocol::{api::ApiFailure, failure::{FailureStage, Recovery}, process::HostFailure};
        let details = match error.host_failure() {
            HostFailure::Input(reason) => ApiFailure::Input(reason), HostFailure::Authorization(reason) => ApiFailure::Authorization(reason),
            HostFailure::Query(reason) => ApiFailure::Query(reason), HostFailure::Operation(reason) => ApiFailure::Operation(reason),
            HostFailure::Cancelled => ApiFailure::Operation(world_protocol::operation::OperationFailure::Cancelled),
            _ => ApiFailure::InternalFault,
        };
        Self::new("world.abstraction_rejected", FailureStage::Validate, "抽象契约未满足当前条件。", details, Recovery::Refresh).caused(error)
    }
}

/// Binds author fields only to the owner's exact candidate birth model, never the active lifecycle revision.
pub(crate) fn bind_draft(
    draft: &AbstractionDraft, task: &TaskContract, candidate: &Candidate, branch: &WorldBranch,
) -> Result<AbstractionContract, Error> {
    if draft.revision.0 == 0 || task.revision.0 == 0 || branch.revision.0 == 0
        || task.world != branch.world || candidate.world != task.world || candidate.change_set.world != task.world
        || candidate.origin != CandidateOrigin::Abstraction || candidate.change_set.revision != Revision(1)
        || candidate.change_set.status != ChangeStatus::Proposed || branch.status != ChangeStatus::Proposed
        || branch.task_id != task.id || branch.task_revision != task.revision || branch.candidate_id != candidate.id
        || branch.change_set_id != candidate.change_set.id || branch.basis.release_id != candidate.change_set.base_release
        || branch.basis.overlay != candidate.change_set.operations || branch.compile.world != task.world
        || branch.compile.base_release != branch.basis.release_id || branch.compile.activation_lock.world != task.world {
        return Err(AbstractionFailure::BasisChanged.into());
    }
    crate::evaluation::validate_task(task).map_err(crate::evaluation::Error::from)?;
    Ok(AbstractionContract {
        world: task.world.clone(), id: draft.id.clone(), revision: draft.revision,
        candidate_id: candidate.id.clone(), branch: Some(BranchRef { world: branch.world.clone(), id: branch.id.clone(), revision: branch.revision }),
        task_id: task.id.clone(), task_revision: task.revision, base_release: branch.basis.release_id.clone(), scope: task.scope.clone(),
        strategy: draft.strategy.clone(), applicable_actions: draft.applicable_actions.clone(), original_definitions: draft.original_definitions.clone(),
        forward_plan: draft.forward_plan.clone(), preserved_invariants: draft.preserved_invariants.clone(), parameters: draft.parameters.clone(),
        slots: draft.slots.clone(), binding_map: draft.binding_map.clone(), guard: draft.guard.clone(), assurance: draft.assurance,
        assumptions: draft.assumptions.clone(), evaluation_ids: draft.evaluation_ids.clone(), fallback: draft.fallback.clone(),
        read_dependencies: draft.read_dependencies.clone(),
    })
}

/// Immutable metadata only; accepting a candidate or publishing a release remains with its owner.
pub(crate) fn record<'a>(
    tx: &'a mut WorldTransaction<'_>, content: &'a Content, admission: &'a Admission, contract: &'a AbstractionContract,
    budget: &'a CallBudget, cancel: &'a CancellationToken,
) -> StoreFuture<'a, AbstractionContract, Error> {
    Box::pin(async move {
        tx.require_domain(&WriterDomain::try_new("abstraction").map_err(|_| AbstractionFailure::InternalFault)?)?;
        let checked = basis::load(tx, content, admission, contract, true).await?;
        check::contract(contract, &checked.definitions, &checked.scopes)?;
        let digest = digest(contract)?;
        let key = serde_json::to_string(&(tx.world(), "abstraction", &contract.id)).map_err(|_| AbstractionFailure::InternalFault)?;
        tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", &[&key]).await?;
        if let Some(first) = read(tx, &contract.id, Revision(1)).await? {
            if crate::evaluation::abstraction_plan_digest(&first)? != crate::evaluation::abstraction_plan_digest(contract)? {
                return Err(AbstractionFailure::BasisChanged.into());
            }
        }
        if let Some(stored) = read(tx, &contract.id, contract.revision).await? {
            if stored != *contract { return Err(AbstractionFailure::BasisChanged.into()); }
            if contract.assurance == Assurance::Verified { require_verified(tx, contract).await?; }
            return Ok(stored);
        }
        let world = tx.world().clone();
        let previous = tx.query_opt("SELECT COALESCE(MAX(revision),0) AS revision FROM world_abstraction_revision WHERE tenant_id=$1 AND world_id=$2 AND abstraction_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &contract.id.as_str()]).await?.ok_or(AbstractionFailure::InternalFault)?.get::<_, i64>("revision");
        if previous.checked_add(1) != Some(number(contract.revision)?) { return Err(AbstractionFailure::BasisChanged.into()); }
        let branch = contract.branch.as_ref().map(|branch| branch.id.to_string());
        let branch_revision = contract.branch.as_ref().map(|branch| number(branch.revision)).transpose()?;
        let verified = if contract.assurance == Assurance::Verified {
            Some(formal::verify_boolean_plan(contract, &checked.task, &checked.model.definitions, &checked.model.scopes,
                budget, cancel, &tx.now().await?).await?)
        } else { None };
        let body = serde_json::to_value(StoredRevision { contract: contract.clone(), verified }).map_err(|_| AbstractionFailure::InternalFault)?;
        tx.execute("INSERT INTO world_abstraction_revision(tenant_id,world_id,abstraction_id,revision,base_release_id,candidate_id,branch_id,branch_revision,task_id,task_revision,scope_id,content_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &contract.id.as_str(), &number(contract.revision)?,
              &contract.base_release.as_str(), &contract.candidate_id.as_str(), &branch, &branch_revision,
              &contract.task_id.as_str(), &number(contract.task_revision)?, &contract.scope.as_str(), &digest.as_str(), &body]).await?;
        Ok(contract.clone())
    })
}

/// Internal basis read; the consumer still has to run current authorization before disclosing it.
pub(crate) async fn read(tx: &WorldTransaction<'_>, id: &AbstractionId, revision: Revision) -> Result<Option<AbstractionContract>, Error> {
    let world = tx.world();
    let row = tx.query_opt("SELECT base_release_id,candidate_id,branch_id,branch_revision,task_id,task_revision,scope_id,content_digest,body FROM world_abstraction_revision WHERE tenant_id=$1 AND world_id=$2 AND abstraction_id=$3 AND revision=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &number(revision)?]).await?;
    row.map(|row| {
        let body = row.get::<_, serde_json::Value>("body");
        let contract = decode_revision(body)?;
        if contract.world != *world || contract.id != *id || contract.revision != revision
            || contract.base_release.as_str() != row.get::<_, String>("base_release_id")
            || contract.candidate_id.as_str() != row.get::<_, String>("candidate_id")
            || contract.branch.as_ref().map(|branch| branch.id.to_string()) != row.get::<_, Option<String>>("branch_id")
            || contract.branch.as_ref().map(|branch| number(branch.revision)).transpose()? != row.get::<_, Option<i64>>("branch_revision")
            || contract.task_id.as_str() != row.get::<_, String>("task_id") || number(contract.task_revision)? != row.get::<_, i64>("task_revision")
            || contract.scope.as_str() != row.get::<_, String>("scope_id") || digest(&contract)?.as_str() != row.get::<_, String>("content_digest") {
            return Err(AbstractionFailure::BasisChanged.into());
        }
        Ok(contract)
    }).transpose()
}

/// Consumes only the immutable owner-minted revision and freshly read exact task/model.
/// Current permissions and dependencies remain with basis::footprint, not the certificate.
pub(crate) async fn require_verified(tx: &WorldTransaction<'_>, contract: &AbstractionContract) -> Result<(), Error> {
    if contract.assurance != Assurance::Verified || read(tx, &contract.id, contract.revision).await?.as_ref() != Some(contract) {
        return Err(AbstractionFailure::AssuranceUnsupported { requested: contract.assurance }.into());
    }
    let world = tx.world();
    let row = tx.query_opt("SELECT body FROM world_abstraction_revision WHERE tenant_id=$1 AND world_id=$2 AND abstraction_id=$3 AND revision=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &contract.id.as_str(), &number(contract.revision)?]).await?
        .ok_or(AbstractionFailure::BasisChanged)?;
    let stored = decode_stored(row.get("body"))?;
    let certificate = stored.verified.as_ref().ok_or(AbstractionFailure::AssuranceUnsupported { requested: Assurance::Verified })?;
    let task = crate::evaluation::read_task(tx, &contract.task_id, contract.task_revision).await?;
    let (branch, _) = crate::releases::read_candidate(tx, &contract.candidate_id).await?.ok_or(AbstractionFailure::BasisChanged)?;
    require_branch(tx, contract, &branch).await?;
    let model = basis::model(tx, &branch).await?;
    formal::check_exact(certificate, contract, &task, &model.definitions, &model.scopes)
}

fn number(revision: Revision) -> Result<i64, Error> { i64::try_from(revision.0).ok().filter(|value| *value > 0).ok_or_else(|| AbstractionFailure::BasisChanged.into()) }
fn digest(contract: &AbstractionContract) -> Result<world_protocol::ids::Digest, Error> {
    crate::definitions::canonical_digest(&("world.abstraction.v1", contract)).map_err(|_| AbstractionFailure::InternalFault.into())
}
