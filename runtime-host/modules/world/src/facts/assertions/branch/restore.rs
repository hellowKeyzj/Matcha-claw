use std::collections::{BTreeMap, BTreeSet};
use serde_json::Value;
use world_protocol::{facts::{AssertionOrigin, AssertionStatus, FactFailure}, ids::*, provenance::{ReadDependency, SupportStatus}, releases::{Release, WorldBranch}, sources::BranchSourceCapture, time::ValidTime, value::DirtyState};
use crate::{definitions, store::RetentionRoots};
use super::{BranchDerivationRecord, Error, invalid};

pub(super) fn validate_record(record: &BranchDerivationRecord) -> Result<(), Error> {
    let assertion = &record.assertion;
    if record.branch.world != assertion.reference.world || record.branch.revision.0 == 0 || record.revision.0 == 0
        || assertion.reference.revision != Revision(1) || assertion.status != AssertionStatus::Accepted
        || !matches!(assertion.origin, AssertionOrigin::Derived {}) || !assertion.evidence.is_empty()
        || assertion.supersedes.is_some() || assertion.superseded_at.is_some()        || record.supports.is_empty() || record.supports.len() > 4096 || record.witnesses.len() != record.supports.len() {
        return Err(invalid());
    }
    super::super::revision::validate_interval(&assertion.valid_time)?;
    let digest = definitions::canonical_digest(&("world.branch.derived-assertion.v1", &record.branch, &record.release_id, &assertion.scope,
        &assertion.valid_time, &super::super::derived::normalized_claim(&assertion.claim), assertion.polarity))?;
    if assertion.reference.id.as_str() != format!("derived-{}", &digest.as_str()[7..]) { return Err(invalid()); }
    let mut ids = BTreeSet::new(); let mut produced = false;
    for support in &record.supports {
        let basis = &record.witnesses.iter().find(|witness| witness.support == support.reference).ok_or_else(invalid)?.derivation;
        let witness = record.witnesses.iter().find(|witness| witness.support == support.reference).ok_or_else(invalid)?;
        if !ids.insert(support.reference.id.clone()) || support.reference.world != record.branch.world || support.reference.revision.0 == 0
            || support.conclusion != assertion.reference || support.scope != assertion.scope || support.release_id != record.release_id
            || support.branch_id.as_ref() != Some(&record.branch.id) || support.rule.world != record.branch.world
            || support.rule.revision.0 == 0 || support.premises.is_empty() || support.premises.len() > 4096
            || support.status != SupportStatus::Valid || support.dirty != DirtyState::Clean
            || !definitions::valid_time_contains(&assertion.valid_time, &support.valid_time)
            || basis.world != record.branch.world || basis.release_id != record.release_id || basis.rule != support.rule
            || basis.arguments != support.arguments || basis.scope != assertion.scope || basis.valid_time != assertion.valid_time
            || basis.status != SupportStatus::Valid || basis.active_head.is_some() || basis.model_digest != record.model_digest
            || basis.conclusion.as_ref().is_none_or(|(claim, polarity)| super::super::derived::normalized_claim(claim) != super::super::derived::normalized_claim(&assertion.claim) || polarity != &assertion.polarity)
            || definitions::canonical_digest(basis)? != witness.derivation_digest
            || basis.dependencies.len() > 4096 || basis.capture_witness.len() > 4096 || basis.branch_inputs.len() > 4096
            || witness.source_versions.iter().any(|reference| reference.world != record.branch.world)
            || witness.branch_identities.iter().any(|dependency| !matches!(dependency, ReadDependency::Identity { .. }) || !crate::facts::support::dependencies(support).contains(dependency)) {
            return Err(invalid());
        }
        produced |= witness.derivation_digest == record.derivation_digest;
        super::super::revision::validate_interval(&support.valid_time)?;
        let expected = definitions::canonical_digest(&("world.branch.derived-support.v1", &record.branch, &support.conclusion, &support.rule, &support.arguments, &support.scope, &support.valid_time))?;
        if support.reference.id.as_str() != format!("derived-{}", &expected.as_str()[7..]) { return Err(invalid()); }
        let dependencies = crate::facts::support::dependencies(support);
        if dependencies.iter().any(|dependency| !basis.dependencies.contains(dependency))
            || witness.branch_assertions.iter().any(|reference| reference.world != record.branch.world || !dependencies.contains(&ReadDependency::Assertion { reference: reference.clone() }))
            || witness.captured_evidence.iter().any(|reference| reference.world != record.branch.world || !dependencies.contains(&ReadDependency::Evidence { reference: reference.clone() })) {
            return Err(invalid());
        }
        let captures: BTreeSet<_> = basis.capture_witness.iter().map(|(binding, _)| binding).collect();
        if captures.len() != basis.capture_witness.len() || captures.iter().any(|binding| binding.world != record.branch.world || binding.revision.0 == 0) { return Err(invalid()); }
    }
    if !produced { return Err(invalid()); }
    Ok(())
}

pub(crate) fn branch_derivation_retention_roots(record: &BranchDerivationRecord, roots: &mut RetentionRoots) {
    roots.branches.push(record.branch.clone()); roots.releases.push(record.release_id.clone()); roots.scopes.push(record.assertion.scope.clone());
    let predicate = match &record.assertion.claim { world_protocol::facts::Claim::Attribute(claim) => &claim.property, world_protocol::facts::Claim::Relation(claim) => &claim.relation_type };
    roots.definitions.push(predicate.clone());
    for subject in super::super::claim_subjects(&record.assertion.claim) { roots.resources.push(match subject { world_protocol::identity::SubjectRef::Object { id } => ResourceRef::Object { id }, world_protocol::identity::SubjectRef::Relation { id } => ResourceRef::Relation { id } }); }
    if let world_protocol::facts::Claim::Attribute(claim) = &record.assertion.claim { crate::definitions::value_resources(&claim.value, &mut roots.resources); }
    for witness in &record.witnesses {
        roots.source_versions.extend(witness.source_versions.iter().cloned());
        roots.parse_artifacts.extend(witness.parse_artifacts.iter().cloned());
        roots.definitions.push(witness.derivation.rule.clone());
        roots.definitions.extend(witness.derivation.capture_witness.iter().map(|(binding, _)| binding.clone()));
        for argument in &witness.derivation.arguments { crate::definitions::value_resources(&argument.value, &mut roots.resources); }
        for dependency in &witness.derivation.dependencies {
            match dependency {
                ReadDependency::Assertion { reference } if witness.branch_assertions.contains(reference) => {},
                ReadDependency::Evidence { reference } if witness.captured_evidence.contains(reference) => {},
                ReadDependency::Identity { .. } if witness.branch_identities.contains(dependency) => {},
                other => roots.dependencies.push(other.clone()),
            }
        }
    }
}

pub(crate) fn validate_branch_restore(world: &WorldRef, archive: &[(&str, &[Value])], retained: &[(&str, &[Value])]) -> Result<(), Error> {
    let rows = |name: &str| archive.iter().find(|(table, _)| *table == name).map_or(&[][..], |(_, rows)| *rows);
    let mut records = BTreeMap::new(); let mut immutable = BTreeMap::new();
    for (table, rows) in retained { if *table == "world_branch_derivation_revision" { for row in *rows { let record = row_record(world, row)?; immutable.insert(key(&record), record); } } }
    for row in rows("world_branch_derivation_revision") {
        let record = row_record(world, row)?;
        if let Some(old) = immutable.get(&key(&record)) { if super::encode(old)? != super::encode(&record)? { return Err(invalid()); } }
        if records.insert(key(&record), record).is_some() { return Err(invalid()); }
    }
    let mut identities = BTreeMap::new();
    let mut supports = BTreeMap::new();
    for record in immutable.values().chain(records.values()) {
        let identity = (record.branch.id.clone(), record.branch.revision, record.assertion.reference.clone());
        if identities.insert(identity.clone(), &record.assertion).is_some_and(|old| old != &record.assertion) { return Err(invalid()); }
        for support in &record.supports {
            let identity = (record.branch.id.clone(), record.branch.revision, support.reference.clone());
            if supports.insert(identity, support).is_some_and(|old| old != support) { return Err(invalid()); }
        }
    }
    let mut heads = BTreeSet::new();
    for row in rows("world_branch_derivation_head") {
        let branch = string(row, "branch_id")?; let revision = natural(row, "branch_revision")?; let id = string(row, "assertion_id")?; let journal = natural(row, "revision")?;
        if string(row, "tenant_id")? != world.tenant_id.as_str() || string(row, "world_id")? != world.world_id.as_str()
            || !records.contains_key(&(branch.to_owned(), revision, id.to_owned(), journal)) || !heads.insert((branch, revision, id)) { return Err(invalid()); }
    }
    for record in records.values() {
        let branch_row = rows("world_branch_revision").iter().find(|row| row.get("branch_id").and_then(Value::as_str) == Some(record.branch.id.as_str()) && row.get("revision").and_then(Value::as_u64) == Some(record.branch.revision.0)).ok_or_else(invalid)?;
        let branch: WorldBranch = decode_body(branch_row)?;
        let release_row = rows("world_release").iter().find(|row| row.get("release_id").and_then(Value::as_str) == Some(record.release_id.as_str())).ok_or_else(invalid)?;
        let release: Release = decode_body(release_row)?;
        let model = crate::query::proposed_branch_model(&branch, release, &world_protocol::evaluation::EvaluationArm::Candidate)?;
        if model.source_branch.as_ref() != Some(&record.branch) || definitions::canonical_digest(&model)? != record.model_digest { return Err(invalid()); }
        for witness in &record.witnesses {
            if witness.derivation.activation_lock_id != model.artifact.activation_lock_id { return Err(invalid()); }
            let mut captured = Vec::new();
            for (binding, digest) in &witness.derivation.capture_witness {
                let mut matches = Vec::new();
                for row in rows("world_source_branch_capture").iter().filter(|row| row.get("branch_id").and_then(Value::as_str) == Some(record.branch.id.as_str()) && row.get("branch_revision").and_then(Value::as_u64).is_some_and(|revision| revision <= record.branch.revision.0)
                    && row.get("binding_id").and_then(Value::as_str) == Some(binding.id.as_str()) && row.get("binding_revision").and_then(Value::as_u64) == Some(binding.revision.0)) {
                    let capture: BranchSourceCapture = decode_body(row)?;
                    let valid_time: ValidTime = serde_json::from_value(row.get("raw").and_then(|raw| raw.get("valid_time")).cloned().ok_or_else(invalid)?).map_err(|_| invalid())?;
                    let source_row = rows("world_source_version").iter().find(|row| row.get("source_id").and_then(Value::as_str) == Some(capture.source_version.source_id.as_str()) && row.get("version_id").and_then(Value::as_str) == Some(capture.source_version.version_id.as_str())).ok_or_else(invalid)?;
                    let source: world_protocol::materials::SourceVersion = decode_body(source_row)?;
                    if definitions::canonical_digest(&(&capture, &valid_time, &source))? == *digest { matches.push(capture); }
                }
                if matches.len() != 1 { return Err(invalid()); }
                captured.extend(matches);
            }
            let mut source_versions = Vec::new(); let mut parse_artifacts = Vec::new();
            for capture in &captured {
                source_versions.push(capture.source_version.clone());
                for evidence in &capture.evidence { source_versions.push(evidence.locator.source_version.clone()); parse_artifacts.extend(evidence.locator.parse_artifact_id.iter().cloned()); }
            }
            source_versions.sort_by_key(|reference| (reference.source_id.clone(), reference.version_id.clone())); source_versions.dedup();
            parse_artifacts.sort(); parse_artifacts.dedup();
            if witness.source_versions != source_versions || witness.parse_artifacts != parse_artifacts { return Err(invalid()); }
            for reference in &source_versions {
                let row = rows("world_source_version").iter().find(|row| row.get("source_id").and_then(Value::as_str) == Some(reference.source_id.as_str()) && row.get("version_id").and_then(Value::as_str) == Some(reference.version_id.as_str())).ok_or_else(invalid)?;
                let source: world_protocol::materials::SourceVersion = decode_body(row)?;
                if source.reference != *reference { return Err(invalid()); }
            }
            for id in &parse_artifacts {
                let row = rows("world_parse_artifact").iter().find(|row| row.get("artifact_id").and_then(Value::as_str) == Some(id.as_str())).ok_or_else(invalid)?;
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct ParseLocator { world: WorldRef, id: ParseArtifactId, source_version: world_protocol::materials::SourceVersionRef }
                let parse: ParseLocator = decode_body(row)?;
                if parse.world != *world || parse.id != *id || !source_versions.contains(&parse.source_version) { return Err(invalid()); }
                for evidence in captured.iter().flat_map(|capture| &capture.evidence).filter(|evidence| evidence.locator.parse_artifact_id.as_ref() == Some(id)) {
                    if evidence.locator.source_version != parse.source_version { return Err(invalid()); }
                }
            }
            for reference in &witness.captured_evidence { if !captured.iter().any(|capture| capture.evidence.iter().any(|evidence| evidence.reference == *reference)) { return Err(invalid()); } }
            let support = record.supports.iter().find(|support| support.reference == witness.support).ok_or_else(invalid)?;
            for dependency in &witness.branch_identities {
                let ReadDependency::Identity { subject, revision } = dependency else { return Err(invalid()); };
                if !captured.iter().flat_map(|capture| &capture.proposals).any(|proposal| definitions::valid_time_contains(&proposal.key.valid_time, &support.valid_time) && proposal.identity.as_ref().is_some_and(|identity| identity.revision == *revision && match &identity.record {
                    world_protocol::identity::IdentityRecord::Object(record) => *subject == world_protocol::identity::SubjectRef::Object { id: record.id.clone() },
                    world_protocol::identity::IdentityRecord::Relation(record) => *subject == world_protocol::identity::SubjectRef::Relation { id: record.id.clone() },
                })) { return Err(invalid()); }
            }
            for (reference, digest) in &witness.derivation.branch_inputs {
                if !records.values().any(|input| input.branch == record.branch && input.assertion.reference == *reference && definitions::canonical_digest(input).is_ok_and(|actual| actual == *digest)) { return Err(invalid()); }
            }
            for reference in &witness.branch_assertions { if !records.values().any(|premise| premise.branch == record.branch && premise.assertion.reference == *reference) { return Err(invalid()); } }
            for dependency in &witness.derivation.dependencies {
                match dependency {
                    ReadDependency::Assertion { reference } if !witness.branch_assertions.contains(reference) => {
                        if !rows("world_assertion_revision").iter().any(|row| row.get("assertion_id").and_then(Value::as_str) == Some(reference.id.as_str()) && row.get("revision").and_then(Value::as_u64) == Some(reference.revision.0)) { return Err(invalid()); }
                    },
                    ReadDependency::Evidence { reference } if !witness.captured_evidence.contains(reference) => {
                        if !rows("world_evidence_revision").iter().any(|row| row.get("evidence_id").and_then(Value::as_str) == Some(reference.id.as_str()) && row.get("revision").and_then(Value::as_u64) == Some(reference.revision.0)) { return Err(invalid()); }
                    },
                    ReadDependency::Definition { reference } => { if !model.definitions.iter().any(|definition| definition.reference == *reference) { return Err(invalid()); } }, _ => {},
                }
            }
        }
    }
    Ok(())
}
fn key(record: &BranchDerivationRecord) -> (String, u64, String, u64) { (record.branch.id.to_string(), record.branch.revision.0, record.assertion.reference.id.to_string(), record.revision.0) }
fn string<'a>(row: &'a Value, key: &str) -> Result<&'a str, Error> { row.get(key).and_then(Value::as_str).ok_or_else(invalid) }
fn natural(row: &Value, key: &str) -> Result<u64, Error> { row.get(key).and_then(Value::as_u64).filter(|value| *value > 0).ok_or_else(invalid) }
fn decode_body<T: serde::de::DeserializeOwned>(row: &Value) -> Result<T, Error> { serde_json::from_value(row.get("body").cloned().ok_or_else(invalid)?).map_err(|error| Error::caused_by(FactFailure::InternalFault, error)) }
fn row_record(world: &WorldRef, row: &Value) -> Result<BranchDerivationRecord, Error> {
    let record: BranchDerivationRecord = decode_body(row)?; validate_record(&record)?;
    if &record.branch.world != world || natural(row, "branch_revision")? != record.branch.revision.0 || natural(row, "revision")? != record.revision.0 { return Err(invalid()); }
    for (field, expected) in [("tenant_id", world.tenant_id.as_str()), ("world_id", world.world_id.as_str()), ("branch_id", record.branch.id.as_str()), ("assertion_id", record.assertion.reference.id.as_str()), ("release_id", record.release_id.as_str()), ("model_digest", record.model_digest.as_str()), ("derivation_digest", record.derivation_digest.as_str()), ("run_id", record.run_id.as_str()), ("step_id", record.step_id.as_str())] { if string(row, field)? != expected { return Err(invalid()); } }
    Ok(record)
}
