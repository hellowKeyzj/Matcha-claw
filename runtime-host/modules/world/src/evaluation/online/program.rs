use std::sync::Arc;

use super::super::{ConstraintFailure, Error, records};
use super::{OnlineOraclePlan, changed, maximum};
use crate::{
    authorization::{self, Admission, EvaluationAuthority, OnlineOracleBinding},
    extensions::{
        bindings::BindingGraph,
        invocation::{CompositionFailure, InvocationContext, invoke_composition},
    },
    owner::{self, ExecutionContext},
    store::{StoreFuture, WorldTransaction},
};
use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    bindings::{ActivationLock, ExactClosure, PortDirection, SlotKind, TrustClass},
    budget::BudgetDimension,
    evaluation::EvaluationFailure,
    ids::*,
    learning::OracleSpec,
    provenance::ReadDependency,
    query::QueryPage,
    slots::{
        OracleExpected, OracleFailure, OracleQueryObservation, OracleRequest, OracleResult,
        SlotFailure, SlotRequest, SlotResponse,
    },
    time::Timestamp,
};

mod custody;
pub(crate) use custody::online_oracle_retention_roots;

pub(super) struct ProgramProof {
    pub result: OracleResult,
    authority: EvaluationAuthority,
    admission: Admission,
    invocation: Invocation,
    custody: custody::Custody,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Invocation {
    binding: OnlineOracleBinding,
    oracle: OracleSpec,
    invocation_id: InvocationId,
    observed: Digest,
    queries: Digest,
    graph: ActivationLock,
    closure: ExactClosure,
    root: NodeId,
}

pub(super) fn check<'a>(
    ctx: &'a ExecutionContext,
    plan: &'a OnlineOraclePlan,
    page: &'a QueryPage,
    queries: &'a [OracleQueryObservation],
) -> StoreFuture<'a, Option<ProgramProof>, owner::Error> {
    Box::pin(async move {
        let OracleSpec::Program {
            implementation,
            fixture_schema,
            result_schema,
        } = &plan.test.oracle
        else {
            return Err(Error::from(ConstraintFailure::OracleUnverified).into());
        };
        let auth = ctx.admission.clone();
        let lock = plan.binding.activation_lock_id.clone();
        let request = plan.request.query.clone();
        let (graph, channels, model) = ctx
            .store
            .snapshot(plan.binding.task.world.clone(), move |snapshot| {
                Box::pin(async move {
                    authorization::recheck_read(snapshot, &auth, &snapshot.now().await?).await?;
                    let graph = crate::extensions::bindings::read_graph(snapshot, &lock).await?;
                    let channels = crate::extensions::bindings::read_channels(snapshot)
                        .await?
                        .into_iter()
                        .map(|(_, channel)| channel.map_err(|failure| Error::Binding(failure.into())))
                        .collect::<Result<Vec<_>, Error>>()?;
                    let model = crate::query::read_release(snapshot, &request).await?;
                    Ok::<_, Error>((graph, channels, model))
                })
            })
            .await?;
        if model.artifact.activation_lock_id != plan.binding.activation_lock_id {
            return Err(changed().into());
        }
        let nodes: Vec<_> = graph
            .lock()
            .nodes
            .iter()
            .filter(|node| {
                node.slot == SlotKind::Evaluation
                    && &node.implementation == implementation
                    && node.ports.iter().any(|port| {
                        port.direction == PortDirection::Export
                            && &port.request_schema == fixture_schema
                            && &port.result_schema == result_schema
                    })
            })
            .collect();
        if nodes.len() != 1 {
            return Err(Error::from(ConstraintFailure::OracleNotTrusted).into());
        }
        let node = nodes[0].clone();
        let closure = graph
            .exact_closure(&node.id, &channels)
            .map_err(|failure| Error::Binding(failure.into()))?;
        for id in &closure.nodes {
            if !matches!(
                graph
                    .node(id)
                    .map_err(|failure| Error::Binding(failure.into()))?
                    .trust,
                TrustClass::TrustedNative | TrustClass::TrustedProcess | TrustClass::PrivateRoot
            ) {
                return Err(Error::from(ConstraintFailure::OracleNotTrusted).into());
            }
        }
        let expected: OracleExpected =
            world_protocol::wire::decode(&plan.expected, maximum(&plan.task)).map_err(wire_failure)?;
        let evidence: Vec<_> = expected
            .fields
            .iter()
            .flat_map(|field| field.evidence.iter().cloned())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let impact = base_impact(&graph, &closure, &plan.binding, &plan.task.scope)?;
        let authority = ctx.evaluation_authority()?.clone();
        if !authority.same_root(&ctx.authority) {
            return Err(changed().into());
        }
        let observed = records::digest(page)?;
        let mut existing = custody::read(ctx, plan, &observed, &records::digest(&queries)?).await?;
        if existing.as_ref().is_some_and(|existing| {
            existing.invocation.graph != *graph.lock()
                || existing.invocation.closure != closure
                || existing.invocation.root != node.id
        }) {
            return Err(changed().into());
        }
        if let Some(saved) = existing.take() {
            existing = custody::inspect(ctx, plan, page, queries, &graph, saved).await?;
            if existing.is_none() {
                return Ok(None);
            }
        }
        let input = records::digest(&(&plan.binding, &observed, implementation))?;
        let request = ctx
            .commit_request(
                &format!("online.oracle.admit.{}", ctx.admission.invocation().id),
                input,
                &["authorization"],
            )
            .await?;
        let caller = ctx.admission.clone();
        let exact = plan.binding.clone();
        let implementation = implementation.clone();
        let digest = observed.clone();
        let auth = authority.clone();
        let scope = plan.task.scope.clone();
        let evidence_for_admit = evidence.clone();
        let admitted = authorization::commit_admission(&ctx.store, request.prepare()?, move |tx| {
            Box::pin(async move {
                let now = tx.now().await?;
                authorization::recheck(tx, &caller, &now).await?;
                owner::require_run_invocation(tx, &caller, &exact.run_id).await?;
                let impact =
                    evidence_impact(tx, impact, &evidence_for_admit, &model, &scope, &now).await?;
                let admission = auth
                    .online_oracle(tx, &exact, &implementation, &digest, &impact, &now)
                    .await?;
                let interval = crate::query::point_interval(&now)?;
                crate::facts::assertions::require_evidence(
                    tx,
                    &admission,
                    &evidence_for_admit,
                    &scope,
                    Some(&interval),
                    &now,
                )
                .await
                .map_err(Error::Fact)?;
                Ok::<_, Error>(((), admission))
            })
        })
        .await;
        let admission = match admitted {
            Ok(authorization::AdmissionCommit::Committed { admission, .. }) => admission,
            Ok(authorization::AdmissionCommit::Replayed(_)) => {
                return Err(Error::from(EvaluationFailure::OracleUnavailable).into());
            }
            Err(error) => return Err(owner::Error::from(error)),
        };
        if let Some(existing) = existing {
            let Some((invocation, custody)) =
                custody::restore(ctx, &graph, &authority, &admission, existing).await?
            else {
                return Ok(None);
            };
            let result = custody.result.clone().map_err(|failure| {
                owner::Error::from_host_failure(failure, world_protocol::failure::FailureStage::Verify)
            })?;
            let proof = ProgramProof {
                result,
                authority,
                admission,
                invocation,
                custody,
            };
            let saved = proof.invocation.clone();
            let retained = proof.custody.clone();
            let auth = proof.admission.clone();
            let authority = proof.authority.clone();
            let scope = plan.task.scope.clone();
            let evidence = proof.result.evidence.clone();
            let checked = ctx
                .transact(
                    &format!("online.oracle.resume.{}", ctx.admission.invocation().id),
                    records::digest(&saved)?,
                    &["authorization", "content"],
                    move |tx, _, _, _| {
                        Box::pin(async move {
                            let now = tx.now().await?;
                            authority
                                .recheck_online_oracle(
                                    tx,
                                    &auth,
                                    &saved.binding,
                                    custody::implementation(&saved)?,
                                    &saved.observed,
                                    &now,
                                )
                                .await?;
                            custody::recheck(tx, &saved, &retained).await?;
                            let interval = crate::query::point_interval(&now)?;
                            crate::facts::assertions::require_evidence(
                                tx,
                                &auth,
                                &evidence,
                                &scope,
                                Some(&interval),
                                &now,
                            )
                            .await
                            .map_err(Error::Fact)?;
                            Ok(())
                        })
                    },
                )
                .await;
            checked?;
            validate_result(plan, &proof.result)?;
            return Ok(Some(proof));
        }
        let budget = ctx
            .budget
            .scoped(&plan.task.budget, &super::super::accounting::now())
            .map_err(budget_failure)?;
        let invocation = Invocation {
            binding: plan.binding.clone(),
            oracle: plan.test.oracle.clone(),
            invocation_id: admission.invocation().id.clone(),
            observed,
            queries: records::digest(&queries)?,
            graph: graph.lock().clone(),
            closure: closure.clone(),
            root: node.id.clone(),
        };
        let lease = Arc::new(
            ctx.resources
                .live
                .acquire(
                    &plan.binding.task.world,
                    &plan.binding.activation_lock_id,
                    &node.id,
                    admission.invocation().id.clone(),
                    super::super::accounting::now(),
                )
                .map_err(Error::from)?,
        );
        let checked = async {
            if lease.graph().lock() != &invocation.graph || lease.closure() != &closure {
                return Err(changed());
            }
            let context = InvocationContext::new(
                Arc::new(ctx.store.clone()),
                admission.clone(),
                lease.clone(),
                node.id.clone(),
                ctx.pipeline.clone(),
                budget.clone(),
            )?;
            let services = ctx
                .invocation_service_seed()
                .for_lease(&lease, None, Vec::new())?;
            let request = SlotRequest::Evaluation(OracleRequest {
                world: plan.task.world.clone(),
                test_case_id: plan.test.id.clone(),
                fixture: plan.fixture.clone(),
                expected: plan.expected.clone(),
                observed: world_protocol::wire::encode(page, maximum(&plan.task))
                    .map_err(wire_failure)?,
                queries: queries.to_vec(),
                budget: budget.limit(),
            });
            let step = custody::claim(ctx, &authority, &admission, &invocation, &budget).await?;
            let outcome = invoke_composition(context, request, services).await;
            lease.finish();
            let custody = custody::retain(
                ctx,
                &authority,
                &admission,
                &invocation,
                &step,
                &budget,
                &outcome,
                "online.oracle.custody",
            )
            .await;
            if custody.as_ref().is_ok_and(|custody| !custody.settled) {
                return Ok(None);
            }
            let custody = match outcome {
                Ok(outcome) => match outcome.result {
                    Ok(SlotResponse::Evaluation(result)) => (custody?, result),
                    Ok(_) => {
                        return super::content::preserve(
                            Err(ConstraintFailure::OracleUnverified.into()),
                            custody.map(|_| ()),
                        );
                    }
                    Err(error) => {
                        return super::content::preserve(
                            Err(Error::Composition(error)),
                            custody.map(|_| ()),
                        );
                    }
                },
                Err(error) => {
                    return super::content::preserve(
                        Err(Error::Composition(error)),
                        custody.map(|_| ()),
                    );
                }
            };
            let (custody, result) = custody;
            validate_result(plan, &result)?;
            let proof = ProgramProof {
                result,
                authority: authority.clone(),
                admission: admission.clone(),
                invocation: invocation.clone(),
                custody,
            };
            let exact_plan = plan.binding.clone();
            let proof_evidence = proof.result.evidence.clone();
            let evidence_for_check = proof_evidence.clone();
            let scope = plan.task.scope.clone();
            let auth = admission.clone();
            let authority = authority.clone();
            let implementation = node.implementation.clone();
            let digest = invocation.observed.clone();
            let request = ctx
                .commit_request(
                    "online.oracle.evidence",
                    records::digest(&(&invocation, &proof_evidence))?,
                    &["authorization"],
                )
                .await?;
            super::super::io::transact(&ctx.store, &request, "verify", &proof_evidence, move |tx| {
                Box::pin(async move {
                    let now = tx.now().await?;
                    authority
                        .recheck_online_oracle(tx, &auth, &exact_plan, &implementation, &digest, &now)
                        .await?;
                    let interval = crate::query::point_interval(&now)?;
                    crate::facts::assertions::require_evidence(
                        tx,
                        &auth,
                        &evidence_for_check,
                        &scope,
                        Some(&interval),
                        &now,
                    )
                    .await
                    .map_err(Error::Fact)?;
                    Ok(())
                })
            })
            .await?;
            Ok(Some(proof))
        }
        .await;
        lease.finish();
        checked.map_err(Into::into)
    })
}

fn base_impact(
    graph: &BindingGraph,
    closure: &ExactClosure,
    binding: &OnlineOracleBinding,
    scope: &ScopeId,
) -> Result<ActualImpact, Error> {
    let states: Vec<_> = closure
        .nodes
        .iter()
        .filter_map(|id| {
            graph
                .node(id)
                .ok()
                .and_then(|node| node.state.as_ref().map(|state| state.root.clone()))
        })
        .collect();
    let mut access = vec![AccessScope {
        resources: vec![
            ResourceRef::Task {
                id: binding.task.id.clone(),
            },
            ResourceRef::TestCase {
                id: binding.test.id.clone(),
            },
            ResourceRef::Case {
                id: binding.case_id.clone(),
            },
        ],
        fields: Vec::new(),
        modes: vec![AccessMode::Read],
        scope: scope.clone(),
        valid_time: None,
    }];
    access.push(AccessScope {
        resources: closure
            .affected_bindings
            .iter()
            .cloned()
            .map(|id| ResourceRef::Binding { id })
            .collect(),
        fields: Vec::new(),
        modes: vec![AccessMode::Execute],
        scope: scope.clone(),
        valid_time: None,
    });
    if !states.is_empty() {
        access.push(AccessScope {
            resources: states
                .iter()
                .map(|state| ResourceRef::State {
                    id: state.id.clone(),
                })
                .collect(),
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: scope.clone(),
            valid_time: None,
        });
    }
    Ok(authorization::actual_impact(
        access,
        Vec::new(),
        Vec::new(),
        states,
        Vec::new(),
    )?)
}

async fn evidence_impact(
    tx: &WorldTransaction<'_>,
    mut impact: ActualImpact,
    evidence: &[EvidenceRef],
    model: &world_protocol::releases::Release,
    scope: &ScopeId,
    now: &Timestamp,
) -> Result<ActualImpact, Error> {
    if !evidence.is_empty() {
        let dependencies: Vec<_> = evidence
            .iter()
            .cloned()
            .map(|reference| ReadDependency::Evidence { reference })
            .collect();
        let interval = crate::query::point_interval(now)?;
        let material =
            crate::facts::support::dependency_impact(tx, &dependencies, model, scope, &interval)
                .await?
                .ok_or(EvaluationFailure::OracleUnavailable)?;
        impact.access.extend(material.access);
        impact.effects.extend(material.effects);
        impact.labels.extend(material.labels);
        impact.state.extend(material.state);
        impact.source_ids.extend(material.source_ids);
    }
    Ok(authorization::actual_impact(
        impact.access,
        impact.effects,
        impact.labels,
        impact.state,
        impact.source_ids,
    )?)
}

fn validate_result(plan: &OnlineOraclePlan, result: &OracleResult) -> Result<(), Error> {
    let (required, present) = super::super::oracle::expected_counts(
        &plan.expected,
        &plan.task.world,
        maximum(&plan.task),
    )
    .map_err(oracle_failure)?;
    let expected: OracleExpected =
        world_protocol::wire::decode(&plan.expected, maximum(&plan.task)).map_err(|failure| {
            oracle_failure(match failure {
                world_protocol::wire::CodecFailure::SizeLimit => OracleFailure::BudgetExceeded,
                _ => OracleFailure::BadFixture,
            })
        })?;
    let expected_evidence: std::collections::BTreeSet<_> = expected
        .fields
        .iter()
        .flat_map(|field| &field.evidence)
        .collect();
    let result_evidence: std::collections::BTreeSet<_> = result.evidence.iter().collect();
    let valid = |numerator, denominator, expected| match (numerator, denominator) {
        (Some(numerator), Some(denominator)) => numerator <= denominator && denominator == expected,
        _ => false,
    };
    if !valid(
        result.evidence_satisfied,
        result.evidence_required,
        required,
    ) || !valid(result.conflicts_detected, result.conflicts_present, present)
        || !result_evidence.is_subset(&expected_evidence)
        || result.passed
            && (result.evidence_satisfied != Some(required)
                || result.conflicts_detected != Some(present)
                || result_evidence != expected_evidence)
        || result
            .evidence
            .iter()
            .any(|reference| reference.world != plan.task.world || reference.revision.0 == 0)
    {
        return Err(oracle_failure(OracleFailure::SchemaMismatch));
    }
    Ok(())
}

pub(super) async fn recheck(
    tx: &WorldTransaction<'_>,
    plan: &OnlineOraclePlan,
    page: &QueryPage,
    queries: &[OracleQueryObservation],
    proof: &ProgramProof,
    now: &Timestamp,
) -> Result<(), Error> {
    validate_result(plan, &proof.result)?;
    let OracleSpec::Program { implementation, .. } = &plan.test.oracle else {
        return Err(changed());
    };
    if proof.invocation.binding != plan.binding
        || proof.invocation.oracle != plan.test.oracle
        || proof.invocation.observed != records::digest(page)?
        || proof.invocation.queries != records::digest(&queries)?
        || !proof.custody.settled
    {
        return Err(changed());
    }
    proof
        .authority
        .recheck_online_oracle(
            tx,
            &proof.admission,
            &plan.binding,
            implementation,
            &proof.invocation.observed,
            now,
        )
        .await?;
    custody::recheck(tx, &proof.invocation, &proof.custody).await?;
    let interval = crate::query::point_interval(now)?;
    crate::facts::assertions::require_evidence(
        tx,
        &proof.admission,
        &proof.result.evidence,
        &plan.task.scope,
        Some(&interval),
        now,
    )
    .await
    .map_err(Error::Fact)?;
    Ok(())
}

pub(super) fn budget_failure(error: crate::extensions::invocation::BudgetFailure) -> Error {
    EvaluationFailure::BudgetExhausted {
        dimension: error.dimension,
    }
    .into()
}
pub(super) fn oracle_failure(failure: OracleFailure) -> Error {
    Error::Composition(CompositionFailure::Slot(SlotFailure::Evaluation(failure)))
}
pub(super) fn wire_failure(error: world_protocol::wire::CodecFailure) -> Error {
    match error {
        world_protocol::wire::CodecFailure::SizeLimit => EvaluationFailure::BudgetExhausted {
            dimension: BudgetDimension::Bytes,
        }
        .into(),
        error => Error::Owner(
            owner::Error::internal(world_protocol::failure::FailureStage::Decode).caused(error),
        ),
    }
}
