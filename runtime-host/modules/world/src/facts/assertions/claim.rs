use std::collections::BTreeSet;

use world_protocol::{
    definitions::{Definition, DefinitionBody, Property, Scope},
    facts::{Claim, FactFailure},
    failure::FieldPath,
    identity::{IdentityRecord, IdentitySnapshot, SubjectRef},
    ids::{DefinitionRef, ResourceRef, ScopeId, WorldRef},
    releases::{Release, WorldBranch},
    slots::ProjectedCell,
    time::{Timestamp, ValidTime},
    value::{Cell, Value, ValueType},
};

use crate::{
    authorization::Admission,
    definitions, identity,
    store::{WorldSnapshot, WorldTransaction},
};

use super::{Error, impact::resource_read_impact, read::claim_subjects};

type Model = Definition<DefinitionBody>;

pub(super) enum ClaimRead<'a, 's> {
    Transaction(&'a WorldTransaction<'s>, Option<Release>),
    Projection(
        &'a WorldSnapshot<'s>,
        &'a [Model],
        &'a [Scope],
        Option<&'a Timestamp>,
    ),
    Branch(&'a WorldTransaction<'s>, &'a WorldBranch),
    Derived(&'a WorldTransaction<'s>, &'a Release, &'a [IdentitySnapshot]),
}

impl<'a, 's> ClaimRead<'a, 's> {
    pub(super) async fn transaction(tx: &'a WorldTransaction<'s>) -> Result<Self, Error> {
        let model = crate::releases::read_active_model(tx)
            .await
            .map_err(|error| Error::caused_by(FactFailure::InternalFault, error))?;
        Ok(Self::Transaction(tx, model))
    }

    fn world(&self) -> &WorldRef {
        match self {
            Self::Transaction(tx, _) | Self::Branch(tx, _) | Self::Derived(tx, ..) => tx.world(),
            Self::Projection(snapshot, ..) => snapshot.world(),
        }
    }

    fn model(&self) -> Option<(&[Model], &[Scope])> {
        match self {
            Self::Transaction(_, Some(release)) => Some((&release.definitions, &release.scopes)),
            Self::Projection(_, definitions, scopes, _) => Some((definitions, scopes)),
            Self::Branch(_, branch) => Some((&branch.compile.definitions, &branch.compile.scopes)),
            Self::Derived(_, model, _) => Some((&model.definitions, &model.scopes)),
            _ => None,
        }
    }

    pub(super) async fn definition(
        &self,
        reference: &DefinitionRef,
        valid: &ValidTime,
    ) -> Result<Model, Error> {
        if &reference.world != self.world() {
            return Err(FactFailure::CrossWorld.into());
        }
        let result = if let Some((definitions, scopes)) = self.model() {
            let definition = definitions
                .iter()
                .find(|definition| definition.reference == *reference)
                .cloned();
            if let Some(definition) = &definition {
                definitions::validate_applicability(definition, &definition.scope, valid, scopes)?;
            }
            definition
        } else {
            match self {
                Self::Transaction(tx, _) => {
                    definitions::validate_current_reference(tx, reference, valid).await?;
                    definitions::read_definition(tx, reference).await?
                }
                Self::Branch(_, _) | Self::Derived(..) | Self::Projection(..) => unreachable!("exact model"),
            }
        };
        result.ok_or_else(|| {
            FactFailure::MissingDefinition {
                reference: reference.clone(),
            }
            .into()
        })
    }

    pub(super) async fn scopes(&self, ids: &[ScopeId]) -> Result<Vec<Scope>, Error> {
        if let Some((_, scopes)) = self.model() {
            return Ok(scopes
                .iter()
                .filter(|scope| ids.contains(&scope.id))
                .cloned()
                .collect());
        }
        Ok(match self {
            Self::Transaction(tx, _) => definitions::read_scopes(tx, ids).await?,
            Self::Branch(_, _) | Self::Derived(..) | Self::Projection(..) => unreachable!("exact scopes"),
        })
    }

    async fn identity(&self, subject: &SubjectRef) -> Result<IdentitySnapshot, Error> {
        let result = match self {
            Self::Transaction(tx, _) | Self::Branch(tx, _) => {
                identity::get_in_transaction(tx, subject).await?
            }
            Self::Derived(tx, _, identities) => {
                let matches: Vec<_> = identities.iter().filter(|identity| match &identity.record {
                    IdentityRecord::Object(record) => *subject == SubjectRef::Object { id: record.id.clone() },
                    IdentityRecord::Relation(record) => *subject == SubjectRef::Relation { id: record.id.clone() },
                }).collect();
                if matches.windows(2).any(|pair| pair[0] != pair[1]) { return Err(FactFailure::AccessDenied.into()); }
                if let Some(identity) = matches.first() { Some((*identity).clone()) } else { identity::get_in_transaction(tx, subject).await? }
            },
            Self::Projection(snapshot, _, _, None) => identity::get(snapshot, subject).await?,
            Self::Projection(snapshot, _, _, Some(known_at)) => {
                let (kind, id) = match subject {
                    SubjectRef::Object { id } => ("object", id.as_str()),
                    SubjectRef::Relation { id } => ("relation", id.as_str()),
                };
                snapshot.query_opt("SELECT body FROM world_identity_revision WHERE tenant_id=$1 AND world_id=$2 AND subject_kind=$3 AND subject_id=$4 AND recorded_at<=$5::text::timestamptz ORDER BY revision DESC LIMIT 1", &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &kind, &id, &known_at.as_str()]).await?
                    .map(|row| super::read::decode(row.get("body")))
                    .transpose()?
            }
        };
        result.ok_or_else(|| {
            FactFailure::MissingSubject {
                subject: subject.clone(),
            }
            .into()
        })
    }
}

pub(super) async fn validate_claim(
    read: &ClaimRead<'_, '_>,
    claim: &Claim,
    scope: &ScopeId,
    valid: &ValidTime,
) -> Result<Model, Error> {
    let reference = predicate(claim);
    let definition = read.definition(reference, valid).await?;
    let scopes = read
        .scopes(&[scope.clone(), definition.scope.clone()])
        .await?;
    match claim {
        Claim::Attribute(claim) => {
            let identity = read.identity(&claim.subject).await?;
            let subject_type = identity_type(&identity);
            if matches!(claim.value, Value::Null)
                && matches!(&definition.body, DefinitionBody::Property(property) if !property.nullable)
            {
                return Err(FactFailure::NullNotAllowed {
                    property: claim.property.clone(),
                }
                .into());
            }
            definitions::validate_attribute(
                &definition,
                subject_type,
                scope,
                valid,
                &claim.value,
                &scopes,
            )?;
            let DefinitionBody::Property(property) = &definition.body else {
                return Err(FactFailure::TypeMismatch {
                    field: FieldPath(vec!["property".into()]),
                }
                .into());
            };
            validate_value_references(read, &property.value_type, &claim.value).await?;
        }
        Claim::Relation(claim) => {
            let subject = SubjectRef::Relation {
                id: claim.relation_id.clone(),
            };
            let identity = read.identity(&subject).await?;
            if !matches!(&identity.record, IdentityRecord::Relation(relation) if relation.type_id == claim.relation_type.id)
            {
                return Err(FactFailure::InvalidRoleGroup {
                    relation_type: claim.relation_type.clone(),
                }
                .into());
            }
            let ids: BTreeSet<_> = claim.roles.iter().map(|role| &role.object_id).collect();
            let mut types = Vec::with_capacity(ids.len());
            for id in ids {
                let identity = read
                    .identity(&SubjectRef::Object { id: id.clone() })
                    .await?;
                let IdentityRecord::Object(object) = identity.record else {
                    return Err(FactFailure::InvalidRoleGroup {
                        relation_type: claim.relation_type.clone(),
                    }
                    .into());
                };
                types.push((id.clone(), object.type_id));
            }
            definitions::validate_relation(
                &definition,
                scope,
                valid,
                &claim.roles,
                &types,
                &scopes,
            )?;
        }
    }
    Ok(definition)
}

async fn validate_value_references(
    read: &ClaimRead<'_, '_>,
    value_type: &ValueType,
    value: &Value,
) -> Result<(), Error> {
    let mut pending = vec![(value_type, value)];
    while let Some((value_type, value)) = pending.pop() {
        let identity = match (value_type, value) {
            (ValueType::Object { type_id }, Value::Object { id }) => {
                Some((SubjectRef::Object { id: id.clone() }, type_id))
            }
            (ValueType::Relation { type_id }, Value::Relation { id }) => {
                Some((SubjectRef::Relation { id: id.clone() }, type_id))
            }
            (ValueType::List { element, .. }, Value::List { items }) => {
                pending.extend(items.iter().map(|value| (element.as_ref(), value)));
                None
            }
            (ValueType::Record { fields: types }, Value::Record { fields }) => {
                for field in types {
                    if let Some(value) = fields.get(&field.name) {
                        pending.push((&field.value_type, value));
                    }
                }
                None
            }
            _ => None,
        };
        if let Some((subject, expected)) = identity {
            if identity_type(&read.identity(&subject).await?) != expected {
                return Err(FactFailure::TypeMismatch {
                    field: FieldPath(vec!["value".into()]),
                }
                .into());
            }
        }
    }
    Ok(())
}

fn identity_type(identity: &IdentitySnapshot) -> &world_protocol::ids::DefinitionId {
    match &identity.record {
        IdentityRecord::Object(object) => &object.type_id,
        IdentityRecord::Relation(relation) => &relation.type_id,
    }
}

fn predicate(claim: &Claim) -> &DefinitionRef {
    match claim {
        Claim::Attribute(claim) => &claim.property,
        Claim::Relation(claim) => &claim.relation_type,
    }
}

/// Schema and current access checks use the exact query model and requested time.
/// Candidate completeness and source conflicts are checked by the whole-request validator.
pub(super) async fn validate_projected_cell_snapshot(
    read: &ClaimRead<'_, '_>,
    admission: &Admission,
    projected: &ProjectedCell,
    scope: &ScopeId,
    valid: &ValidTime,
    now: &Timestamp,
) -> Result<Property, Error> {
    let ClaimRead::Projection(snapshot, _, _, _) = read else {
        return Err(FactFailure::InternalFault.into());
    };
    let property_ref = &projected.field.property;
    if property_ref.world != *snapshot.world() {
        return Err(FactFailure::CrossWorld.into());
    }
    let subject_resource = match &projected.subject {
        SubjectRef::Object { id } => ResourceRef::Object { id: id.clone() },
        SubjectRef::Relation { id } => ResourceRef::Relation { id: id.clone() },
    };
    let definition_resource = ResourceRef::Definition {
        id: property_ref.id.clone(),
    };
    for resource in [&subject_resource, &definition_resource] {
        admission.require_access(&resource_read_impact(
            resource.clone(),
            vec![property_ref.clone()],
            scope,
            Some(valid),
            Vec::new(),
            None,
        )?)?;
    }
    let definition = read.definition(property_ref, valid).await?;
    let DefinitionBody::Property(property) = &definition.body else {
        return Err(FactFailure::TypeMismatch {
            field: FieldPath(vec!["property".into()]),
        }
        .into());
    };
    let mut labels = property.access_labels.clone();
    let row = snapshot.query_opt("SELECT r.body FROM world_definition_head h JOIN world_definition_revision r USING(tenant_id,world_id,definition_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.definition_id=$3", &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &property_ref.id.as_str()]).await?;
    let current: Model = row
        .map(|row| super::read::decode(row.get("body")))
        .transpose()?
        .ok_or(FactFailure::AccessDenied)?;
    if let DefinitionBody::Property(property) = &current.body {
        labels.extend(property.access_labels.clone());
    }
    for resource in [&subject_resource, &definition_resource] {
        admission.require_access(&resource_read_impact(
            resource.clone(),
            vec![property_ref.clone()],
            scope,
            Some(valid),
            labels.clone(),
            None,
        )?)?;
    }
    if !property
        .domain
        .contains(identity_type(&read.identity(&projected.subject).await?))
    {
        return Err(FactFailure::TypeMismatch {
            field: FieldPath(vec!["subject".into()]),
        }
        .into());
    }
    let scopes = read
        .scopes(&[scope.clone(), definition.scope.clone()])
        .await?;
    definitions::validate_applicability(&definition, scope, valid, &scopes)?;
    match &projected.field.cell {
        Cell::Known { value } => {
            let values = projected_values(property, value)?;
            for value in values {
                definitions::validate_value(&property.value_type, property.nullable, value)?;
                let claim = Claim::Attribute(world_protocol::facts::AttributeClaim {
                    subject: projected.subject.clone(),
                    property: property_ref.clone(),
                    value: value.clone(),
                });
                for subject in claim_subjects(&claim) {
                    let resource = match subject {
                        SubjectRef::Object { id } => ResourceRef::Object { id },
                        SubjectRef::Relation { id } => ResourceRef::Relation { id },
                    };
                    admission.require_access(&resource_read_impact(
                        resource,
                        vec![property_ref.clone()],
                        scope,
                        Some(valid),
                        labels.clone(),
                        None,
                    )?)?;
                }
                validate_value_references(read, &property.value_type, value).await?;
            }
        }
        Cell::Conflicted { assertions } => {
            if assertions.iter().collect::<BTreeSet<_>>().len() != assertions.len() {
                return Err(FactFailure::Structural {
                    field: FieldPath(vec!["cell".into(), "assertions".into()]),
                }
                .into());
            }
            // An empty ref set is valid only with independently captured opposing source witnesses.
            for reference in assertions {
                if reference.world != *snapshot.world() {
                    return Err(FactFailure::CrossWorld.into());
                }
                admission.require_access(&resource_read_impact(
                    ResourceRef::Assertion {
                        id: reference.id.clone(),
                    },
                    vec![property_ref.clone()],
                    scope,
                    Some(valid),
                    labels.clone(),
                    None,
                )?)?;
            }
        }
        Cell::SourceUnavailable { source_id, .. } => {
            admission.require_access(&resource_read_impact(
                ResourceRef::Source {
                    id: source_id.clone(),
                },
                vec![property_ref.clone()],
                scope,
                Some(valid),
                labels,
                Some(source_id.clone()),
            )?)?;
        }
        Cell::Unknown { .. } => {}
    }
    let evidence: Vec<_> = projected
        .field
        .evidence
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    super::require_evidence_snapshot(snapshot, admission, &evidence, scope, Some(valid), now)
        .await?;
    Ok(property.clone())
}

pub(super) fn projected_values<'a>(
    property: &Property,
    value: &'a Value,
) -> Result<Vec<&'a Value>, Error> {
    if property.cardinality.maximum == Some(1) {
        return Ok(vec![value]);
    }
    let Value::List { items } = value else {
        return Err(FactFailure::TypeMismatch {
            field: FieldPath(vec!["cell".into(), "value".into()]),
        }
        .into());
    };
    if items
        .iter()
        .enumerate()
        .any(|(index, value)| items[..index].contains(value))
    {
        return Err(FactFailure::Structural {
            field: FieldPath(vec!["cell".into(), "cardinality".into()]),
        }
        .into());
    }
    Ok(items.iter().collect())
}
