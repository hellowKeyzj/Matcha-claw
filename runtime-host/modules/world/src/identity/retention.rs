use std::collections::BTreeSet;
use world_protocol::{
    facts::Claim, identity::{IdentityChangeProposal, IdentityFailure, IdentitySnapshot, SourceAlias, SubjectRef},
    ids::{Digest, Generation, ResourceRef}, provenance::ReadDependency, value::Value,
};
use crate::store::{RetentionRoots, WorldTransaction};
use super::{IdentityError, aliases, decode, parts, resource, subject, type_id};

pub(crate) async fn retention_roots(tx: &WorldTransaction<'_>, subjects: &[SubjectRef], ranges: &[Digest]) -> Result<RetentionRoots, IdentityError> {
    let mut roots = RetentionRoots::default();
    let mut operations = BTreeSet::new();
    for reference in subjects {
        if let Some(identity) = super::get_in_transaction(tx, reference).await? { retain_identity(&mut roots, identity); }
        let (kind, id) = parts(reference);
        for row in tx.query("SELECT DISTINCT r.operation_id,r.body FROM world_identity_resolution_member m JOIN world_identity_resolution r USING(tenant_id,world_id,operation_id,revision) WHERE m.tenant_id=$1 AND m.world_id=$2 AND ((m.source_kind=$3 AND m.source_id=$4) OR (m.target_kind=$3 AND m.target_id=$4)) ORDER BY r.operation_id", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &kind, &id]).await? {
            let operation: String = row.get("operation_id");
            if operations.insert(operation.clone()) {
                retain_change(tx, &mut roots, decode(row.get("body"))?)?;
                for member in tx.query("SELECT impact_kind,body FROM world_identity_resolution_member WHERE tenant_id=$1 AND world_id=$2 AND operation_id=$3 ORDER BY revision,source_kind,source_id,target_kind,target_id,impact_kind,impact_id", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &operation]).await? {
                    let body = member.get("body");
                    match member.get::<_, String>("impact_kind").as_str() {
                        "identity" => { let mapping: world_protocol::identity::IdentityRemap = decode(body)?; roots.resources.push(resource(&mapping.original)); roots.resources.extend(mapping.replacements.iter().map(resource)); },
                        "alias" => { for alias in decode::<Vec<SourceAlias>>(body)? { retain_alias(&mut roots, alias)?; } },
                        "assertion" => retain_assertion(&mut roots, decode(body)?),
                        "assertion_replacement" => { let (original, replacements): (world_protocol::ids::AssertionRef, Vec<world_protocol::ids::AssertionRef>) = decode(body)?; roots.dependencies.extend(std::iter::once(original).chain(replacements).map(|reference| ReadDependency::Assertion { reference })); },
                        _ => return Err(IdentityFailure::CandidateScopeIncomplete.into()),
                    }
                }
            }
        }
    }
    for digest in ranges {
        let row = tx.query_opt("SELECT source_id,namespace,native_key,generation FROM world_alias_range WHERE tenant_id=$1 AND world_id=$2 AND range_digest=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &digest.as_str()]).await?;
        let Some(row) = row else { return Err(IdentityFailure::CandidateScopeIncomplete.into()); };
        let source: String = row.get("source_id"); let namespace: String = row.get("namespace"); let key: String = row.get("native_key");
        roots.dependencies.push(ReadDependency::AliasRange { digest: digest.clone(), generation: Generation(row.get::<_, i64>("generation") as u64) });
        for row in tx.query("SELECT body FROM world_source_alias_revision WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND namespace=$4 AND native_key=$5 ORDER BY incarnation,valid_from_ns,revision", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &source, &namespace, &key]).await? {
            let alias: SourceAlias = decode(row.get("body"))?;
            if &alias.key.world != tx.world() || aliases::range_digest(&alias.key)? != *digest { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
            retain_alias(&mut roots, alias)?;
        }
    }
    for dependency in &mut roots.dependencies {
        if let ReadDependency::AliasRange { digest, generation } = dependency {
            let row = tx.query_opt("SELECT generation FROM world_alias_range WHERE tenant_id=$1 AND world_id=$2 AND range_digest=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &digest.as_str()]).await?.ok_or(IdentityFailure::CandidateScopeIncomplete)?;
            *generation = Generation(row.get::<_, i64>("generation") as u64);
        }
    }
    roots.scopes.sort(); roots.scopes.dedup(); roots.resources.sort(); roots.resources.dedup();
    roots.definitions.sort(); roots.definitions.dedup(); roots.evidence.sort(); roots.evidence.dedup();
    Ok(roots)
}
pub(super) fn retain_identity(roots: &mut RetentionRoots, identity: IdentitySnapshot) {
    roots.resources.push(resource(&subject(&identity.record)));
    roots.resources.push(ResourceRef::Definition { id: type_id(&identity.record).clone() });
    roots.dependencies.push(ReadDependency::Identity { subject: subject(&identity.record), revision: identity.revision });
}
fn retain_alias(roots: &mut RetentionRoots, alias: SourceAlias) -> Result<(), IdentityError> {
    roots.resources.push(resource(&alias.target));
    roots.resources.push(ResourceRef::Source { id: alias.key.source_id.clone() });
    roots.evidence.extend(alias.evidence);
    // The generation is not a new proof; retention only addresses this exact natural-key range.
    roots.dependencies.push(ReadDependency::AliasRange { digest: aliases::range_digest(&alias.key)?, generation: Generation(0) });
    Ok(())
}
fn retain_change(tx: &WorldTransaction<'_>, roots: &mut RetentionRoots, change: IdentityChangeProposal) -> Result<(), IdentityError> {
    if &change.world != tx.world() { return Err(IdentityFailure::CrossWorld.into()); }
    roots.scopes.push(change.scope); roots.evidence.extend(change.evidence);
    for identity in change.identities { retain_identity(roots, identity); }
    for alias in change.aliases { retain_alias(roots, alias)?; }
    for mapping in change.remapping {
        roots.resources.push(resource(&mapping.original));
        roots.resources.extend(mapping.replacements.iter().map(resource));
    }
    roots.dependencies.extend(change.affected_assertions.into_iter().map(|reference| ReadDependency::Assertion { reference }));
    for claim in change.relation_claims { retain_claim(roots, Claim::Relation(claim)); }
    for mapping in change.assertion_remapping {
        roots.dependencies.push(ReadDependency::Assertion { reference: mapping.original });
        for replacement in mapping.replacements {
            roots.scopes.push(replacement.draft.scope); roots.evidence.extend(replacement.draft.evidence);
            retain_claim(roots, replacement.draft.claim);
            if let Some(reference) = replacement.draft.supersedes { roots.dependencies.push(ReadDependency::Assertion { reference }); }
            if let Some(supports) = replacement.supports {
                roots.dependencies.extend(supports.observed_dependencies);
                roots.resources.extend(supports.affected_watches.into_iter().map(|id| ResourceRef::Watch { id }));
                roots.resources.extend(supports.invalidate.into_iter().map(|reference| ResourceRef::Support { id: reference.id }));
                for support in supports.upserts {
                    roots.resources.push(ResourceRef::Support { id: support.reference.id });
                    roots.dependencies.push(ReadDependency::Assertion { reference: support.conclusion });
                    roots.scopes.push(support.scope); roots.definitions.push(support.rule); roots.releases.push(support.release_id);
                    if let Some(id) = support.branch_id { roots.resources.push(ResourceRef::Branch { id }); }
                    for argument in support.arguments { retain_value(roots, argument.value); }
                    if let world_protocol::value::DirtyState::Dirty { watches, .. } = support.dirty { roots.resources.extend(watches.into_iter().map(|id| ResourceRef::Watch { id })); }
                    for premise in support.premises {
                        match premise {
                            world_protocol::provenance::PremiseRef::Assertion(reference) => roots.dependencies.push(ReadDependency::Assertion { reference }),
                            world_protocol::provenance::PremiseRef::Evidence(reference) => roots.evidence.push(reference),
                            world_protocol::provenance::PremiseRef::Read(dependency) => roots.dependencies.push(dependency),
                        }
                    }
                }
            }
        }
    }
    Ok(())
}
fn retain_assertion(roots: &mut RetentionRoots, assertion: world_protocol::facts::Assertion) {
    roots.dependencies.push(ReadDependency::Assertion { reference: assertion.reference });
    roots.scopes.push(assertion.scope); roots.evidence.extend(assertion.evidence);
    if let Some(reference) = assertion.supersedes { roots.dependencies.push(ReadDependency::Assertion { reference }); }
    match assertion.origin {
        world_protocol::facts::AssertionOrigin::Source { binding, .. } => roots.definitions.push(binding),
        // Exact assertion roots enter facts::assertions::retention_roots, which retains every OR support and its history.
        world_protocol::facts::AssertionOrigin::Derived {} => {}, _ => {},
    }
    retain_claim(roots, assertion.claim);
}
fn retain_claim(roots: &mut RetentionRoots, claim: Claim) {
    match claim {
        Claim::Attribute(claim) => { roots.resources.push(resource(&claim.subject)); roots.definitions.push(claim.property); retain_value(roots, claim.value); }
        Claim::Relation(claim) => {
            roots.resources.push(ResourceRef::Relation { id: claim.relation_id }); roots.definitions.push(claim.relation_type);
            roots.resources.extend(claim.roles.into_iter().map(|role| ResourceRef::Object { id: role.object_id }));
        }
    }
}
fn retain_value(roots: &mut RetentionRoots, value: Value) {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Object { id } => roots.resources.push(ResourceRef::Object { id }),
            Value::Relation { id } => roots.resources.push(ResourceRef::Relation { id }),
            Value::List { items } => pending.extend(items), Value::Record { fields } => pending.extend(fields.into_values()), _ => {},
        }
    }
}
