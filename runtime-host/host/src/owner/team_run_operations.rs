use foundation::execution::OperationHandle;
use organization::{GraphRunPurgeOutcome, NativeDeletionEvidence, RoleAbortOutcome};
use tokio::sync::oneshot;

use crate::Host;

use super::{
    actor::TerminalWatches,
    command::{TeamRunCommand, TeamRuntimeCommandOutcome},
    team_runtime_operations::TEAM_RUNTIME_OPERATION_CAPACITY,
};

pub(super) struct TeamRunOperation {
    operation: OperationHandle<TeamRunCompletion>,
}

enum TeamRunCompletion {
    ManualMaterialized {
        team_id: organization::TeamId,
        run: organization::GraphRunFacts,
        run_idempotency_key: String,
        outcome: organization::MaterializationOperationOutcome,
        reply: oneshot::Sender<crate::composition::ManualTeamCreateOutcome>,
    },
    ManualRunReceipt {
        created: organization::CreateGraphRunOutcome,
        receipt: organization::RunRuntimeReceipt,
        outcome: crate::composition::RuntimeReceiptOutcome,
        reply: oneshot::Sender<crate::composition::ManualTeamCreateOutcome>,
    },
    CancellationAborted {
        run_id: organization::GraphRunId,
        idempotency_key: String,
        observed_at: u64,
        outcome: RoleAbortOutcome,
        reply: oneshot::Sender<
            Result<organization::BeginCancellationOutcome, organization::StoreFault>,
        >,
    },
    RunDeleted {
        run_id: organization::GraphRunId,
        idempotency_key: String,
        observed_at: u64,
        outcome: NativeDeletionEvidence,
        reply: oneshot::Sender<Result<GraphRunPurgeOutcome, organization::StoreFault>>,
    },
    TeamRunDeleted {
        team_id: organization::TeamId,
        idempotency_key: String,
        observed_at: u64,
        run_id: organization::GraphRunId,
        outcome: NativeDeletionEvidence,
        reply: TeamDeleteReply,
    },
    TeamRemoved {
        team_id: organization::TeamId,
        idempotency_key: String,
        outcome: Option<organization::MaterializationOperationOutcome>,
        reply: TeamDeleteReply,
    },
}

pub(super) enum TeamDeleteReply {
    TeamRun(
        oneshot::Sender<Result<crate::composition::TeamDeleteOutcome, organization::StoreFault>>,
    ),
    TeamRuntime(oneshot::Sender<TeamRuntimeCommandOutcome>),
}

impl TeamDeleteReply {
    fn send(
        self,
        outcome: Result<crate::composition::TeamDeleteOutcome, organization::StoreFault>,
    ) {
        match self {
            Self::TeamRun(reply) => {
                let _ = reply.send(outcome);
            }
            Self::TeamRuntime(reply) => {
                let _ = reply.send(TeamRuntimeCommandOutcome::Delete(outcome));
            }
        }
    }
}

pub(super) async fn wait_for_team_run_operation(operations: &mut [TeamRunOperation]) {
    loop {
        if operations
            .iter()
            .any(|operation| operation.operation.is_finished())
        {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

pub(super) async fn poll_team_run_operations(
    host: &mut Host,
    operations: &mut Vec<TeamRunOperation>,
) {
    let mut pending = Vec::with_capacity(operations.len());
    for mut operation in operations.drain(..) {
        if operation.operation.is_finished() {
            let Ok(completion) = operation.operation.join().await else {
                continue;
            };
            complete_team_run_operation(host, completion, &mut pending);
        } else {
            pending.push(operation);
        }
    }
    *operations = pending;
}

pub(super) async fn cancel_team_run_operations(operations: &mut Vec<TeamRunOperation>) {
    for operation in operations.drain(..) {
        operation.operation.cancel();
    }
}

fn complete_team_run_operation(
    host: &mut Host,
    completion: TeamRunCompletion,
    operations: &mut Vec<TeamRunOperation>,
) {
    match completion {
        TeamRunCompletion::ManualMaterialized {
            team_id,
            run,
            run_idempotency_key,
            outcome,
            reply,
        } => match host.complete_manual_team_materialization(
            &team_id,
            run,
            &run_idempotency_key,
            outcome,
        ) {
            Ok((created, receipt)) => {
                let operation = host.team_confirm_receipt(receipt.clone());
                let operation = OperationHandle::spawn(move |_| async move {
                    let outcome = operation.await;
                    TeamRunCompletion::ManualRunReceipt {
                        created,
                        receipt,
                        outcome,
                        reply,
                    }
                })
                .0;
                operations.push(TeamRunOperation { operation });
            }
            Err(outcome) => {
                let _ = reply.send(outcome);
            }
        },
        TeamRunCompletion::ManualRunReceipt {
            created,
            receipt,
            outcome,
            reply,
        } => {
            let outcome = host.install_manual_team_run_runtime_receipt(created, receipt, outcome);
            let _ = reply.send(outcome);
        }
        TeamRunCompletion::CancellationAborted {
            run_id,
            idempotency_key,
            observed_at,
            outcome,
            reply,
        } => {
            let outcome = host.settle_team_run_cancellation_outcome(
                &run_id,
                &idempotency_key,
                outcome,
                observed_at,
            );
            let _ = reply.send(outcome);
        }
        TeamRunCompletion::RunDeleted {
            run_id,
            idempotency_key,
            observed_at,
            outcome,
            reply,
        } => {
            let outcome = host.complete_team_run_delete_native_evidence(
                run_id,
                &idempotency_key,
                outcome,
                observed_at,
            );
            let _ = reply.send(outcome);
        }
        TeamRunCompletion::TeamRunDeleted {
            team_id,
            idempotency_key,
            observed_at,
            run_id,
            outcome,
            reply,
        } => match host.complete_team_run_delete_native_evidence(
            run_id,
            &idempotency_key,
            outcome,
            observed_at,
        ) {
            Ok(GraphRunPurgeOutcome::Purged | GraphRunPurgeOutcome::Replayed) => {
                start_team_delete_operation(
                    host,
                    team_id,
                    idempotency_key,
                    observed_at,
                    reply,
                    operations,
                );
            }
            Ok(_) => {
                reply.send(Ok(crate::composition::TeamDeleteOutcome::OutcomeUnknown));
            }
            Err(error) => {
                reply.send(Err(error));
            }
        },
        TeamRunCompletion::TeamRemoved {
            team_id,
            idempotency_key,
            outcome,
            reply,
        } => {
            let outcome = host.complete_team_delete_removal(&team_id, &idempotency_key, outcome);
            reply.send(outcome);
        }
    }
}

pub(super) fn start_team_delete_operation(
    host: &mut Host,
    team_id: organization::TeamId,
    idempotency_key: String,
    observed_at: u64,
    reply: TeamDeleteReply,
    operations: &mut Vec<TeamRunOperation>,
) {
    for run_id in host.active_team_run_ids_for_team(&team_id) {
        match host.begin_team_run_cancellation(&run_id, &idempotency_key, observed_at) {
            Ok(organization::BeginCancellationOutcome::Started(plan)) => {
                let bindings = plan.bindings().to_vec();
                let delete_run_id = run_id.clone();
                let operation = host.team_delete_role_sessions(delete_run_id, bindings, true);
                let operation = OperationHandle::spawn(move |_| async move {
                    let outcome = operation.await;
                    TeamRunCompletion::TeamRunDeleted {
                        team_id,
                        idempotency_key,
                        observed_at,
                        run_id,
                        outcome,
                        reply,
                    }
                })
                .0;
                operations.push(TeamRunOperation { operation });
                return;
            }
            Ok(organization::BeginCancellationOutcome::AlreadyCancelled)
            | Ok(organization::BeginCancellationOutcome::Tombstoned) => {}
            Ok(organization::BeginCancellationOutcome::Replayed(_))
            | Ok(organization::BeginCancellationOutcome::OutcomeUnknown) => {
                reply.send(Ok(crate::composition::TeamDeleteOutcome::OutcomeUnknown));
                return;
            }
            Err(error) => {
                reply.send(Err(error));
                return;
            }
        }
    }
    let Some(removal) = host.team_materialization_removal(&team_id) else {
        reply.send(host.complete_team_delete_removal(&team_id, &idempotency_key, None));
        return;
    };
    let operation = host.team_remove(removal);
    let operation = OperationHandle::spawn(move |_| async move {
        let outcome = operation.await;
        TeamRunCompletion::TeamRemoved {
            team_id,
            idempotency_key,
            outcome: Some(outcome),
            reply,
        }
    })
    .0;
    operations.push(TeamRunOperation { operation });
}

pub(super) async fn start_team_run_operation(
    host: &mut Host,
    command: TeamRunCommand,
    terminal_watches: &mut TerminalWatches,
    operations: &mut Vec<TeamRunOperation>,
) -> Option<TeamRunCommand> {
    match command {
        TeamRunCommand::StartTerminalWatch { delivery_id } => {
            terminal_watches.start(host, delivery_id);
            None
        }
        TeamRunCommand::MaterializeManualAndCreate { input, reply } => {
            if operations.len() >= TEAM_RUNTIME_OPERATION_CAPACITY {
                let _ = reply.send(crate::composition::ManualTeamCreateOutcome::Unavailable);
                return None;
            }
            let (team_id, request, run, run_idempotency_key) =
                match host.begin_manual_team_materialization(*input) {
                    Ok(start) => start,
                    Err(outcome) => {
                        let _ = reply.send(outcome);
                        return None;
                    }
                };
            let operation = host.team_materialize(request);
            let operation = OperationHandle::spawn(move |_| async move {
                let outcome = operation.await;
                TeamRunCompletion::ManualMaterialized {
                    team_id,
                    run,
                    run_idempotency_key,
                    outcome,
                    reply,
                }
            })
            .0;
            operations.push(TeamRunOperation { operation });
            None
        }
        TeamRunCommand::AbortAndSettleCancellation {
            plan,
            idempotency_key,
            observed_at,
            reply,
        } => {
            if operations.len() >= TEAM_RUNTIME_OPERATION_CAPACITY {
                let _ = reply.send(Ok(organization::BeginCancellationOutcome::OutcomeUnknown));
                return None;
            }
            let run_id = plan.run().clone();
            let bindings = plan.bindings().to_vec();
            let operation = host.team_abort_role_sessions(bindings);
            let operation = OperationHandle::spawn(move |_| async move {
                let outcome = operation.await;
                TeamRunCompletion::CancellationAborted {
                    run_id,
                    idempotency_key,
                    observed_at,
                    outcome,
                    reply,
                }
            })
            .0;
            operations.push(TeamRunOperation { operation });
            None
        }
        TeamRunCommand::DeleteTeamAndRemove {
            team_id,
            idempotency_key,
            observed_at,
            reply,
        } => {
            if operations.len() >= TEAM_RUNTIME_OPERATION_CAPACITY {
                let _ = reply.send(Ok(crate::composition::TeamDeleteOutcome::OutcomeUnknown));
                return None;
            }
            start_team_delete_operation(
                host,
                team_id,
                idempotency_key,
                observed_at,
                TeamDeleteReply::TeamRun(reply),
                operations,
            );
            None
        }
        TeamRunCommand::DeleteRunAndPurge {
            run_id,
            idempotency_key,
            observed_at,
            reply,
        } => {
            if operations.len() >= TEAM_RUNTIME_OPERATION_CAPACITY {
                let _ = reply.send(Ok(organization::GraphRunPurgeOutcome::OutcomeUnknown(
                    organization::GraphRunPurgeUnknown::NativeDeletionOutcomeUnknown,
                )));
                return None;
            }
            let (bindings, abort_first) =
                match host.begin_team_run_cancellation(&run_id, &idempotency_key, observed_at) {
                    Ok(organization::BeginCancellationOutcome::Started(plan)) => {
                        (plan.bindings().to_vec(), true)
                    }
                    Ok(organization::BeginCancellationOutcome::Replayed(_))
                    | Ok(organization::BeginCancellationOutcome::OutcomeUnknown) => {
                        let _ = reply.send(host.complete_team_run_delete_native_evidence(
                            run_id,
                            &idempotency_key,
                            NativeDeletionEvidence::OutcomeUnknown,
                            observed_at,
                        ));
                        return None;
                    }
                    Ok(organization::BeginCancellationOutcome::AlreadyCancelled)
                    | Ok(organization::BeginCancellationOutcome::Tombstoned) => {
                        (host.team_run_bindings(&run_id), false)
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return None;
                    }
                };
            let delete_run_id = run_id.clone();
            let operation = host.team_delete_role_sessions(delete_run_id, bindings, abort_first);
            let operation = OperationHandle::spawn(move |_| async move {
                let outcome = operation.await;
                TeamRunCompletion::RunDeleted {
                    run_id,
                    idempotency_key,
                    observed_at,
                    outcome,
                    reply,
                }
            })
            .0;
            operations.push(TeamRunOperation { operation });
            None
        }
        TeamRunCommand::CreateForTeam {
            team_id,
            run_id,
            idempotency_key,
            workflow_plan,
            source_identity,
            template_revision,
            created_at,
            reply,
        } => {
            let _ = reply.send(
                host.create_team_run_for_team(
                    team_id,
                    run_id,
                    idempotency_key,
                    *workflow_plan,
                    source_identity,
                    template_revision,
                    created_at,
                )
                .await,
            );
            None
        }
        TeamRunCommand::List { team_id, reply } => {
            let _ = reply.send(host.list_team_runs(&team_id));
            None
        }
        TeamRunCommand::RoleSessions { team_id, reply } => {
            let _ = reply.send(host.query_team_role_sessions(&team_id));
            None
        }
        TeamRunCommand::Resume { team_id, reply } => {
            let _ = reply.send(host.resume_team_runs(&team_id));
            None
        }
        TeamRunCommand::BeginCancellation {
            run_id,
            idempotency_key,
            requested_at,
            reply,
        } => {
            if operations.len() >= TEAM_RUNTIME_OPERATION_CAPACITY {
                let _ = reply.send(Ok(organization::BeginCancellationOutcome::OutcomeUnknown));
                return None;
            }
            let plan =
                match host.begin_team_run_cancellation(&run_id, &idempotency_key, requested_at) {
                    Ok(organization::BeginCancellationOutcome::Started(plan))
                    | Ok(organization::BeginCancellationOutcome::Replayed(plan)) => plan,
                    outcome => {
                        let _ = reply.send(outcome);
                        return None;
                    }
                };
            let bindings = plan.bindings().to_vec();
            let operation = host.team_abort_role_sessions(bindings);
            let operation = OperationHandle::spawn(move |_| async move {
                let outcome = operation.await;
                TeamRunCompletion::CancellationAborted {
                    run_id,
                    idempotency_key,
                    observed_at: requested_at,
                    outcome,
                    reply,
                }
            })
            .0;
            operations.push(TeamRunOperation { operation });
            None
        }
        TeamRunCommand::Tombstone {
            run_id,
            idempotency_key,
            tombstoned_at,
            reply,
        } => {
            let _ = reply.send(host.tombstone_team_run(&run_id, &idempotency_key, tombstoned_at));
            None
        }
        TeamRunCommand::PublicProjection {
            team_id,
            run_id,
            reply,
        } => {
            let _ = reply.send(host.query_team_public_projection(&team_id, &run_id));
            None
        }
        TeamRunCommand::TaskBoardRead {
            team_id,
            run_id,
            reply,
        } => {
            let _ = reply.send(host.task_board_read(&team_id, &run_id));
            None
        }
        TeamRunCommand::TaskBoardMutate {
            team_id,
            run_id,
            operation,
            reply,
        } => {
            let _ = reply.send(host.task_board_mutate(team_id, run_id, operation));
            None
        }
        TeamRunCommand::PendingApprovals {
            team_id,
            run_id,
            reply,
        } => {
            let _ = reply.send(host.query_team_pending_approvals(&team_id, &run_id));
            None
        }
        TeamRunCommand::ResolveHumanDecision { command, reply } => {
            let _ = reply.send(host.resolve_team_human_decision(command));
            None
        }
        TeamRunCommand::GraphDefinition {
            team_id,
            run_id,
            reply,
        } => {
            let _ = reply.send(host.team_run_graph_definition(&team_id, &run_id));
            None
        }
        TeamRunCommand::ArmedTriggers { team_id, reply } => {
            let _ = reply.send(host.armed_team_triggers(team_id.as_ref()));
            None
        }
        TeamRunCommand::ReplaceGraph {
            command,
            definition,
            reply,
        } => {
            let _ = reply.send(host.replace_team_run_graph(*command, definition));
            None
        }
        TeamRunCommand::FireTrigger {
            request,
            fired_at,
            reply,
        } => {
            let _ = reply.send(host.fire_team_run_trigger(request, fired_at));
            None
        }
        TeamRunCommand::AdmitRoleChat { admission, reply } => {
            let _ = reply.send(host.admit_team_run_role_chat(admission));
            None
        }
        TeamRunCommand::ObserveTerminalWatch {
            delivery_id,
            terminal_status,
            observed_at,
        } => {
            let _ =
                host.observe_team_run_matcha_terminal(delivery_id, terminal_status, observed_at);
            None
        }
        TeamRunCommand::ResolveAuthorizedGraphOutcome { resolution, reply } => {
            let _ = reply.send(host.resolve_team_run_authorized_graph_outcome(resolution));
            None
        }
    }
}
