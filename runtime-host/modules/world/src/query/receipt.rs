use serde::{Deserialize, Serialize};
use tokio_postgres::Row;
use world_protocol::{authorization::{ActualImpact, Decision}, ids::*, query::*, time::Timestamp};
use crate::{authorization::{self, Admission, VerifiedInvocation}, store::{StoreFuture, WorldSnapshot, WorldTransaction}};
use super::{QueryError, current::ReadAuthority, error::{decode, encode}};

#[derive(Clone)]
pub(super) struct StoredRead {
    pub receipt: ReadReceipt, pub rows: Vec<QueryRow>, pub row_subjects: Vec<Vec<world_protocol::identity::SubjectRef>>, pub objects: Vec<ObjectView>,
    pub relations: Vec<RelationView>, pub impact: ActualImpact, pub actor: ActorId, pub context: ReadContext, pub input: ReadInput, pub origin: Option<ReadOrigin>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReadOrigin { pub receipt: ReadReceipt, pub input: ReadInput, pub context: ReadContext }
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum ReadInput {
    Query { request: QueryRequest },
    Expression { declarations: Vec<world_protocol::expression::Parameter>, parameters: std::collections::BTreeMap<ParameterId, world_protocol::value::Cell>, expressions: Vec<world_protocol::expression::ExpressionIr>, at: Timestamp, read_mode: ReadMode, known_at: Option<Timestamp> },
}
impl ReadInput {
    pub(super) fn check(&self, receipt: &ReadReceipt, context: &ReadContext) -> Result<(), QueryError> {
        let digest = match self {
            Self::Query { request } => {
                if request.world != receipt.world || request.branch_id != receipt.branch_id
                    || request.release_id.as_ref().is_some_and(|id| id != &receipt.release_id)
                    || request.read_mode != receipt.requested_mode || request.known_at != context.known_at
                    || request.valid_at.as_ref().is_some_and(|at| at != &context.valid_time.from)
                    || request.page.cursor.is_some() { return Err(QueryFailure::BasisChanged.into()); }
                super::execution::query_digest(request)?
            },
            Self::Expression { declarations, parameters, expressions, at, read_mode, known_at } => {
                if at != &context.valid_time.from || read_mode != &receipt.requested_mode || known_at != &context.known_at { return Err(QueryFailure::BasisChanged.into()); }
                match &context.branch_model {
                    Some((branch, arm)) => crate::definitions::canonical_digest(&("world.branch.expression.v1", branch, arm, declarations, parameters, expressions, at))?,
                    None => crate::definitions::canonical_digest(&("world.current.expression.v1", &receipt.world, &receipt.release_id, declarations, parameters, expressions, at, read_mode, known_at))?,
                }
            },
        };
        if digest != receipt.query_digest || context.valid_time != super::projection::point(&context.valid_time.from)? { return Err(QueryFailure::BasisChanged.into()); }
        Ok(())
    }
    pub(super) fn retain(&self, roots: &mut crate::store::RetentionRoots) {
        match self {
            Self::Query { request } => {
                roots.definitions.extend(crate::definitions::query_references(&request.query));
                roots.resources.extend(crate::definitions::query_resources(&request.query));
                roots.releases.extend(request.release_id.iter().cloned());
                roots.resources.extend(request.branch_id.iter().cloned().map(|id| ResourceRef::Branch { id }));
                for argument in &request.arguments { crate::definitions::value_resources(&argument.value, &mut roots.resources); }
            },
            Self::Expression { declarations, parameters, expressions, .. } => {
                for declaration in declarations { roots.resources.extend(crate::definitions::value_type_resources(&declaration.value_type)); }
                for expression in expressions {
                    roots.definitions.extend(crate::definitions::expression_references(expression));
                    roots.resources.extend(crate::definitions::expression_resources(expression));
                }
                for cell in parameters.values() { retain_cell(roots, cell.clone()); }
            },
        }
    }
    pub(super) fn mode(&self) -> &ReadMode { match self { Self::Query { request } => &request.read_mode, Self::Expression { read_mode, .. } => read_mode } }
}
#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum CaptureSelection { Selected, Target }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReadContext {
    pub scope: ScopeId,
    pub valid_time: world_protocol::time::ValidTime,
    pub known_at: Option<Timestamp>,
    pub branch_model: Option<(world_protocol::releases::BranchRef, world_protocol::evaluation::EvaluationArm)>,
    pub frozen_model: Option<super::frozen::FrozenRead>,
    pub captures: Vec<(DefinitionRef, Digest)>,
    pub capture_selection: CaptureSelection,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub derivations: Vec<(AssertionRef, Digest)>,
}
impl ReadContext {
    pub(super) fn branch(scope: &ScopeId, valid_time: world_protocol::time::ValidTime, branch: &world_protocol::releases::BranchRef, arm: &world_protocol::evaluation::EvaluationArm, captures: &[crate::sources::sync::BranchCapture], known_at: Option<&Timestamp>) -> Self {
        Self { scope: scope.clone(), valid_time, known_at: known_at.cloned(), branch_model: Some((branch.clone(), arm.clone())), frozen_model: None, captures: captures.iter().map(|capture| (capture.capture().binding.clone(), capture.capture().digest.clone())).collect(), capture_selection: CaptureSelection::Selected, derivations: Vec::new() }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredReceipt { receipt: ReadReceipt, context: ReadContext, row_subjects: Vec<Vec<world_protocol::identity::SubjectRef>>, input: ReadInput, origin: Option<ReadOrigin> }
const READ: &str = "SELECT r.*,d.actor_id,d.decision FROM world_read_receipt r JOIN world_auth_decision d USING(tenant_id,world_id,decision_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.receipt_id=$3";

/// Durable provenance only. Reading a receipt never grants permission to its contents.
pub(crate) async fn read_receipt(tx: &WorldTransaction<'_>, id: &ReadReceiptId) -> Result<ReadReceipt, QueryError> {
    Ok(read_transaction(tx, id).await?.receipt)
}
pub(crate) async fn read_receipt_snapshot(snapshot: &WorldSnapshot<'_>, id: &ReadReceiptId) -> Result<ReadReceipt, QueryError> {
    Ok(read_snapshot(snapshot, id).await?.receipt)
}
pub(crate) async fn world_deletion_roots(tx: &WorldTransaction<'_>) -> Result<crate::store::RetentionRoots, QueryError> {
    let mut roots = crate::store::RetentionRoots::default();
    for row in tx.query("SELECT r.*,d.actor_id,d.decision FROM world_read_receipt r JOIN world_auth_decision d USING(tenant_id,world_id,decision_id) WHERE r.tenant_id=$1 AND r.world_id=$2 ORDER BY r.receipt_id", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str()]).await? {
        let id = ReadReceiptId::try_new(row.get::<_, String>("receipt_id")).map_err(|_| QueryFailure::BasisChanged)?;
        let read = checked(row, tx.world(), &id)?;
        let mut local = crate::store::RetentionRoots::default();
        retain_context(&mut local, &read.receipt, &read.input, &read.context);
        local.resources.extend(read.row_subjects.iter().flatten().map(super::projection::resource));
        for access in &read.impact.access {
            local.scopes.push(access.scope.clone()); local.resources.extend(access.resources.iter().cloned()); local.definitions.extend(access.fields.iter().cloned());
        }
        local.resources.extend(read.impact.state.iter().map(|reference| ResourceRef::State { id: reference.id.clone() }));
        local.resources.extend(read.impact.source_ids.iter().cloned().map(|id| ResourceRef::Source { id }));
        retain_views(&mut local, &read.rows, &read.objects, &read.relations);
        append_context_roots(tx, &mut roots, local, &read.context).await?;
        if let ReadMode::After { receipt_id } = read.input.mode() {
            let previous = read_transaction(tx, receipt_id).await?;
            let mut local = crate::store::RetentionRoots::default();
            retain_context(&mut local, &previous.receipt, &previous.input, &previous.context);
            append_context_roots(tx, &mut roots, local, &previous.context).await?;
        }
        if let Some(origin) = &read.origin {
            let mut local = crate::store::RetentionRoots::default();
            retain_context(&mut local, &origin.receipt, &origin.input, &origin.context);
            append_context_roots(tx, &mut roots, local, &origin.context).await?;
        }
    }
    roots.scopes.sort(); roots.scopes.dedup(); roots.resources.sort(); roots.resources.dedup();
    roots.definitions.sort(); roots.definitions.dedup(); roots.evidence.sort(); roots.evidence.dedup();
    Ok(roots)
}
fn retain_context(roots: &mut crate::store::RetentionRoots, read: &ReadReceipt, input: &ReadInput, context: &ReadContext) {
    roots.scopes.push(context.scope.clone());
    roots.branches.extend(context.branch_model.as_ref().map(|(branch, _)| branch.clone()));
    roots.definitions.extend(context.captures.iter().map(|(binding, _)| binding.clone()));
    roots.resources.extend(context.derivations.iter().map(|(reference, _)| ResourceRef::Assertion { id: reference.id.clone() }));
    retain_read(roots, read); input.retain(roots);
}
async fn append_context_roots(tx: &WorldTransaction<'_>, roots: &mut crate::store::RetentionRoots, mut local: crate::store::RetentionRoots, context: &ReadContext) -> Result<(), QueryError> {
    if let Some(seal) = &context.frozen_model {
        let (branch, arm) = context.branch_model.as_ref().ok_or(QueryFailure::BasisChanged)?;
        let inline = super::frozen::inline_definitions(tx, branch, arm, seal).await?;
        local.definitions.retain(|reference| !inline.contains(reference));
        local.dependencies.retain(|dependency| !matches!(dependency, world_protocol::provenance::ReadDependency::Definition { reference } if inline.contains(reference)));
        local.resources.retain(|resource| !matches!(resource, ResourceRef::Definition { id } if inline.iter().any(|reference| &reference.id == id)
            && !local.definitions.iter().any(|reference| &reference.id == id)
            && !local.dependencies.iter().any(|dependency| matches!(dependency, world_protocol::provenance::ReadDependency::Definition { reference } if &reference.id == id))));
    }
    roots.scopes.extend(local.scopes); roots.resources.extend(local.resources); roots.definitions.extend(local.definitions);
    roots.evidence.extend(local.evidence); roots.dependencies.extend(local.dependencies); roots.sources.extend(local.sources);
    roots.releases.extend(local.releases); roots.branches.extend(local.branches); roots.source_versions.extend(local.source_versions);
    roots.parse_artifacts.extend(local.parse_artifacts); roots.schemas.extend(local.schemas); roots.mappings.extend(local.mappings);
    Ok(())
}
pub(crate) fn retain_read(roots: &mut crate::store::RetentionRoots, read: &ReadReceipt) {
    roots.releases.push(read.release_id.clone());
    if let Some(id) = &read.branch_id { roots.resources.push(ResourceRef::Branch { id: id.clone() }); }
    roots.dependencies.extend(read.actual_dependencies.clone()); roots.sources.extend(read.basis.clone());
    roots.resources.extend(read.dirty.iter().cloned().map(|id| ResourceRef::Watch { id }));
}
pub(crate) fn retain_page(roots: &mut crate::store::RetentionRoots, page: &QueryPage) {
    retain_read(roots, &page.receipt); retain_views(roots, &page.rows.items, &page.objects, &page.relations);
}
pub(crate) fn retain_views(roots: &mut crate::store::RetentionRoots, rows: &[QueryRow], objects: &[ObjectView], relations: &[RelationView]) {
    for row in rows { for column in &row.columns { retain_cell(roots, column.cell.clone()); } }
    for object in objects {
        roots.resources.push(ResourceRef::Object { id: object.object.id.clone() });
        roots.resources.push(ResourceRef::Definition { id: object.object.type_id.clone() });
        for field in &object.fields { retain_field(roots, field.clone()); }
    }
    for relation in relations {
        roots.resources.push(ResourceRef::Relation { id: relation.relation.id.clone() });
        roots.resources.push(ResourceRef::Definition { id: relation.relation.type_id.clone() });
        if let Some(reference) = &relation.claim { roots.dependencies.push(world_protocol::provenance::ReadDependency::Assertion { reference: reference.clone() }); }
        roots.resources.extend(relation.roles.iter().map(|role| ResourceRef::Object { id: role.object_id.clone() }));
        for field in &relation.fields { retain_field(roots, field.clone()); }
    }
}
pub(crate) fn retain_field(roots: &mut crate::store::RetentionRoots, field: FieldCell) {
    roots.definitions.push(field.property); roots.evidence.extend(field.evidence);
    if let world_protocol::value::DirtyState::Dirty { watches, .. } = field.dirty { roots.resources.extend(watches.into_iter().map(|id| ResourceRef::Watch { id })); }
    retain_cell(roots, field.cell);
}
pub(crate) fn retain_cell(roots: &mut crate::store::RetentionRoots, cell: world_protocol::value::Cell) {
    use world_protocol::{provenance::ReadDependency, value::{Cell, Value}};
    match cell {
        Cell::Known { value } => {
            let mut pending = vec![value];
            while let Some(value) = pending.pop() {
                match value {
                    Value::Object { id } => roots.resources.push(ResourceRef::Object { id }),
                    Value::Relation { id } => roots.resources.push(ResourceRef::Relation { id }),
                    Value::List { items } => pending.extend(items),
                    Value::Record { fields } => pending.extend(fields.into_values()),
                    _ => {},
                }
            }
        }
        Cell::Conflicted { assertions } => roots.dependencies.extend(assertions.into_iter().map(|reference| ReadDependency::Assertion { reference })),
        Cell::SourceUnavailable { source_id, .. } => roots.resources.push(ResourceRef::Source { id: source_id }),
        Cell::Unknown { .. } => {},
    }
}
pub(crate) async fn require_action_basis_preflight(tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, id: &ReadReceiptId, now: &Timestamp) -> Result<(ReadReceipt, ActualImpact), QueryError> {
    let read = read_transaction(tx, id).await?;
    let authority = ReadAuthority::Verified(verified);
    require_current_authority(&read, authority, now)?;
    let decision = authorization::check_impact_read_decision(tx, verified, &read.impact, now).await?;
    if read.receipt.policy_epoch != decision.policy_epoch || read.receipt.grant_epoch != decision.grant_epoch { return Err(QueryFailure::BasisChanged.into()); }
    let release = read_model(tx, authority, &read, now).await?;
    recheck_dependencies_authority(tx, authority, &read, &release, now).await?;
    let impact = recheck_output_authority(tx, authority, &read, now).await?;
    Ok((read.receipt, impact))
}
pub(crate) async fn require_action_basis(tx: &WorldTransaction<'_>, admission: &Admission, id: &ReadReceiptId, now: &Timestamp) -> Result<ReadReceipt, QueryError> {
    let read = read_transaction(tx, id).await?;
    require_current(&read, admission, now)?;
    recheck_receipt_dependencies(tx, admission, id, now).await
}
pub(crate) async fn recheck_receipt_dependencies(tx: &WorldTransaction<'_>, admission: &Admission, id: &ReadReceiptId, now: &Timestamp) -> Result<ReadReceipt, QueryError> {
    authorization::recheck(tx, admission, now).await?;
    let read = read_transaction(tx, id).await?;
    if read.receipt.world != admission.invocation().world || read.receipt.expires_at.as_ref().is_some_and(|expires| now >= expires)
        || read.receipt.policy_epoch != admission.decision().policy_epoch || read.receipt.grant_epoch != admission.decision().grant_epoch { return Err(QueryFailure::BasisChanged.into()); }
    admission.require_access(&read.impact)?;
    let release = read_model(tx, ReadAuthority::Admitted(admission), &read, now).await?;
    recheck_dependencies(tx, admission, &read, &release, now).await?;
    recheck_output(tx, admission, &read, now).await?;
    Ok(read.receipt)
}
pub(super) fn dependency_inputs<'a>(
    tx: &'a WorldTransaction<'_>,
    admission: &'a Admission,
    read: &'a StoredRead,
    release: &'a world_protocol::releases::Release,
    now: &'a Timestamp
) -> StoreFuture<'a, (Vec<world_protocol::provenance::ReadDependency>, Option<ActualImpact>), QueryError> {
    dependency_inputs_authority(tx, ReadAuthority::Admitted(admission), read, release, now)
}
fn dependency_inputs_authority<'a>(
    tx: &'a WorldTransaction<'_>,
    authority: ReadAuthority<'a>,
    read: &'a StoredRead,
    release: &'a world_protocol::releases::Release,
    now: &'a Timestamp
) -> StoreFuture<'a, (Vec<world_protocol::provenance::ReadDependency>, Option<ActualImpact>), QueryError> {
    if read.context.branch_model.is_some() { return super::branch::dependency_inputs(tx, authority, read, release, now); }
    Box::pin(async move { Ok((read.receipt.actual_dependencies.clone(), None)) })
}
pub(super) fn dependency_inputs_snapshot<'a>(
    snapshot: &'a WorldSnapshot<'_>,
    admission: &'a Admission,
    read: &'a StoredRead,
    release: &'a world_protocol::releases::Release,
    now: &'a Timestamp
) -> StoreFuture<'a, (Vec<world_protocol::provenance::ReadDependency>, Option<ActualImpact>), QueryError> {
    if read.context.branch_model.is_some() { return super::branch::dependency_inputs_snapshot(snapshot, admission, read, release, now); }
    Box::pin(async move { Ok((read.receipt.actual_dependencies.clone(), None)) })
}
pub(super) async fn recheck_dependencies(tx: &WorldTransaction<'_>, admission: &Admission, read: &StoredRead, release: &world_protocol::releases::Release, now: &Timestamp) -> Result<(), QueryError> {
    recheck_dependencies_authority(tx, ReadAuthority::Admitted(admission), read, release, now).await
}
async fn recheck_dependencies_authority(tx: &WorldTransaction<'_>, authority: ReadAuthority<'_>, read: &StoredRead, release: &world_protocol::releases::Release, now: &Timestamp) -> Result<(), QueryError> {
    let (dependencies, _) = dependency_inputs_authority(tx, authority, read, release, now).await?;
    crate::facts::support::recheck_dependencies_in_model(tx, &dependencies, release, &read.context.scope, &read.context.valid_time, now).await?;
    Ok(())
}
async fn read_model(tx: &WorldTransaction<'_>, authority: ReadAuthority<'_>, read: &StoredRead, now: &Timestamp) -> Result<world_protocol::releases::Release, QueryError> {
    if read.context.branch_model.is_some() {
        super::branch::recheck_receipt_authority(tx, authority, read, now).await
    } else {
        let mut release = crate::releases::read_release(tx, &read.receipt.release_id).await?.ok_or(QueryFailure::BasisChanged)?;
        release.source_branch = None;
        if release.artifact.activation_lock_id != read.receipt.activation_lock_id || super::execution::evaluated_scope_digest(&read.context, &release, &read.impact)? != read.receipt.evaluated_scope_digest { return Err(QueryFailure::BasisChanged.into()); }
        Ok(release)
    }
}
pub(super) fn recheck_output<'a>(
    tx: &'a WorldTransaction<'_>,
    admission: &'a Admission,
    read: &'a StoredRead,
    now: &'a Timestamp
) -> StoreFuture<'a, ActualImpact, QueryError> {
    recheck_output_authority(tx, ReadAuthority::Admitted(admission), read, now)
}
fn recheck_output_authority<'a>(
    tx: &'a WorldTransaction<'_>,
    authority: ReadAuthority<'a>,
    read: &'a StoredRead,
    now: &'a Timestamp
) -> StoreFuture<'a, ActualImpact, QueryError> {
    Box::pin(async move {
        let release = read_model(tx, authority, read, now).await?;
        let current = crate::releases::read_active_model(tx).await?.ok_or(QueryFailure::BasisChanged)?;
        let mut impact = read.impact.clone();
        let fields: std::collections::BTreeSet<_> = impact.access.iter().flat_map(|access| access.fields.iter().cloned()).collect();
        for reference in fields {
            let exact = release.definitions.iter().find(|definition| definition.reference == reference).ok_or(QueryFailure::BasisChanged)?;
            for definition in std::iter::once(exact).chain(current.definitions.iter().filter(|definition| definition.reference.id == reference.id)) {
                if definition.body.kind() != exact.body.kind() { return Err(QueryFailure::BasisChanged.into()); }
                if let world_protocol::definitions::DefinitionBody::Property(body) = &definition.body { impact.labels.extend(body.access_labels.clone()); }
                impact.access.push(world_protocol::authorization::AccessScope { resources: vec![ResourceRef::Definition { id: reference.id.clone() }], fields: vec![reference.clone()], modes: vec![world_protocol::authorization::AccessMode::Read], scope: definition.scope.clone(), valid_time: None });
            }
        }
        let (dependencies, captured) = dependency_inputs_authority(tx, authority, read, &release, now).await?;
        if let Some(captured) = captured { impact.access.extend(captured.access); impact.effects.extend(captured.effects); impact.labels.extend(captured.labels); impact.state.extend(captured.state); impact.source_ids.extend(captured.source_ids); }
        let evidence: Vec<_> = dependencies.into_iter().filter(|dependency| matches!(dependency, world_protocol::provenance::ReadDependency::Evidence { .. })).collect();
        if let Some(material) = crate::facts::support::dependency_impact(tx, &evidence, &release, &read.context.scope, &read.context.valid_time).await? {
            impact.access.extend(material.access); impact.effects.extend(material.effects); impact.labels.extend(material.labels); impact.state.extend(material.state); impact.source_ids.extend(material.source_ids);
        }
        let impact = authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?;
        authority.check(tx, &impact, now).await?;
        let references: Vec<_> = evidence.into_iter().filter_map(|dependency| match dependency { world_protocol::provenance::ReadDependency::Evidence { reference } => Some(reference), _ => None }).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        match authority {
            ReadAuthority::Admitted(admission) => {
                crate::facts::assertions::require_evidence_custody_transaction(tx, admission, &references, &read.context.scope, Some(&read.context.valid_time), now).await?;
                authorization::check_admitted_output(tx, admission, &impact, read.rows.len() as u64, now).await?;
            },
            ReadAuthority::Verified(verified) => {
                crate::facts::assertions::require_evidence_preflight(tx, verified, &references, &read.context.scope, Some(&read.context.valid_time), now).await?;
                authorization::check_impact_read_output(tx, verified, &impact, read.rows.len() as u64, now).await?;
            },
        }
        Ok(impact)
    })
}
pub(super) async fn read_transaction(tx: &WorldTransaction<'_>, id: &ReadReceiptId) -> Result<StoredRead, QueryError> {
    let row = tx.query_opt(READ, &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?.ok_or(QueryFailure::CursorInvalid)?;
    checked(row, tx.world(), id)
}
pub(super) async fn read_snapshot(snapshot: &WorldSnapshot<'_>, id: &ReadReceiptId) -> Result<StoredRead, QueryError> {
    let row = snapshot.query_opt(READ, &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &id.as_str()]).await?.ok_or(QueryFailure::CursorInvalid)?;
    checked(row, snapshot.world(), id)
}
fn checked(row: Row, world: &WorldRef, id: &ReadReceiptId) -> Result<StoredRead, QueryError> {
    let StoredReceipt { receipt, context, row_subjects, input, origin } = decode(row.get("body")).map_err(|_| QueryFailure::BasisChanged)?;
    let decision: Decision = decode(row.get("decision"))?;
    let rows: Vec<QueryRow> = decode(row.get("rows"))?;
    let objects: Vec<ObjectView> = decode(row.get("objects"))?;
    let relations: Vec<RelationView> = decode(row.get("relations"))?;
    let impact: ActualImpact = decode(row.get("impact"))?;
    let actor = ActorId::try_new(row.get::<_, String>("actor_id")).map_err(|_| QueryFailure::InternalFault)?;
    if receipt.world != *world || receipt.id != *id || receipt.id.as_str() != row.get::<_, String>("receipt_id")
        || receipt.decision_id.as_str() != row.get::<_, String>("decision_id")
        || receipt.query_digest.as_str() != row.get::<_, String>("query_digest")
        || receipt.evaluated_scope_digest.as_str() != row.get::<_, String>("scope_digest")
        || i64::try_from(receipt.policy_epoch.0).ok() != Some(row.get("policy_epoch"))
        || i64::try_from(receipt.grant_epoch.0).ok() != Some(row.get("grant_epoch"))
        || receipt.release_id.as_str() != row.get::<_, String>("release_id")
        || receipt.activation_lock_id.as_str() != row.get::<_, String>("activation_lock_id")
        || decision.id != receipt.decision_id || decision.invocation_id.as_str() != row.get::<_, String>("invocation_id")
        || decision.policy_epoch != receipt.policy_epoch || decision.grant_epoch != receipt.grant_epoch
        || receipt.coverage.scope_digest != receipt.evaluated_scope_digest
        || objects.iter().any(|object| object.object.world != *world || object.receipt_id != *id)
        || relations.iter().any(|relation| relation.relation.world != *world || relation.receipt_id != *id)
        || authorization::actual_impact(impact.access.clone(), impact.effects.clone(), impact.labels.clone(), impact.state.clone(), impact.source_ids.clone())?.digest != impact.digest {
        return Err(QueryFailure::BasisChanged.into());
    }
    if context.branch_model.as_ref().map(|(branch, _)| (&branch.world, &branch.id)) != receipt.branch_id.as_ref().map(|id| (world, id))
        || context.captures.iter().any(|(binding, _)| &binding.world != world)
        || row_subjects.len() != rows.len()
        || context.valid_time.to.as_ref().is_some_and(|to| to <= &context.valid_time.from)
        || (context.branch_model.is_none() && (context.frozen_model.is_some() || !context.captures.is_empty() || !context.derivations.is_empty() || context.capture_selection != CaptureSelection::Selected)) { return Err(QueryFailure::BasisChanged.into()); }
    input.check(&receipt, &context)?;
    if let Some(origin) = &origin {
        origin.input.check(&origin.receipt, &origin.context)?;
        if origin.receipt.world != receipt.world || origin.receipt.id == receipt.id || context.capture_selection != CaptureSelection::Target { return Err(QueryFailure::BasisChanged.into()); }
    }
    Ok(StoredRead { receipt, rows, row_subjects, objects, relations, impact, actor, context, input, origin })
}

fn check_page(read: &StoredRead, request: &QueryRequest, scope: &ScopeId, page: &QueryPage) -> Result<(), QueryError> {
    let offset = if let Some(cursor) = &request.page.cursor { let (id, offset) = self::cursor(cursor)?; if id != read.receipt.id { return Err(QueryFailure::CursorInvalid.into()); } offset } else { 0 };
    if request.world != read.receipt.world || request.branch_id != read.receipt.branch_id
        || request.release_id.as_ref().is_some_and(|id| id != &read.receipt.release_id)
        || read.receipt.query_digest != super::execution::query_digest(request)? || &read.context.scope != scope
        || self::page(read, offset, request.page.limit)? != *page { return Err(QueryFailure::BasisChanged.into()); }
    Ok(())
}
pub(crate) async fn recheck_page(store: &crate::store::WorldStore, content: &crate::content::Content, admission: &Admission, request: &QueryRequest, scope: &ScopeId, page: &QueryPage, budget: &crate::extensions::invocation::CallBudget, cancel: &tokio_util::sync::CancellationToken) -> Result<(world_protocol::releases::Release, ActualImpact), QueryError> {
    budget.check().map_err(super::execution::budget_error)?;
    if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
    if request.world != admission.invocation().world { return Err(super::error::invalid("world")); }
    let verified = if request.branch_id.is_some() {
        let saved_admission = admission.clone(); let request = request.clone(); let scope = scope.clone(); let page = page.clone();
        let basis = store.snapshot(request.world.clone(), move |snapshot| Box::pin(async move {
            let now = snapshot.now().await?;
            authorization::recheck_read(snapshot, &saved_admission, &now).await?;
            let read = read_snapshot(snapshot, &page.receipt.id).await?;
            require_current(&read, &saved_admission, &now)?;
            check_page(&read, &request, &scope, &page)?;
            Ok::<_, QueryError>(super::branch::retained_basis_snapshot(snapshot, &saved_admission, &request, &scope, &read).await?.0)
        })).await?;
        for capture in &basis.captures { crate::sources::sync::verify_branch_capture(store, content, admission, capture, budget, cancel).await?; }
        Some(basis)
    } else { None };
    budget.check().map_err(super::execution::budget_error)?;
    if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
    let admission = admission.clone(); let request = request.clone(); let scope = scope.clone(); let page = page.clone();
    store.snapshot(request.world.clone(), move |snapshot| Box::pin(async move {
        recheck_page_snapshot(snapshot, &admission, &request, &scope, &page, verified.as_ref()).await
    })).await
}
pub(crate) async fn recheck_page_in_transaction(tx: &WorldTransaction<'_>, admission: &Admission, request: &QueryRequest, scope: &ScopeId, page: &QueryPage) -> Result<(world_protocol::releases::Release, ActualImpact), QueryError> {
    let now = tx.now().await?;
    authorization::recheck(tx, admission, &now).await?;
    let read = read_transaction(tx, &page.receipt.id).await?;
    require_current(&read, admission, &now)?;
    check_page(&read, request, scope, page)?;
    let release = read_model(tx, ReadAuthority::Admitted(admission), &read, &now).await?;
    if request.release_id.as_ref().is_some_and(|id| id != &release.id) { return Err(QueryFailure::BasisChanged.into()); }
    let mut current = if request.branch_id.is_some() {
        super::branch::retained_transaction(tx, admission, request, scope, &read).await?
    } else {
        if read.context.branch_model.is_some() { return Err(QueryFailure::BasisChanged.into()); }
        super::metadata::impact_for_transaction(tx, &super::plan::check(&request.query, &release)?, &release, scope).await?
    };
    recheck_dependencies(tx, admission, &read, &release, &now).await?;
    let output = recheck_output(tx, admission, &read, &now).await?;
    current.access.extend(output.access); current.effects.extend(output.effects); current.labels.extend(output.labels); current.state.extend(output.state); current.source_ids.extend(output.source_ids);
    let impact = authorization::actual_impact(current.access, current.effects, current.labels, current.state, current.source_ids)?;
    admission.require_access(&impact)?;
    authorization::check_admitted_output(tx, admission, &impact, page.rows.items.len() as u64, &now).await?;
    Ok((release, impact))
}
async fn recheck_page_snapshot(snapshot: &WorldSnapshot<'_>, admission: &Admission, request: &QueryRequest, scope: &ScopeId, page: &QueryPage, verified: Option<&super::branch::VerifiedBasis>) -> Result<(world_protocol::releases::Release, ActualImpact), QueryError> {
    let now = snapshot.now().await?;
    authorization::recheck_read(snapshot, admission, &now).await?;
    let read = read_snapshot(snapshot, &page.receipt.id).await?;
    require_current(&read, admission, &now)?;
    check_page(&read, request, scope, page)?;
    let (release, current) = if request.branch_id.is_some() {
        verified.ok_or(QueryFailure::BasisChanged)?.recheck_retained_snapshot(snapshot, admission, request, scope, &read).await?
    } else {
        let mut release = crate::releases::read_release_snapshot(snapshot, &read.receipt.release_id).await?.ok_or(QueryFailure::BasisChanged)?;
        release.source_branch = None;
        let plan = super::plan::check(&request.query, &release)?;
        if read.context.branch_model.is_some() || read.receipt.release_id != release.id || read.receipt.activation_lock_id != release.artifact.activation_lock_id || super::execution::evaluated_scope_digest(&read.context, &release, &read.impact)? != read.receipt.evaluated_scope_digest { return Err(QueryFailure::BasisChanged.into()); }
        let current = super::metadata::impact_for(snapshot, &plan, &release, scope).await?;
        (release, current)
    };
    let active_id = crate::releases::read_active_release_snapshot(snapshot).await?.ok_or(QueryFailure::BasisChanged)?;
    let active = crate::releases::read_release_snapshot(snapshot, &active_id).await?.ok_or(QueryFailure::BasisChanged)?;
    let mut output = read.impact.clone();
    let fields: std::collections::BTreeSet<_> = output.access.iter().flat_map(|access| access.fields.iter().cloned()).collect();
    for reference in fields {
        let exact = release.definitions.iter().find(|definition| definition.reference == reference).ok_or(QueryFailure::BasisChanged)?;
        for definition in std::iter::once(exact).chain(active.definitions.iter().filter(|definition| definition.reference.id == reference.id)) {
            if definition.body.kind() != exact.body.kind() { return Err(QueryFailure::BasisChanged.into()); }
            if let world_protocol::definitions::DefinitionBody::Property(body) = &definition.body { output.labels.extend(body.access_labels.clone()); }
            output.access.push(world_protocol::authorization::AccessScope { resources: vec![ResourceRef::Definition { id: reference.id.clone() }], fields: vec![reference.clone()], modes: vec![world_protocol::authorization::AccessMode::Read], scope: definition.scope.clone(), valid_time: None });
        }
    }
    let (dependencies, captured) = dependency_inputs_snapshot(snapshot, admission, &read, &release, &now).await?;
    crate::facts::support::recheck_dependencies_snapshot_in_model(snapshot, &dependencies, &release, &read.context.scope, &read.context.valid_time, &now).await?;
    if let Some(captured) = captured { output.access.extend(captured.access); output.effects.extend(captured.effects); output.labels.extend(captured.labels); output.state.extend(captured.state); output.source_ids.extend(captured.source_ids); }
    let evidence: Vec<_> = dependencies.into_iter().filter(|dependency| matches!(dependency, world_protocol::provenance::ReadDependency::Evidence { .. })).collect();
    if let Some(material) = crate::facts::support::dependency_impact_snapshot(snapshot, &evidence, &release, &read.context.scope, &read.context.valid_time).await? {
        output.access.extend(material.access); output.effects.extend(material.effects); output.labels.extend(material.labels); output.state.extend(material.state); output.source_ids.extend(material.source_ids);
    }
    let output = authorization::actual_impact(output.access, output.effects, output.labels, output.state, output.source_ids)?;
    admission.require_access(&output)?;
    let references: Vec<_> = evidence.into_iter().filter_map(|dependency| match dependency { world_protocol::provenance::ReadDependency::Evidence { reference } => Some(reference), _ => None }).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    crate::facts::assertions::require_evidence_snapshot(snapshot, admission, &references, &read.context.scope, Some(&read.context.valid_time), &now).await?;
    authorization::check_admitted_output_read(snapshot, admission, &output, page.rows.items.len() as u64, &now).await?;
    admission.require_access(&current)?;
    authorization::check_admitted_output_read(snapshot, admission, &current, page.rows.items.len() as u64, &now).await?;
    authorization::check_admitted_output_read(snapshot, admission, &read.impact, page.rows.items.len() as u64, &now).await?;
    let impact = authorization::actual_impact(current.access.into_iter().chain(output.access).collect(), current.effects.into_iter().chain(output.effects).collect(), current.labels.into_iter().chain(output.labels).collect(), current.state.into_iter().chain(output.state).collect(), current.source_ids.into_iter().chain(output.source_ids).collect())?;
    admission.require_access(&impact)?;
    authorization::check_admitted_output_read(snapshot, admission, &impact, page.rows.items.len() as u64, &now).await?;
    Ok((release, impact))
}

pub(super) async fn persist(tx: &WorldTransaction<'_>, admission: &Admission, read: &StoredRead) -> Result<(), QueryError> {
    let r = &read.receipt;
    read.input.check(r, &read.context)?;
    if let Some(origin) = &read.origin {
        let original = read_transaction(tx, &origin.receipt.id).await?;
        if original.receipt != origin.receipt || encode(&original.input)? != encode(&origin.input)? || encode(&original.context)? != encode(&origin.context)? { return Err(QueryFailure::BasisChanged.into()); }
    }
    if tx.world() != &r.world || r.decision_id != admission.decision().id
        || r.policy_epoch != admission.decision().policy_epoch || r.grant_epoch != admission.decision().grant_epoch {
        return Err(QueryFailure::BasisChanged.into());
    }
    tx.execute("INSERT INTO world_read_receipt(tenant_id,world_id,receipt_id,invocation_id,decision_id,query_digest,scope_digest,policy_epoch,grant_epoch,release_id,activation_lock_id,body,rows,objects,relations,impact) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
        &[&r.world.tenant_id.as_str(), &r.world.world_id.as_str(), &r.id.as_str(), &admission.invocation().id.as_str(), &r.decision_id.as_str(), &r.query_digest.as_str(), &r.evaluated_scope_digest.as_str(),
          &number(r.policy_epoch.0)?, &number(r.grant_epoch.0)?, &r.release_id.as_str(), &r.activation_lock_id.as_str(), &encode(&StoredReceipt { receipt: r.clone(), context: read.context.clone(), row_subjects: read.row_subjects.clone(), input: read.input.clone(), origin: read.origin.clone() })?, &encode(&read.rows)?, &encode(&read.objects)?, &encode(&read.relations)?, &encode(&read.impact)?]).await?;
    Ok(())
}
pub(super) fn cursor(value: &str) -> Result<(ReadReceiptId, usize), QueryError> {
    let (id, offset) = value.rsplit_once(':').ok_or(QueryFailure::CursorInvalid)?;
    let id = ReadReceiptId::try_new(id).map_err(|_| QueryFailure::CursorInvalid)?;
    let offset = offset.parse::<usize>().map_err(|_| QueryFailure::CursorInvalid)?;
    Ok((id, offset))
}
pub(super) fn page(read: &StoredRead, offset: usize, limit: u32) -> Result<QueryPage, QueryError> {
    if limit == 0 || limit > world_protocol::api::MAX_PAGE_ITEMS || offset > read.rows.len() || read.row_subjects.len() != read.rows.len() { return Err(QueryFailure::CursorInvalid.into()); }
    let end = offset.saturating_add(limit as usize).min(read.rows.len());
    let next_cursor = (end < read.rows.len()).then(|| format!("{}:{end}", read.receipt.id));
    let mut roots = crate::store::RetentionRoots::default();
    for row in &read.rows[offset..end] { for column in &row.columns { retain_cell(&mut roots, column.cell.clone()); } }
    let mut pending: Vec<_> = read.row_subjects[offset..end].iter().flatten().cloned().collect();
    pending.extend(subject_resources(roots.resources));
    let mut included = std::collections::BTreeSet::new();
    let mut objects = Vec::new(); let mut relations = Vec::new();
    while let Some(subject) = pending.pop() {
        if !included.insert(subject.clone()) { continue; }
        let mut roots = crate::store::RetentionRoots::default();
        match subject {
            world_protocol::identity::SubjectRef::Object { id } => {
                if let Some(view) = read.objects.iter().find(|view| view.object.id == id) {
                    for field in &view.fields { retain_cell(&mut roots, field.cell.clone()); }
                    objects.push(view.clone());
                }
            },
            world_protocol::identity::SubjectRef::Relation { id } => {
                if let Some(view) = read.relations.iter().find(|view| view.relation.id == id) {
                    for field in &view.fields { retain_cell(&mut roots, field.cell.clone()); }
                    pending.extend(view.roles.iter().map(|role| world_protocol::identity::SubjectRef::Object { id: role.object_id.clone() }));
                    relations.push(view.clone());
                }
            },
        }
        pending.extend(subject_resources(roots.resources));
    }
    objects.sort_by(|left, right| left.object.id.cmp(&right.object.id));
    relations.sort_by(|left, right| left.relation.id.cmp(&right.relation.id));
    Ok(QueryPage { rows: Page { items: read.rows[offset..end].to_vec(), next_cursor }, objects, relations, receipt: read.receipt.clone() })
}
fn subject_resources(resources: Vec<ResourceRef>) -> impl Iterator<Item = world_protocol::identity::SubjectRef> {
    resources.into_iter().filter_map(|resource| match resource { ResourceRef::Object { id } => Some(world_protocol::identity::SubjectRef::Object { id }), ResourceRef::Relation { id } => Some(world_protocol::identity::SubjectRef::Relation { id }), _ => None })
}
pub(super) fn require_current(read: &StoredRead, admission: &Admission, now: &Timestamp) -> Result<(), QueryError> {
    require_current_authority(read, ReadAuthority::Admitted(admission), now)
}
pub(super) fn require_current_authority(read: &StoredRead, authority: ReadAuthority<'_>, now: &Timestamp) -> Result<(), QueryError> {
    let invocation = authority.verified().invocation();
    let actor = match &invocation.actor { world_protocol::authorization::Actor::Human { id } | world_protocol::authorization::Actor::Service { id } => id };
    if &read.actor != actor || read.receipt.world != invocation.world
        || read.receipt.expires_at.as_ref().is_some_and(|expires| now >= expires) {
        return Err(QueryFailure::CursorInvalid.into());
    }
    if let ReadAuthority::Admitted(admission) = authority { admission.require_access(&read.impact)?; }
    Ok(())
}
fn number(value: u64) -> Result<i64, QueryError> { i64::try_from(value).ok().filter(|value| *value > 0).ok_or_else(|| QueryFailure::InternalFault.into()) }
