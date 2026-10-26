use std::{
    collections::{BTreeMap, BTreeSet},
    time::Instant,
};

use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::BudgetDimension,
    facts::{AssertionOrigin, AttributeClaim, Claim, ObservationDraft, Polarity},
    ids::SourceFieldId,
    sources::{
        FieldMappingFailure, GapReason, MapRecordsRequest, MapRecordsResult, MappedCellProposal,
        MappingFailure, SourceGap,
    },
    value::{Cell, UnknownReason},
};

use super::{observations, receipts, schema_drift};

pub(crate) struct MappedRecords<'a> {
    records: &'a crate::sources::sync::TrustedRecords,
    request: &'a MapRecordsRequest,
    result: MapRecordsResult,
    observation_dependencies: Vec<Vec<world_protocol::provenance::ReadDependency>>,
}

pub(crate) struct MappedObservation<'a> {
    records: &'a crate::sources::sync::TrustedRecords,
    request: &'a MapRecordsRequest,
    draft: &'a ObservationDraft,
    dependencies: &'a [world_protocol::provenance::ReadDependency],
    evidence: &'a [world_protocol::facts::Evidence],
}

impl MappedRecords<'_> {
    pub(crate) fn result(&self) -> &MapRecordsResult {
        &self.result
    }
    pub(crate) fn observation(&self, index: usize) -> Option<MappedObservation<'_>> {
        Some(MappedObservation {
            records: self.records,
            request: self.request,
            draft: self.result.observations.get(index)?,
            dependencies: self.observation_dependencies.get(index)?,
            evidence: &self.result.evidence,
        })
    }
}

impl MappedObservation<'_> {
    pub(crate) fn expected_assertion_id(
        &self,
    ) -> Result<world_protocol::ids::AssertionId, MappingFailure> {
        crate::sources::sync::source_claim_id(self.records.assignment(), self)
            .map_err(|_| MappingFailure::RevisionMismatch)
    }
    pub(crate) fn expected_source_head(
        &self,
        id: &world_protocol::ids::AssertionId,
    ) -> Option<&world_protocol::ids::AssertionRef> {
        self.records
            .existing()
            .iter()
            .find(|assertion| &assertion.reference.id == id)
            .map(|assertion| &assertion.reference)
    }
    pub(crate) fn request(&self) -> &MapRecordsRequest {
        self.request
    }
    pub(crate) fn draft(&self) -> &ObservationDraft {
        self.draft
    }
    pub(crate) fn dependencies(&self) -> &[world_protocol::provenance::ReadDependency] {
        self.dependencies
    }
    pub(crate) fn receipts(&self) -> &[world_protocol::identity::IdentityReceipt] {
        &self.request.identities
    }
    pub(crate) fn evidence(&self) -> &[world_protocol::facts::Evidence] {
        self.evidence
    }
    pub(crate) fn binding(&self) -> &world_protocol::ids::DefinitionRef {
        &self.request.plan.binding
    }
}

/// Only trusted source capture or persisted immutable records may call this, never a guest DTO dispatcher.
pub(crate) fn map_records<'a>(
    records: &'a crate::sources::sync::TrustedRecords,
    cancellation: &CancellationToken,
) -> Result<MappedRecords<'a>, MappingFailure> {
    let request = records.request();
    let (result, observation_dependencies) = map_request(request, cancellation, None)?;
    Ok(MappedRecords {
        records,
        request,
        result,
        observation_dependencies,
    })
}

pub(in crate::sources) fn map_branch_observations(
    request: &MapRecordsRequest,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &CancellationToken,
) -> Result<
    (
        MapRecordsResult,
        Vec<Vec<world_protocol::provenance::ReadDependency>>,
    ),
    MappingFailure,
> {
    budget
        .charge(BudgetDimension::Rows, request.batch.rows.len() as u64)
        .map_err(|error| MappingFailure::BudgetExceeded {
            dimension: error.dimension,
        })?;
    map_request(request, cancellation, Some(budget))
}

fn map_request(
    request: &MapRecordsRequest,
    cancellation: &CancellationToken,
    accounting: Option<&crate::extensions::invocation::CallBudget>,
) -> Result<
    (
        MapRecordsResult,
        Vec<Vec<world_protocol::provenance::ReadDependency>>,
    ),
    MappingFailure,
> {
    let mut budget = Meter {
        request,
        cancellation,
        accounting,
        started: Instant::now(),
        steps: 0,
        bytes: 0,
    };
    budget.check()?;
    budget.bytes(request)?;
    receipts::validate_basis(request)?;
    if !request.batch.deleted_keys.is_empty() {
        return Err(MappingFailure::RevisionMismatch);
    }
    if request.batch.rows.len() as u64 > request.budget.max_rows {
        return Err(MappingFailure::BudgetExceeded {
            dimension: BudgetDimension::Rows,
        });
    }
    let mut result = MapRecordsResult {
        deletions: Vec::new(),
        cells: Vec::new(),
        observations: Vec::new(),
        evidence: Vec::new(),
        failures: Vec::new(),
        gaps: request.basis.gap.iter().cloned().collect(),
        dependencies: Vec::new(),
    };
    let mut observation_dependencies = Vec::new();
    receipts::plan_dependencies(request, &mut result.dependencies);
    let mut blocked: BTreeSet<SourceFieldId> = request
        .plan
        .blocked_fields
        .iter()
        .filter_map(|failure| failure.field.clone())
        .collect();
    let mut dependencies = request.plan.mapping.key_fields.clone();
    dependencies.extend(
        request
            .plan
            .mapping
            .fields
            .iter()
            .map(|field| field.source_field.clone()),
    );
    dependencies.extend(
        request
            .plan
            .mapping
            .relations
            .iter()
            .flat_map(|relation| relation.roles.iter().map(|role| role.source_field.clone())),
    );
    dependencies.sort();
    dependencies.dedup();
    if let Some(failure) = schema_drift(&request.plan.schema, &request.observed_schema, &[])
        .into_iter()
        .next()
    {
        return Err(failure);
    }
    let mut denied: BTreeSet<_> = request
        .plan
        .blocked_fields
        .iter()
        .filter_map(|entry| {
            matches!(entry.failure, MappingFailure::PermissionDenied { .. })
                .then(|| entry.field.clone())
                .flatten()
        })
        .collect();
    for field in &dependencies {
        for failure in schema_drift(
            &request.plan.schema,
            &request.observed_schema,
            std::slice::from_ref(field),
        ) {
            if request.plan.mapping.key_fields.contains(field) {
                return Err(failure);
            }
            if matches!(failure, MappingFailure::PermissionDenied { .. }) {
                denied.insert(field.clone());
            }
            blocked.insert(field.clone());
            result.failures.push(FieldMappingFailure {
                row: 0,
                field: Some(field.clone()),
                failure,
            });
        }
    }
    for mapped in &request.plan.mapping.fields {
        if !request.basis.field_definitions.contains(&mapped.property) {
            blocked.insert(mapped.source_field.clone());
            result.failures.push(FieldMappingFailure {
                row: 0,
                field: Some(mapped.source_field.clone()),
                failure: MappingFailure::RevisionMismatch,
            });
        }
    }
    let mut keys = BTreeSet::new();
    let mut duplicate_keys = BTreeSet::new();
    for row in &request.batch.rows {
        if !keys.insert((&row.native_key, &row.incarnation)) {
            duplicate_keys.insert((&row.native_key, &row.incarnation));
        }
    }
    for (index, row) in request.batch.rows.iter().enumerate() {
        budget.step()?;
        let row_number = index as u64;
        let mut fail = |field, failure| {
            result.failures.push(FieldMappingFailure {
                row: row_number,
                field,
                failure,
            })
        };
        if duplicate_keys.contains(&(&row.native_key, &row.incarnation)) {
            fail(None, MappingFailure::DuplicateKey);
            continue;
        }
        if let Err(failure) = receipts::validate_key(request, row) {
            fail(None, failure);
            continue;
        }
        let mut row_dependencies = Vec::new();
        receipts::plan_dependencies(request, &mut row_dependencies);
        for field in &request.plan.mapping.key_fields {
            receipts::field_dependency(request, field, &mut row_dependencies)?;
        }
        let identity = match receipts::row_identity(request, row, &mut row_dependencies) {
            Ok(identity) => identity,
            Err(failure) => {
                fail(None, failure);
                continue;
            }
        };
        for dependency in &row_dependencies {
            receipts::push(&mut result.dependencies, dependency.clone());
        }
        let mut fields = BTreeMap::new();
        let mut duplicate_fields = BTreeSet::new();
        for field in &row.fields {
            if fields.insert(&field.id, field).is_some() {
                duplicate_fields.insert(&field.id);
            }
        }
        for mapped in &request.plan.mapping.fields {
            budget.step()?;
            if blocked.contains(&mapped.source_field) {
                result.failures.extend(
                    request
                        .plan
                        .blocked_fields
                        .iter()
                        .filter(|failure| failure.field.as_ref() == Some(&mapped.source_field))
                        .cloned()
                        .map(|mut failure| {
                            failure.row = row_number;
                            failure
                        }),
                );
                continue;
            }
            if duplicate_fields.contains(&mapped.source_field) {
                result.failures.push(FieldMappingFailure {
                    row: row_number,
                    field: Some(mapped.source_field.clone()),
                    failure: MappingFailure::DuplicateKey,
                });
                continue;
            }
            let definition = request
                .plan
                .field_definitions
                .iter()
                .find(|definition| definition.reference == mapped.property)
                .ok_or(MappingFailure::RevisionMismatch)?;
            receipts::push(
                &mut result.dependencies,
                world_protocol::provenance::ReadDependency::Definition {
                    reference: mapped.property.clone(),
                },
            );
            let source = fields.get(&mapped.source_field).copied();
            match observations::map_field(request, mapped, definition, source) {
                Ok(Some(Cell::Known { value })) => {
                    receipts::field_dependency(
                        request,
                        &mapped.source_field,
                        &mut result.dependencies,
                    )?;
                    let evidence = observations::field_evidence(request, row, mapped, source)?;
                    if receipts::field_mode(request, &mapped.source_field)
                        != world_protocol::sources::BindingMode::Virtual
                    {
                        let mut dependencies = row_dependencies.clone();
                        receipts::field_dependency(
                            request,
                            &mapped.source_field,
                            &mut dependencies,
                        )?;
                        receipts::push(
                            &mut dependencies,
                            world_protocol::provenance::ReadDependency::Definition {
                                reference: mapped.property.clone(),
                            },
                        );
                        observation_dependencies.push(dependencies);
                        result.observations.push(ObservationDraft {
                            claim: Claim::Attribute(AttributeClaim {
                                subject: identity.clone(),
                                property: mapped.property.clone(),
                                value: value.clone(),
                            }),
                            polarity: Polarity::Positive,
                            scope: request.plan.authority.scope.clone(),
                            valid_time: request.batch.valid_time.clone(),
                            observed_at: request.basis.observed_at.clone(),
                            origin: AssertionOrigin::Source {
                                binding: request.plan.binding.clone(),
                                authority: request.plan.authority.authority.clone(),
                                position: request.basis.position.clone(),
                            },
                            evidence: vec![evidence.reference.clone()],
                            supersedes: None,
                        });
                    }
                    result.cells.push(MappedCellProposal {
                        subject: identity.clone(),
                        property: mapped.property.clone(),
                        cell: Cell::Known { value },
                        locator: source.and_then(|field| field.locator.clone()),
                    });
                    result.evidence.push(evidence);
                }
                Ok(Some(cell)) => {
                    receipts::field_dependency(
                        request,
                        &mapped.source_field,
                        &mut result.dependencies,
                    )?;
                    if source.is_some() {
                        result
                            .evidence
                            .push(observations::field_evidence(request, row, mapped, source)?);
                    }
                    result.cells.push(MappedCellProposal {
                        subject: identity.clone(),
                        property: mapped.property.clone(),
                        cell,
                        locator: source.and_then(|field| field.locator.clone()),
                    });
                }
                Ok(None) => {}
                Err(failure) => result.failures.push(FieldMappingFailure {
                    row: row_number,
                    field: Some(mapped.source_field.clone()),
                    failure,
                }),
            }
        }
        observations::map_relations(
            request,
            row,
            &identity,
            &fields,
            &blocked,
            &duplicate_fields,
            row_number,
            &mut result,
            &row_dependencies,
            &mut observation_dependencies,
            &mut || budget.step(),
        )?;
        // Blocked mappings remain explicitly unmapped, never invented assertions.
        for mapped in &request.plan.mapping.fields {
            if blocked.contains(&mapped.source_field) && !denied.contains(&mapped.source_field) {
                result.cells.push(MappedCellProposal {
                    subject: identity.clone(),
                    property: mapped.property.clone(),
                    cell: Cell::Unknown {
                        reason: UnknownReason::Unmapped,
                    },
                    locator: fields
                        .get(&mapped.source_field)
                        .and_then(|field| field.locator.clone()),
                });
            }
        }
    }
    if !request.batch.complete {
        result.gaps.push(SourceGap {
            reason: GapReason::IncompleteEnumeration,
            after: request.basis.position.clone(),
            before: None,
        });
    }
    budget.check()?;
    budget.bytes(&result)?;
    Ok((result, observation_dependencies))
}

struct Meter<'a> {
    request: &'a MapRecordsRequest,
    cancellation: &'a CancellationToken,
    accounting: Option<&'a crate::extensions::invocation::CallBudget>,
    started: Instant,
    steps: u64,
    bytes: u64,
}

impl Meter<'_> {
    fn check(&self) -> Result<(), MappingFailure> {
        if self.cancellation.is_cancelled() {
            return Err(MappingFailure::Cancelled);
        }
        if let Some(accounting) = self.accounting {
            accounting
                .check()
                .map_err(|error| MappingFailure::BudgetExceeded {
                    dimension: error.dimension,
                })?;
        }
        if self.started.elapsed().as_millis() >= self.request.budget.max_wall_time.0 as u128 {
            return Err(MappingFailure::BudgetExceeded {
                dimension: BudgetDimension::WallTime,
            });
        }
        if self
            .request
            .budget
            .deadline
            .as_ref()
            .is_some_and(|deadline| chrono::Utc::now().timestamp_millis() >= deadline.unix_millis())
        {
            return Err(MappingFailure::BudgetExceeded {
                dimension: BudgetDimension::Deadline,
            });
        }
        Ok(())
    }

    fn step(&mut self) -> Result<(), MappingFailure> {
        self.check()?;
        if let Some(accounting) = self.accounting {
            accounting
                .charge(BudgetDimension::Steps, 1)
                .map_err(|error| MappingFailure::BudgetExceeded {
                    dimension: error.dimension,
                })?;
        }
        self.steps = self
            .steps
            .checked_add(1)
            .ok_or(MappingFailure::BudgetExceeded {
                dimension: BudgetDimension::Steps,
            })?;
        if self.steps > self.request.budget.max_steps {
            return Err(MappingFailure::BudgetExceeded {
                dimension: BudgetDimension::Steps,
            });
        }
        Ok(())
    }

    fn bytes(&mut self, value: &impl serde::Serialize) -> Result<(), MappingFailure> {
        struct Counter(u64);
        impl std::io::Write for Counter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0 = self.0.saturating_add(bytes.len() as u64);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut count = Counter(0);
        serde_json::to_writer(&mut count, value).map_err(|_| MappingFailure::InternalFault)?;
        if let Some(accounting) = self.accounting {
            accounting
                .charge(BudgetDimension::Bytes, count.0)
                .map_err(|error| MappingFailure::BudgetExceeded {
                    dimension: error.dimension,
                })?;
        }
        self.bytes = self.bytes.saturating_add(count.0);
        if self.bytes > self.request.budget.max_bytes {
            return Err(MappingFailure::BudgetExceeded {
                dimension: BudgetDimension::Bytes,
            });
        }
        Ok(())
    }
}
