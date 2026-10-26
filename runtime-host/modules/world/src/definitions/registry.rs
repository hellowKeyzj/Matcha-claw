mod execution;
pub(crate) use execution::{CheckedKind, KindPlan};

use world_protocol::{
    compiler::{CompileFailure, CompileRequest, CompileResult},
    definitions::{
        Definition, DefinitionBody, DefinitionFailure, DefinitionFieldReason as Reason,
        DefinitionKind, DefinitionLifecycle, Scope,
    },
    failure::FieldPath,
    ids::{DefinitionRef, Revision},
    package::KindContract,
};

use super::{
    DefinitionError, apply_definitions, invalid, read::encode, reducer::database_now,
    validate_definition, validate_revision,
};
use crate::{
    authorization::{self, Admission},
    store::WorldTransaction,
};

type Model = Definition<DefinitionBody>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DefinitionVerb {
    Create,
    Refine,
    Deprecate,
    Split,
}

/// Standard kinds use built-ins; extensions require exact installed handlers and checked proposals.
pub(crate) struct KindRegistry;

impl KindRegistry {
    pub(crate) const STANDARD: [DefinitionKind; 13] = [
        DefinitionKind::ObjectType,
        DefinitionKind::Property,
        DefinitionKind::RelationType,
        DefinitionKind::Facet,
        DefinitionKind::ConceptView,
        DefinitionKind::Rule,
        DefinitionKind::Metric,
        DefinitionKind::Function,
        DefinitionKind::StateModel,
        DefinitionKind::ActionContract,
        DefinitionKind::Strategy,
        DefinitionKind::PolicyBinding,
        DefinitionKind::SourceBinding,
    ];

    pub(crate) fn schema() -> Result<Vec<u8>, world_protocol::schema::SchemaFailure> {
        world_protocol::schema::bytes::<Model>()
    }

    pub(crate) fn decode(kind: DefinitionKind, bytes: &[u8]) -> Result<Model, DefinitionFailure> {
        if bytes.len() > 1_048_576 {
            return Err(DefinitionFailure::LimitExceeded {
                field: FieldPath(vec!["definition".into()]),
                maximum: 1_048_576,
            });
        }
        let definition: Model = serde_json::from_slice(bytes)
            .map_err(|_| invalid(&["definition".into()], Reason::IncompleteContract))?;
        if definition.body.kind() != kind {
            return Err(DefinitionFailure::WrongKind {
                reference: definition.reference,
                expected: kind,
                actual: definition.body.kind(),
            });
        }
        super::shape::validate_body(&definition.body)?;
        Ok(definition)
    }

    pub(crate) fn validate(
        definition: &Model,
        candidates: &[Model],
        scopes: &[Scope],
    ) -> Result<(), DefinitionFailure> {
        validate_definition(definition, candidates, scopes)
    }

    /// Uses the sole mandatory type/effect checker and lowering pipeline owned by compiler.
    pub(crate) fn lower(request: &CompileRequest) -> Result<CompileResult, CompileFailure> {
        crate::compiler::compile(request)
    }

    /// Writes typed dependency/lineage indexes from admitted content in the same transaction.
    /// The immutable revision body remains the authority; these rows are query indexes only.
    pub(crate) async fn index(
        tx: &WorldTransaction<'_>,
        definition: &Model,
    ) -> Result<(), DefinitionError> {
        let world = tx.world();
        if &definition.reference.world != world {
            return Err(DefinitionFailure::CrossWorldReference {
                reference: definition.reference.clone(),
            }
            .into());
        }
        let revision = super::read::revision(definition.reference.revision)?;
        for dependency in &definition.dependencies {
            tx.execute(
                "INSERT INTO world_definition_dependency(tenant_id,world_id,definition_id,revision,dependency_id,dependency_revision,usage) VALUES($1,$2,$3,$4,$5,$6,'definition')",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &definition.reference.id.as_str(), &revision, &dependency.id.as_str(), &super::read::revision(dependency.revision)?],
            ).await?;
        }
        if let Some(previous) = &definition.previous_ref {
            super::reducer::lineage(tx, &definition.reference, previous, "previous").await?;
        }
        match &definition.lifecycle {
            DefinitionLifecycle::Deprecated { replacements, .. } => {
                for target in replacements {
                    super::reducer::lineage(tx, &definition.reference, target, "replacement")
                        .await?;
                }
            }
            DefinitionLifecycle::Split { replacements, .. } => {
                for target in replacements {
                    super::reducer::lineage(tx, &definition.reference, target, "split").await?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(crate) fn lifecycle(
        previous: Option<&Model>,
        next: &Model,
    ) -> Result<(), DefinitionFailure> {
        validate_revision(previous, next)
    }

    /// Built-ins have immutable typed revisions, never in-place JSON/state-schema rewrites.
    /// A semantic migration is a checked new revision followed by the ordinary admitted reducer.
    pub(crate) fn migrate(
        previous: &Model,
        next: &Model,
        candidates: &[Model],
        scopes: &[Scope],
    ) -> Result<(), DefinitionFailure> {
        validate_revision(Some(previous), next)?;
        validate_definition(next, candidates, scopes)
    }

    pub(crate) fn admitted_verbs(_kind: DefinitionKind) -> &'static [DefinitionVerb] {
        &[
            DefinitionVerb::Create,
            DefinitionVerb::Refine,
            DefinitionVerb::Deprecate,
            DefinitionVerb::Split,
        ]
    }

    pub(crate) async fn reduce(
        tx: &mut WorldTransaction<'_>,
        admission: &Admission,
        verb: DefinitionVerb,
        definitions: &[Model],
    ) -> Result<Vec<DefinitionRef>, DefinitionError> {
        for definition in definitions {
            let admitted = Self::admitted_verbs(definition.body.kind()).contains(&verb)
                && match verb {
                    DefinitionVerb::Create => {
                        definition.previous_ref.is_none()
                            && matches!(definition.lifecycle, DefinitionLifecycle::Available)
                    }
                    DefinitionVerb::Refine => {
                        definition.previous_ref.is_some()
                            && matches!(definition.lifecycle, DefinitionLifecycle::Available)
                    }
                    DefinitionVerb::Deprecate => {
                        definition.previous_ref.is_some()
                            && matches!(
                                definition.lifecycle,
                                DefinitionLifecycle::Deprecated { .. }
                            )
                    }
                    DefinitionVerb::Split => {
                        definition.previous_ref.is_some()
                            && matches!(definition.lifecycle, DefinitionLifecycle::Split { .. })
                    }
                };
            if !admitted {
                return Err(DefinitionFailure::LifecycleConflict.into());
            }
        }
        apply_definitions(tx, admission, definitions).await
    }

    /// Declarations, including unknown kinds, may be archived but never imply execution authority.
    pub(crate) async fn archive_contract(
        tx: &mut WorldTransaction<'_>,
        admission: &Admission,
        contract: &KindContract,
        revision: Revision,
        provider: &world_protocol::ids::ProviderId,
        package: &world_protocol::ids::Digest,
    ) -> Result<(), DefinitionError> {
        use world_protocol::authorization::{AccessMode, AccessScope};
        super::reducer::require_writer(tx)?;
        if contract.name.trim().is_empty() || revision.0 == 0 {
            return Err(invalid(&["kindContract".into()], Reason::IncompleteContract).into());
        }
        if admission.invocation().world != *tx.world() {
            return Err(invalid(&["world".into()], Reason::IncompleteContract).into());
        }
        // A declaration is managed in the invocation's actually admitted scopes, not a scope in model JSON.
        let scopes: Vec<_> = admission
            .impact()
            .access
            .iter()
            .map(|scope| AccessScope {
                resources: Vec::new(),
                fields: Vec::new(),
                modes: vec![AccessMode::Manage],
                scope: scope.scope.clone(),
                valid_time: scope.valid_time.clone(),
            })
            .collect();
        let impact =
            authorization::actual_impact(scopes, Vec::new(), Vec::new(), Vec::new(), Vec::new())?;
        admission.require_access(&impact)?;
        authorization::recheck(tx, admission, &database_now(tx).await?).await?;
        let world = tx.world();
        tx.execute(
            "INSERT INTO world_kind_registration(tenant_id,world_id,contract_id,revision,contract_version,schema_digest,provider_id,package_digest,status,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'archived',$9)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &contract.schema.id.as_str(), &super::read::revision(revision)?,
              &contract.schema.version, &contract.schema.schema_digest.as_str(), &provider.as_str(), &package.as_str(), &encode(contract)?],
        ).await?;
        Ok(())
    }

    pub(crate) fn require_executable<'a>(
        definition: &Model, checked: &'a [CheckedKind],
    ) -> Result<&'a CheckedKind, DefinitionFailure> {
        checked.iter().find(|kind| kind.definition() == definition).ok_or_else(|| {
            match &definition.body {
                DefinitionBody::Extension(body) => DefinitionFailure::ProviderMissing {
                    contract_id: body.contract.id.clone(),
                },
                _ => invalid(&["kindHandler".into()], Reason::IncompleteContract),
            }
        })
    }
}
