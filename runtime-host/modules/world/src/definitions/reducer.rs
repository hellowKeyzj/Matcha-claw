use std::collections::BTreeSet;

use world_protocol::{
    authorization::{AccessMode, AccessScope},
    commit::CommittedRevision,
    definitions::{
        Definition, DefinitionBody, DefinitionEvidenceBinding, DefinitionFailure,
        DefinitionFieldReason as Reason, DefinitionLifecycle, Scope,
    },
    failure::FieldPath,
    ids::{DefinitionId, DefinitionRef, EventId, ResourceRef, Revision},
    time::Timestamp,
};

use super::{
    DefinitionError, canonical_digest, invalid,
    read::{encode, revision},
    read_definition, read_scopes, validate_expression, validate_revision,
};
use crate::{
    authorization::{self, Admission},
    store::{OutboxEvent, WorldTransaction},
};

type Model = Definition<DefinitionBody>;

/// Built-ins use this entry; extensions additionally require the checked publication entry.
pub(crate) async fn apply_definitions(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    definitions: &[Model],
) -> Result<Vec<DefinitionRef>, DefinitionError> {
    apply_definitions_checked(tx, admission, definitions, &[]).await
}

pub(crate) async fn apply_definitions_checked(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    definitions: &[Model],
    kinds: &[super::CheckedKind],
) -> Result<Vec<DefinitionRef>, DefinitionError> {
    require_writer(tx)?;
    for definition in definitions {
        if matches!(definition.body, DefinitionBody::Extension(_)) {
            super::KindRegistry::require_executable(definition, kinds)?;
        }
    }
    if definitions.is_empty() || definitions.len() > 4096 {
        return Err(invalid(&["definitions".into()], Reason::IncompleteContract).into());
    }
    let mut ordered: Vec<_> = definitions.iter().collect();
    ordered.sort_unstable_by(|left, right| left.reference.id.cmp(&right.reference.id));
    if ordered
        .windows(2)
        .any(|pair| pair[0].reference.id == pair[1].reference.id)
    {
        return Err(invalid(&["definitions".into()], Reason::Duplicate).into());
    }
    let now = database_now(tx).await?;
    let impact = authorization::actual_impact(
        definitions
            .iter()
            .map(|definition| AccessScope {
                resources: vec![ResourceRef::Definition {
                    id: definition.reference.id.clone(),
                }],
                fields: Vec::new(),
                modes: vec![AccessMode::Write],
                scope: definition.scope.clone(),
                valid_time: Some(definition.valid_time.clone()),
            })
            .collect(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, &now).await?;
    let world = tx.world().clone();
    let mut candidates = definitions.to_vec();
    let mut references = BTreeSet::new();
    let mut scopes = BTreeSet::new();
    for definition in &ordered {
        if definition.reference.world != world {
            return Err(DefinitionFailure::CrossWorldReference {
                reference: definition.reference.clone(),
            }
            .into());
        }
        let kind = kind_name(definition.body.kind())?;
        tx.execute(
            "INSERT INTO world_definition_identity(tenant_id,world_id,definition_id,kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &definition.reference.id.as_str(), &kind],
        ).await?;
        let identity = tx.query_opt(
            "SELECT kind FROM world_definition_identity WHERE tenant_id=$1 AND world_id=$2 AND definition_id=$3 FOR UPDATE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &definition.reference.id.as_str()],
        ).await?.ok_or(DefinitionFailure::InternalFault)?;
        if identity.get::<_, String>("kind") != kind {
            return Err(DefinitionFailure::LifecycleConflict.into());
        }
        let previous = super::read_definition_head(tx, &definition.reference.id).await?;
        let expected = definition
            .previous_ref
            .as_ref()
            .map_or(Revision(0), |reference| reference.revision);
        let actual = previous
            .as_ref()
            .map_or(Revision(0), |previous| previous.reference.revision);
        if expected != actual {
            return Err(conflict(&definition.reference.id, expected, actual, "body"));
        }
        let next = super::read::next_definition_revision(tx, &definition.reference.id).await?;
        if definition.reference.revision != next {
            return Err(conflict(
                &definition.reference.id,
                definition.reference.revision,
                next,
                "revision",
            ));
        }
        validate_revision(previous.as_ref(), definition)?;
        if let Some(previous) = previous {
            candidates.push(previous);
        }
        references.extend(definition.dependencies.iter().cloned());
        match &definition.lifecycle {
            DefinitionLifecycle::Deprecated { replacements, .. }
            | DefinitionLifecycle::Split { replacements, .. } => {
                references.extend(replacements.iter().cloned())
            }
            _ => {}
        }
        scopes.insert(definition.scope.clone());
    }
    for reference in references {
        if reference.world != world {
            return Err(DefinitionFailure::CrossWorldReference { reference }.into());
        }
        if !candidates
            .iter()
            .any(|candidate| candidate.reference == reference)
        {
            let target = read_definition(tx, &reference).await?.ok_or_else(|| {
                DefinitionFailure::MissingReference {
                    reference: reference.clone(),
                }
            })?;
            candidates.push(target);
        }
        // Immutable historical revisions cannot bypass the current lifecycle head.
        let current = match definitions
            .iter()
            .find(|candidate| candidate.reference.id == reference.id)
        {
            Some(current) => current.clone(),
            None => super::read_definition_head(tx, &reference.id)
                .await?
                .ok_or_else(|| DefinitionFailure::MissingReference {
                    reference: reference.clone(),
                })?,
        };
        if let DefinitionLifecycle::Deprecated { effective_at, .. }
        | DefinitionLifecycle::Split { effective_at, .. } = &current.lifecycle
        {
            if definitions
                .iter()
                .filter(|definition| definition.dependencies.contains(&reference))
                .any(|definition| {
                    definition
                        .valid_time
                        .to
                        .as_ref()
                        .is_none_or(|to| to > effective_at)
                })
            {
                return Err(DefinitionFailure::DeprecatedReference {
                    reference: current.reference,
                }
                .into());
            }
        }
    }
    scopes.extend(candidates.iter().map(|definition| definition.scope.clone()));
    let scopes = read_scopes(tx, &scopes.into_iter().collect::<Vec<_>>()).await?;
    let validator = super::DefinitionValidator::new(&candidates, &scopes)?;
    let mut execution = candidates.clone();
    for definition in &mut execution {
        if let Some(kind) = kinds.iter().find(|kind| kind.definition() == definition) {
            definition.body = kind.lowered().clone();
            definition.content_digest = super::content_digest(definition)?;
        }
    }
    execution.retain(|definition| !matches!(definition.body, DefinitionBody::Extension(_))
        || !kinds.iter().any(|kind| kind.definition().previous_ref.as_ref() == Some(&definition.reference)));
    let execution_validator = super::DefinitionValidator::new(&execution, &scopes)?;
    for definition in &ordered {
        if matches!(definition.body, DefinitionBody::Extension(_)) {
            validator.validate(definition)?;
        }
        let scope = scopes
            .iter()
            .find(|scope| scope.world == world && scope.id == definition.scope)
            .ok_or_else(|| invalid(&["scope".into()], Reason::IncompleteContract))?;
        let executable = execution.iter().find(|candidate| candidate.reference == definition.reference)
            .ok_or(DefinitionFailure::InternalFault)?;
        execution_validator.validate(executable)?;
        crate::compiler::check_scope(scope, executable, &execution, &scopes)?;
        validate_existing_callers(tx, definition, definitions).await?;
    }
    for definition in &ordered {
        let revision = revision(definition.reference.revision)?;
        let previous = definition
            .previous_ref
            .as_ref()
            .map(|reference| revision_number(reference.revision))
            .transpose()?;
        let kind = kind_name(definition.body.kind())?;
        let lifecycle = match definition.lifecycle {
            DefinitionLifecycle::Available => "available",
            DefinitionLifecycle::Deprecated { .. } => "deprecated",
            DefinitionLifecycle::Split { .. } => "split",
        };
        tx.execute(
            "INSERT INTO world_definition_revision(tenant_id,world_id,definition_id,revision,kind,scope_id,valid_from,valid_to,content_digest,previous_revision,lifecycle,body,valid_from_ns,valid_to_ns) VALUES($1,$2,$3,$4,$5,$6,$7::text::timestamptz,$8::text::timestamptz,$9,$10,$11,$12,$13::text::numeric,$14::text::numeric)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &definition.reference.id.as_str(), &revision,
              &kind, &definition.scope.as_str(), &definition.valid_time.from.as_str(), &definition.valid_time.to.as_ref().map(Timestamp::as_str),
              &definition.content_digest.as_str(), &previous, &lifecycle, &encode(definition)?,
              &definition.valid_time.from.unix_nanos().to_string(), &definition.valid_time.to.as_ref().map(|time| time.unix_nanos().to_string())],
        ).await?;
        let changed = if let Some(previous) = previous {
            tx.execute("UPDATE world_definition_head SET revision=$4 WHERE tenant_id=$1 AND world_id=$2 AND definition_id=$3 AND revision=$5",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &definition.reference.id.as_str(), &revision, &previous]).await?
        } else {
            tx.execute("INSERT INTO world_definition_head(tenant_id,world_id,definition_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &definition.reference.id.as_str(), &revision]).await?
        };
        tx.require_changed(
            changed,
            ResourceRef::Definition {
                id: definition.reference.id.clone(),
            },
        )?;
    }
    // Definitions may refer forward to any other revision in this admitted batch.
    for definition in ordered {
        super::KindRegistry::index(tx, definition).await?;
        write_evidence(
            tx,
            &DefinitionEvidenceBinding {
                definition: definition.reference.clone(),
                revision: Revision(1),
                evidence: definition.evidence.clone(),
                previous_revision: None,
            },
        )
        .await?;
        tx.record_revision(CommittedRevision {
            resource: ResourceRef::Definition {
                id: definition.reference.id.clone(),
            },
            revision: definition.reference.revision,
        })?;
        emit(
            tx,
            &definition.reference,
            definition.reference.revision,
            "definition.revised",
            &encode(definition)?,
        )
        .await?;
    }
    Ok(definitions
        .iter()
        .map(|definition| definition.reference.clone())
        .collect())
}

pub(crate) async fn apply_definition_evidence(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    binding: &DefinitionEvidenceBinding,
) -> Result<DefinitionEvidenceBinding, DefinitionError> {
    require_writer(tx)?;
    let definition = read_definition(tx, &binding.definition)
        .await?
        .ok_or_else(|| DefinitionFailure::MissingReference {
            reference: binding.definition.clone(),
        })?;
    let now = database_now(tx).await?;
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: vec![ResourceRef::Definition {
                id: definition.reference.id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Write],
            scope: definition.scope,
            valid_time: Some(definition.valid_time),
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, &now).await?;
    write_evidence(tx, binding).await?;
    emit(
        tx,
        &binding.definition,
        binding.revision,
        "definition.evidence_revised",
        &encode(binding)?,
    )
    .await?;
    Ok(binding.clone())
}

async fn write_evidence(
    tx: &WorldTransaction<'_>,
    binding: &DefinitionEvidenceBinding,
) -> Result<(), DefinitionError> {
    let world = tx.world();
    if &binding.definition.world != world {
        return Err(DefinitionFailure::CrossWorldReference {
            reference: binding.definition.clone(),
        }
        .into());
    }
    let definition_revision = revision(binding.definition.revision)?;
    let next = revision(binding.revision)?;
    let expected = binding.previous_revision.unwrap_or(Revision(0));
    if expected.0.checked_add(1) != Some(binding.revision.0) {
        return Err(DefinitionFailure::LifecycleConflict.into());
    }
    tx.query_opt("SELECT definition_id FROM world_definition_identity WHERE tenant_id=$1 AND world_id=$2 AND definition_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.definition.id.as_str()]).await?;
    let current = tx.query_opt(
        "SELECT revision FROM world_definition_evidence_head WHERE tenant_id=$1 AND world_id=$2 AND definition_id=$3 AND definition_revision=$4 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.definition.id.as_str(), &definition_revision],
    ).await?;
    let actual = current.map_or(Revision(0), |row| {
        Revision(row.get::<_, i64>("revision") as u64)
    });
    if actual != expected {
        return Err(conflict(
            &binding.definition.id,
            expected,
            actual,
            "evidence",
        ));
    }
    let mut unique = BTreeSet::new();
    for evidence in &binding.evidence {
        if &evidence.world != world || !unique.insert(evidence) {
            return Err(invalid(&["evidence".into()], Reason::Duplicate).into());
        }
        let row = tx.query_opt(
            "SELECT r.status FROM world_evidence_revision r JOIN world_evidence_head h USING(tenant_id,world_id,evidence_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.evidence_id=$3 AND r.revision=$4 AND h.revision=r.revision FOR SHARE OF h",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &evidence.id.as_str(), &revision(evidence.revision)?],
        ).await?;
        if row.is_none_or(|row| row.get::<_, String>("status") != "active") {
            return Err(invalid(
                &["evidence".into(), evidence.id.to_string()],
                Reason::IncompleteContract,
            )
            .into());
        }
    }
    let previous = binding.previous_revision.map(revision).transpose()?;
    tx.execute("INSERT INTO world_definition_evidence_revision(tenant_id,world_id,definition_id,definition_revision,revision,previous_revision,body) VALUES($1,$2,$3,$4,$5,$6,$7)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.definition.id.as_str(), &definition_revision, &next, &previous, &encode(binding)?]).await?;
    let changed = if let Some(previous) = previous {
        tx.execute("UPDATE world_definition_evidence_head SET revision=$5 WHERE tenant_id=$1 AND world_id=$2 AND definition_id=$3 AND definition_revision=$4 AND revision=$6",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.definition.id.as_str(), &definition_revision, &next, &previous]).await?
    } else {
        tx.execute("INSERT INTO world_definition_evidence_head(tenant_id,world_id,definition_id,definition_revision,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.definition.id.as_str(), &definition_revision, &next]).await?
    };
    tx.require_changed(
        changed,
        ResourceRef::Definition {
            id: binding.definition.id.clone(),
        },
    )?;
    for evidence in &binding.evidence {
        tx.execute("INSERT INTO world_definition_evidence(tenant_id,world_id,definition_id,definition_revision,binding_revision,evidence_id,evidence_revision) VALUES($1,$2,$3,$4,$5,$6,$7)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.definition.id.as_str(), &definition_revision, &next, &evidence.id.as_str(), &revision(evidence.revision)?]).await?;
    }
    Ok(())
}

pub(crate) async fn apply_scope(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    scope: &Scope,
) -> Result<(), DefinitionError> {
    require_writer(tx)?;
    if &scope.world != tx.world() {
        return Err(invalid(&["scope".into()], Reason::IncompleteContract).into());
    }
    validate_expression(&scope.predicate)?;
    let now = database_now(tx).await?;
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: Vec::new(),
            fields: Vec::new(),
            modes: vec![AccessMode::Manage],
            scope: scope.id.clone(),
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, &now).await?;
    write_scope(tx, scope).await
}

/// Trusted composition creates only the universal first scope, never an unchecked executable predicate.
pub(crate) async fn bootstrap_scope(
    tx: &mut WorldTransaction<'_>,
    _authority: &crate::authorization::AuthorityRoot,
    scope: &Scope,
) -> Result<(), DefinitionError> {
    tx.require_provision()?;
    require_writer(tx)?;
    if &scope.world != tx.world()
        || scope.predicate
            != (world_protocol::expression::ExpressionIr::Literal {
                value: world_protocol::value::Value::Boolean { value: true },
            })
    {
        return Err(invalid(&["scope".into()], Reason::IncompleteContract).into());
    }
    write_scope(tx, scope).await
}

async fn write_scope(tx: &WorldTransaction<'_>, scope: &Scope) -> Result<(), DefinitionError> {
    let digest = canonical_digest(scope)?;
    let world = tx.world();
    let changed = tx.execute("INSERT INTO world_scope_revision(tenant_id,world_id,scope_id,revision,content_digest,body) VALUES($1,$2,$3,1,$4,$5) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &scope.id.as_str(), &digest.as_str(), &encode(scope)?]).await?;
    if changed != 1 {
        let scopes = read_scopes(tx, std::slice::from_ref(&scope.id)).await?;
        if scopes.len() != 1 || scopes[0] != *scope {
            return Err(invalid(&["scope".into()], Reason::Duplicate).into());
        }
    }
    Ok(())
}

async fn validate_existing_callers(
    tx: &WorldTransaction<'_>,
    next: &Model,
    batch: &[Model],
) -> Result<(), DefinitionError> {
    let effective = match &next.lifecycle {
        DefinitionLifecycle::Available => return Ok(()),
        DefinitionLifecycle::Deprecated { effective_at, .. }
        | DefinitionLifecycle::Split { effective_at, .. } => effective_at,
    };
    let world = tx.world();
    let rows = tx.query(
        "SELECT DISTINCT r.body FROM world_definition_dependency d JOIN world_definition_head h ON h.tenant_id=d.tenant_id AND h.world_id=d.world_id AND h.definition_id=d.definition_id AND h.revision=d.revision JOIN world_definition_revision r ON r.tenant_id=h.tenant_id AND r.world_id=h.world_id AND r.definition_id=h.definition_id AND r.revision=h.revision WHERE d.tenant_id=$1 AND d.world_id=$2 AND d.dependency_id=$3 ORDER BY r.body",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &next.reference.id.as_str()],
    ).await?;
    for row in rows {
        let caller: Model = super::read::decode(row.get("body"))?;
        if batch
            .iter()
            .any(|replacement| replacement.reference.id == caller.reference.id)
        {
            continue;
        }
        if caller
            .valid_time
            .to
            .as_ref()
            .is_some_and(|to| to <= effective)
        {
            continue;
        }
        return Err(DefinitionFailure::DeprecatedReference {
            reference: next.reference.clone(),
        }
        .into());
    }
    Ok(())
}

fn conflict(
    id: &DefinitionId,
    expected: Revision,
    actual: Revision,
    path: &str,
) -> DefinitionError {
    DefinitionFailure::HeadConflict {
        definition_id: id.clone(),
        expected,
        actual,
        fields: vec![FieldPath(vec![path.into()])],
    }
    .into()
}

pub(super) async fn database_now(tx: &WorldTransaction<'_>) -> Result<Timestamp, DefinitionError> {
    Ok(tx.now().await?)
}

pub(super) fn require_writer(tx: &WorldTransaction<'_>) -> Result<(), DefinitionError> {
    let domain = world_protocol::ids::WriterDomain::try_new("definitions")
        .map_err(|_| DefinitionFailure::InternalFault)?;
    Ok(tx.require_domain(&domain)?)
}

fn revision_number(value: Revision) -> Result<i64, DefinitionError> {
    Ok(revision(value)?)
}

fn kind_name(kind: world_protocol::definitions::DefinitionKind) -> Result<String, DefinitionError> {
    serde_json::to_value(kind)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| DefinitionFailure::InternalFault.into())
}

pub(super) async fn lineage(
    tx: &WorldTransaction<'_>,
    source: &DefinitionRef,
    target: &DefinitionRef,
    kind: &str,
) -> Result<(), DefinitionError> {
    let world = tx.world();
    tx.execute("INSERT INTO world_definition_lineage(tenant_id,world_id,definition_id,revision,target_id,target_revision,kind) VALUES($1,$2,$3,$4,$5,$6,$7)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &source.id.as_str(), &revision(source.revision)?, &target.id.as_str(), &revision(target.revision)?, &kind]).await?;
    Ok(())
}

async fn emit(
    tx: &mut WorldTransaction<'_>,
    reference: &DefinitionRef,
    revision: Revision,
    kind: &str,
    payload: &serde_json::Value,
) -> Result<(), DefinitionError> {
    let digest = canonical_digest(&(reference, revision, kind))?;
    let event_id = EventId::try_new(format!("definition-{}", &digest.as_str()[7..]))
        .map_err(|_| DefinitionFailure::InternalFault)?;
    tx.emit(OutboxEvent {
        event_id,
        aggregate_kind: "definition".into(),
        aggregate_id: reference.id.to_string(),
        aggregate_revision: revision.0,
        event_kind: kind.into(),
        payload: payload.clone(),
        causation_id: None,
        origin: "world.definitions".into(),
    })
    .await?;
    Ok(())
}
