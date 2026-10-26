use world_protocol::{actions::{EffectIntent, VerificationReceipt, VerificationVerdict}, definitions::DefinitionBody, expression::TruthValue, failure::FieldPath, ids::*, query::{QueryArgument, QueryFailure, ReadMode}, sources::SourceGuarantee, time::Timestamp};
use crate::{authorization::Admission, store::WorldTransaction};
use super::{PreparedQuery, QueryError, EvalContext, engine, error::invalid, evaluate_metered, truth_value};

/// Canonical expected expression evaluated over this exact query's retained VM bindings.
pub(crate) struct VerificationEvaluation {
    read: ReadReceiptId, contract: DefinitionRef, arguments: Vec<QueryArgument>, digest: Digest,
    verdict: VerificationVerdict, evidence: Vec<EvidenceRef>, verified_at: Timestamp,
}
impl VerificationEvaluation {
    pub(crate) fn verdict(&self) -> VerificationVerdict { self.verdict }
    pub(crate) fn evidence(&self) -> &[EvidenceRef] { &self.evidence }
    pub(crate) fn verified_at(&self) -> &Timestamp { &self.verified_at }
}
pub(crate) fn evaluate_verification(prepared: &PreparedQuery, contract: &DefinitionRef, arguments: &[QueryArgument], at: &Timestamp) -> Result<VerificationEvaluation, QueryError> {
    if prepared.resumed || prepared.verifier.as_ref() != Some(contract) || prepared.request.branch_id.is_some()
        || prepared.request.known_at.is_some()
        || prepared.request.arguments != arguments || at < &prepared.read.receipt.observed_at {
        return Err(QueryFailure::BasisChanged.into());
    }
    let definition = prepared.release.definitions.iter().find(|item| item.reference == *contract).ok_or(QueryFailure::BasisChanged)?;
    let DefinitionBody::ActionContract(action) = &definition.body else { return Err(invalid("contract")); };
    if action.verifier.query != prepared.request.query { return Err(invalid("verifier.query")); }
    let (plan, output, cancel) = prepared.evaluation.as_ref().ok_or(QueryFailure::BasisChanged)?;
    let parameters = engine::parameters(&action.parameters, arguments)?;
    let mut uncertain = !prepared.read.receipt.coverage.complete || !prepared.read.receipt.dirty.is_empty()
        || prepared.read.receipt.truncation.is_some() || output.incomplete;
    if action.verifier.require_authoritative {
        uncertain |= prepared.request.read_mode != ReadMode::Authoritative
            || prepared.read.receipt.basis.iter().any(|basis| !matches!(basis.guarantee, SourceGuarantee::Authoritative) || basis.gap.is_some());
    }
    let mut failed = output.bindings.is_empty();
    for row in &output.bindings {
        let cell = evaluate_metered(&action.verifier.expected, &EvalContext { parameters: &parameters, row, collections: &output.collections, ranges: None,
            functions: &plan.functions, annotations: &plan.annotations, at, max_evaluations: prepared.budget.limit().max_steps.saturating_sub(prepared.budget.usage().steps), cancellation: cancel },
            &FieldPath(vec!["verifier".into(), "expected".into()]), &prepared.budget)?;
        match truth_value(&cell)? { TruthValue::True => {}, TruthValue::False => failed = true, _ => uncertain = true }
    }
    let verdict = if uncertain { VerificationVerdict::Inconclusive } else if failed { VerificationVerdict::NotSatisfied } else { VerificationVerdict::Verified };
    let mut evidence: Vec<_> = prepared.read.receipt.actual_dependencies.iter().filter_map(|dependency| match dependency {
        world_protocol::provenance::ReadDependency::Evidence { reference } => Some(reference.clone()), _ => None,
    }).collect();
    evidence.sort(); evidence.dedup();
    let digest = crate::definitions::canonical_digest(&("world.action.verification.v1", &prepared.read.receipt, contract, arguments, &verdict, &evidence, at))?;
    Ok(VerificationEvaluation { read: prepared.read.receipt.id.clone(), contract: contract.clone(), arguments: arguments.to_vec(), digest, verdict, evidence, verified_at: at.clone() })
}

/// Consumes the actual prepared read once. The actions owner persists the returned receipt.
pub(crate) async fn commit_verification(tx: &mut WorldTransaction<'_>, admission: &Admission, prepared: PreparedQuery, evaluation: VerificationEvaluation, intent: &EffectIntent) -> Result<VerificationReceipt, QueryError> {
    if evaluation.read != prepared.read.receipt.id || evaluation.contract != intent.action || evaluation.arguments != intent.argument_values
        || intent.action.world != *tx.world() || intent.activation_lock_id != prepared.release.artifact.activation_lock_id
        || evaluation.digest != crate::definitions::canonical_digest(&("world.action.verification.v1", &prepared.read.receipt, &evaluation.contract, &evaluation.arguments, &evaluation.verdict, &evaluation.evidence, &evaluation.verified_at))? {
        return Err(QueryFailure::BasisChanged.into());
    }
    let durable = tx.query_opt("SELECT record FROM world_effect_intent WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3 FOR SHARE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &intent.id.as_str()]).await?.ok_or(QueryFailure::BasisChanged)?;
    if super::error::decode::<EffectIntent>(durable.get("record"))? != *intent { return Err(QueryFailure::BasisChanged.into()); }
    let page = super::commit_read(tx, admission, prepared).await?;
    Ok(VerificationReceipt { id: VerificationId::try_new(uuid::Uuid::new_v4().to_string()).map_err(|_| QueryFailure::InternalFault)?, intent_id: intent.id.clone(), verdict: evaluation.verdict, read_receipt: page.receipt, evidence: evaluation.evidence, verified_at: evaluation.verified_at })
}
