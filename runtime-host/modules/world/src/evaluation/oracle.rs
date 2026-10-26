use world_protocol::{
    actions::{SourceReceipt, VerificationReceipt, VerificationVerdict},
    authorization::{Decision, PolicyVerdict},
    bindings::{ActivationLock, ImplementationRef, PortDirection, SlotKind, TrustClass},
    ids::ActorId,
    learning::OracleSpec,
    time::Timestamp,
};

use super::{ConstraintFailure, constraints::validate_oracle};

/// Inputs are owner-resolved facts. A model-supplied OracleSpec is not its own qualification.
pub(crate) fn qualify_oracle(
    oracle: &OracleSpec,
    lock: &ActivationLock,
    candidate_implementations: &[ImplementationRef],
    proposer: &ActorId,
    authenticated_human: Option<(&ActorId, &Decision)>,
    now: &Timestamp,
) -> Result<(), ConstraintFailure> {
    validate_oracle(oracle)?;
    match oracle {
        OracleSpec::Program {
            implementation,
            fixture_schema,
            result_schema,
        } => {
            if candidate_implementations.iter().any(|candidate| {
                candidate.artifact_digest == implementation.artifact_digest
                    || candidate.package_digest == implementation.package_digest
            }) {
                return Err(ConstraintFailure::OracleNotIndependent);
            }
            let trusted = lock.nodes.iter().any(|node| {
                &node.implementation == implementation
                    && node.slot == SlotKind::Evaluation
                    && matches!(
                        node.trust,
                        TrustClass::TrustedNative
                            | TrustClass::TrustedProcess
                            | TrustClass::PrivateRoot
                    )
                    && node.ports.iter().any(|port| {
                        port.direction == PortDirection::Export
                            && &port.request_schema == fixture_schema
                            && &port.result_schema == result_schema
                    })
            });
            if !trusted {
                return Err(ConstraintFailure::OracleNotTrusted);
            }
        }
        OracleSpec::Human {
            actor_id,
            decision_id,
            binding_digest,
        } => {
            if actor_id == proposer {
                return Err(ConstraintFailure::OracleNotIndependent);
            }
            let Some((authenticated_actor, decision)) = authenticated_human else {
                return Err(ConstraintFailure::OracleUnverified);
            };
            if authenticated_actor != actor_id
                || &decision.id != decision_id
                || &decision.impact_digest != binding_digest
                || decision.verdict != PolicyVerdict::Allow
                || decision.evaluated_at > *now
                || decision
                    .expires_at
                    .as_ref()
                    .is_some_and(|expiry| expiry <= now)
            {
                return Err(ConstraintFailure::OracleUnverified);
            }
        }
        // Qualification does not turn a receipt into an oracle verdict. Verification below
        // additionally requires the authoritative result receipt for the same effect intent.
        OracleSpec::SourceReceipt { .. } => {}
    }
    Ok(())
}

pub(super) fn expected_counts(
    bytes: &[u8],
    world: &world_protocol::ids::WorldRef,
    maximum: usize,
) -> Result<(u64, u64), world_protocol::slots::OracleFailure> {
    use std::collections::BTreeSet;
    use world_protocol::{slots::OracleFailure, value::Cell};

    let expected: world_protocol::slots::OracleExpected =
        world_protocol::wire::decode(bytes, maximum).map_err(|failure| match failure {
            world_protocol::wire::CodecFailure::SizeLimit => OracleFailure::BudgetExceeded,
            _ => OracleFailure::BadFixture,
        })?;
    if expected.fields.is_empty() {
        return Err(OracleFailure::BadFixture);
    }
    let mut keys = BTreeSet::new();
    let mut required = 0u64;
    let mut present = 0u64;
    for field in &expected.fields {
        if field.property.world != *world
            || field.property.revision.0 == 0
            || !keys.insert((&field.step_id, &field.subject, &field.property))
            || field
                .evidence
                .iter()
                .any(|reference| reference.world != *world || reference.revision.0 == 0)
            || field.evidence.iter().collect::<BTreeSet<_>>().len() != field.evidence.len()
        {
            return Err(OracleFailure::BadFixture);
        }
        required = required
            .checked_add(field.evidence.len() as u64)
            .ok_or(OracleFailure::BudgetExceeded)?;
        if let Cell::Conflicted { assertions } = &field.cell {
            if assertions
                .iter()
                .any(|reference| reference.world != *world || reference.revision.0 == 0)
                || assertions.iter().collect::<BTreeSet<_>>().len() != assertions.len()
            {
                return Err(OracleFailure::BadFixture);
            }
            present = present
                .checked_add(1)
                .ok_or(OracleFailure::BudgetExceeded)?;
        }
    }
    Ok((required, present))
}

pub(crate) fn verify_source_receipt(
    oracle: &OracleSpec,
    receipt: &SourceReceipt,
    verification: &VerificationReceipt,
) -> Result<bool, ConstraintFailure> {
    let OracleSpec::SourceReceipt {
        source_id,
        required_disposition,
    } = oracle
    else {
        return Err(ConstraintFailure::OracleUnverified);
    };
    validate_oracle(oracle)?;
    if receipt.source_id != *source_id
        || receipt.intent_id != verification.intent_id
        || verification.verified_at < receipt.observed_at
        || !verification.read_receipt.coverage.complete
        || !verification.read_receipt.dirty.is_empty()
        || verification.read_receipt.truncation.is_some()
        || !verification.read_receipt.basis.iter().any(|basis| {
            basis.source_id == *source_id
                && basis.gap.is_none()
                && basis.guarantee == world_protocol::sources::SourceGuarantee::Authoritative
        })
    {
        return Err(ConstraintFailure::OracleUnverified);
    }
    match verification.verdict {
        VerificationVerdict::Verified => Ok(receipt.disposition == *required_disposition),
        VerificationVerdict::NotSatisfied => Ok(false),
        VerificationVerdict::Inconclusive => Err(ConstraintFailure::OracleUnverified),
    }
}
