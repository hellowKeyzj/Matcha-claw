use std::time::{SystemTime, UNIX_EPOCH};

use foundation::execution::OperationHandle;
use organization::{
    self, CreateGraphRunOutcome, GraphRunId, NativeDeletionEvidence, RoleAbortOutcome,
};
use tokio::sync::oneshot;

use crate::{
    Host,
    composition::{RuntimeReceiptOutcome, TeamMaterializationCommandOutcome},
    runtime_driver::OwnedRuntimeFuture,
};

use super::command::{
    Command, TeamNodeEventCommandOutcome, TeamRuntimeCommand, TeamRuntimeCommandOutcome,
    TeamRuntimeCreateSource, TeamRuntimeStatus, TeamSkillCommand,
};
use super::team_run_operations::{TeamDeleteReply, TeamRunOperation, start_team_delete_operation};

pub(super) const TEAM_RUNTIME_OPERATION_CAPACITY: usize = 8;

pub(super) struct TeamRuntimeOperation {
    pub(super) operation: OperationHandle<TeamRuntimeCompletion>,
}

pub(super) enum TeamRuntimeCompletion {
    TeamSkillDependencyPlan {
        selection_id: organization::package::TeamSkillSelectionId,
        catalog: Option<openclaw::skill::InstalledSkillCatalog>,
        reply: oneshot::Sender<organization::package::TeamSkillDependencyPlanResult>,
    },
    TeamSkillMaterialize {
        team_id: organization::TeamId,
        outcome: organization::MaterializationOperationOutcome,
        reply: oneshot::Sender<crate::composition::TeamMaterializationCommandOutcome>,
    },
    TeamRuntimeDependencyPlan {
        selection_id: organization::package::TeamSkillSelectionId,
        catalog: Option<openclaw::skill::InstalledSkillCatalog>,
        reply: oneshot::Sender<TeamRuntimeCommandOutcome>,
    },
    TeamRuntimeProvisionAgents {
        team_id: organization::TeamId,
        outcome: organization::MaterializationOperationOutcome,
        reply: oneshot::Sender<TeamRuntimeCommandOutcome>,
    },
    TeamRuntimeRunCreateMaterialize {
        team_id: organization::TeamId,
        run_id: GraphRunId,
        idempotency_key: organization::IdempotencyKey,
        created_at: u64,
        outcome: organization::MaterializationOperationOutcome,
        reply: oneshot::Sender<TeamRuntimeCommandOutcome>,
    },
    TeamRuntimeRunCreate {
        created: CreateGraphRunOutcome,
        receipt: organization::RunRuntimeReceipt,
        outcome: crate::composition::RuntimeReceiptOutcome,
        reply: oneshot::Sender<TeamRuntimeCommandOutcome>,
    },
    TeamRuntimeCancel {
        run_id: GraphRunId,
        idempotency_key: organization::IdempotencyKey,
        observed_at: u64,
        outcome: RoleAbortOutcome,
        reply: oneshot::Sender<TeamRuntimeCommandOutcome>,
    },
    TeamRuntimeDelete {
        run_id: GraphRunId,
        idempotency_key: organization::IdempotencyKey,
        observed_at: u64,
        outcome: NativeDeletionEvidence,
        reply: oneshot::Sender<TeamRuntimeCommandOutcome>,
    },
}

pub(super) async fn wait_for_team_runtime_operation(operations: &mut [TeamRuntimeOperation]) {
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

pub(super) async fn poll_team_runtime_operations(
    host: &mut Host,
    operations: &mut Vec<TeamRuntimeOperation>,
) {
    let mut pending = Vec::with_capacity(operations.len());
    for mut operation in operations.drain(..) {
        if operation.operation.is_finished() {
            let Ok(completion) = operation.operation.join().await else {
                continue;
            };
            complete_team_runtime_operation(host, completion, &mut pending);
        } else {
            pending.push(operation);
        }
    }
    *operations = pending;
}

pub(super) async fn cancel_team_runtime_operations(operations: &mut Vec<TeamRuntimeOperation>) {
    for operation in operations.drain(..) {
        operation.operation.cancel();
    }
}

fn complete_team_runtime_operation(
    host: &mut Host,
    completion: TeamRuntimeCompletion,
    operations: &mut Vec<TeamRuntimeOperation>,
) {
    match completion {
        TeamRuntimeCompletion::TeamSkillDependencyPlan {
            selection_id,
            catalog,
            reply,
        } => {
            let outcome = catalog.map_or(
                organization::package::TeamSkillDependencyPlanResult::Unavailable,
                |catalog| host.plan_team_skill_dependencies_from_catalog(selection_id, catalog),
            );
            let _ = reply.send(outcome);
        }
        TeamRuntimeCompletion::TeamSkillMaterialize {
            team_id,
            outcome,
            reply,
        } => {
            let _ = reply.send(host.settle_team_materialization_outcome(&team_id, outcome));
        }
        TeamRuntimeCompletion::TeamRuntimeDependencyPlan {
            selection_id,
            catalog,
            reply,
        } => {
            let outcome = catalog.map_or(
                organization::package::TeamSkillDependencyPlanResult::Unavailable,
                |catalog| host.plan_team_skill_dependencies_from_catalog(selection_id, catalog),
            );
            let _ = reply.send(TeamRuntimeCommandOutcome::DependencyPlan(outcome));
        }
        TeamRuntimeCompletion::TeamRuntimeProvisionAgents {
            team_id,
            outcome,
            reply,
        } => {
            let outcome = host.settle_team_materialization_outcome(&team_id, outcome);
            let _ = reply.send(TeamRuntimeCommandOutcome::ProvisionAgents(outcome));
        }
        TeamRuntimeCompletion::TeamRuntimeRunCreateMaterialize {
            team_id,
            run_id,
            idempotency_key,
            created_at,
            outcome,
            reply,
        } => match host.settle_team_materialization_outcome(&team_id, outcome) {
            TeamMaterializationCommandOutcome::Materialized => {
                start_team_run_receipt_operation(
                    host,
                    team_id,
                    run_id,
                    idempotency_key.as_str(),
                    created_at,
                    reply,
                    operations,
                );
            }
            outcome => {
                let _ = reply.send(TeamRuntimeCommandOutcome::RunCreate(Err(
                    team_materialization_status(outcome),
                )));
            }
        },
        TeamRuntimeCompletion::TeamRuntimeRunCreate {
            created,
            receipt,
            outcome,
            reply,
        } => {
            let outcome = host.install_team_run_runtime_receipt(created, receipt, outcome);
            let _ = reply.send(TeamRuntimeCommandOutcome::RunCreate(outcome));
        }
        TeamRuntimeCompletion::TeamRuntimeCancel {
            run_id,
            idempotency_key,
            observed_at,
            outcome,
            reply,
        } => {
            let outcome = host.settle_team_run_cancellation_outcome(
                &run_id,
                idempotency_key.as_str(),
                outcome,
                observed_at,
            );
            let _ = reply.send(TeamRuntimeCommandOutcome::RunCancel(outcome));
        }
        TeamRuntimeCompletion::TeamRuntimeDelete {
            run_id,
            idempotency_key,
            observed_at,
            outcome,
            reply,
        } => {
            let outcome = host.complete_team_run_delete_native_evidence(
                run_id,
                idempotency_key.as_str(),
                outcome,
                observed_at,
            );
            let _ = reply.send(TeamRuntimeCommandOutcome::RunDelete(outcome));
        }
    }
}

pub(super) fn start_team_skill_operation(
    host: &mut Host,
    command: TeamSkillCommand,
    operations: &mut Vec<TeamRuntimeOperation>,
) -> Option<TeamSkillCommand> {
    match command {
        TeamSkillCommand::Materialize {
            selection_id,
            team_id,
            idempotency_key,
            reply,
        } => {
            if operations.len() >= TEAM_RUNTIME_OPERATION_CAPACITY {
                let _ = reply.send(TeamMaterializationCommandOutcome::Unavailable);
                return None;
            }
            let (team_id, request) =
                match host.begin_team_skill_materialization(selection_id, team_id, idempotency_key)
                {
                    Ok(start) => start,
                    Err(outcome) => {
                        let _ = reply.send(outcome);
                        return None;
                    }
                };
            let operation = team_ops_materialize_team(host, request);
            let operation = OperationHandle::spawn(move |_| async move {
                let outcome = operation.await;
                TeamRuntimeCompletion::TeamSkillMaterialize {
                    team_id,
                    outcome,
                    reply,
                }
            })
            .0;
            operations.push(TeamRuntimeOperation { operation });
            None
        }
        TeamSkillCommand::DependencyPlan {
            selection_id,
            reply,
        } => {
            if operations.len() >= TEAM_RUNTIME_OPERATION_CAPACITY {
                let _ =
                    reply.send(organization::package::TeamSkillDependencyPlanResult::Unavailable);
                return None;
            }
            let catalog = host.open_claw_installed_skill_catalog();
            let operation = OperationHandle::spawn(move |_| async move {
                TeamRuntimeCompletion::TeamSkillDependencyPlan {
                    selection_id,
                    catalog: catalog.await,
                    reply,
                }
            })
            .0;
            operations.push(TeamRuntimeOperation { operation });
            None
        }
        command => Some(command),
    }
}

fn team_ops_materialize_team(
    host: &Host,
    request: organization::TeamMaterializationRequest,
) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
    host.team_materialize(request)
}

fn team_ops_confirm_team_run_receipt(
    host: &Host,
    receipt: organization::RunRuntimeReceipt,
) -> OwnedRuntimeFuture<RuntimeReceiptOutcome> {
    host.team_confirm_receipt(receipt)
}

fn start_team_run_receipt_operation(
    host: &mut Host,
    team_id: organization::TeamId,
    run_id: GraphRunId,
    idempotency_key: &str,
    created_at: u64,
    reply: oneshot::Sender<TeamRuntimeCommandOutcome>,
    operations: &mut Vec<TeamRuntimeOperation>,
) {
    let (created, receipt) = match host.prepare_team_run_from_existing_team_receipt(
        &team_id,
        run_id,
        idempotency_key,
        created_at,
    ) {
        Ok(prepared) => prepared,
        Err(status) => {
            let _ = reply.send(TeamRuntimeCommandOutcome::RunCreate(Err(status)));
            return;
        }
    };
    let operation = team_ops_confirm_team_run_receipt(host, receipt.clone());
    let operation = OperationHandle::spawn(move |_| async move {
        let outcome = operation.await;
        TeamRuntimeCompletion::TeamRuntimeRunCreate {
            created,
            receipt,
            outcome,
            reply,
        }
    })
    .0;
    operations.push(TeamRuntimeOperation { operation });
}

const fn team_materialization_status(
    outcome: TeamMaterializationCommandOutcome,
) -> TeamRuntimeStatus {
    match outcome {
        TeamMaterializationCommandOutcome::Materialized => TeamRuntimeStatus::OutcomeUnknown,
        TeamMaterializationCommandOutcome::Rejected => TeamRuntimeStatus::Rejected,
        TeamMaterializationCommandOutcome::OutcomeUnknown => TeamRuntimeStatus::OutcomeUnknown,
        TeamMaterializationCommandOutcome::Unavailable => TeamRuntimeStatus::Unavailable,
    }
}

pub(super) fn start_team_runtime_operation(
    host: &mut Host,
    command: Command,
    operations: &mut Vec<TeamRuntimeOperation>,
    team_run_operations: &mut Vec<TeamRunOperation>,
) -> Option<Command> {
    let Command::TeamRuntime { request, reply } = command else {
        return Some(command);
    };
    match request {
        TeamRuntimeCommand::DependencyPlan { package_root } => {
            if operations.len() >= TEAM_RUNTIME_OPERATION_CAPACITY {
                let _ = reply.send(TeamRuntimeCommandOutcome::DependencyPlan(
                    organization::package::TeamSkillDependencyPlanResult::Unavailable,
                ));
                return None;
            }
            let selection_id = match host.authorize_team_skill_selection(package_root) {
                Ok(selection_id) => selection_id,
                Err(organization::package::TeamSkillSelectionError::InvalidSelection) => {
                    let _ = reply.send(TeamRuntimeCommandOutcome::DependencyPlan(
                        organization::package::TeamSkillDependencyPlanResult::Invalid,
                    ));
                    return None;
                }
                Err(organization::package::TeamSkillSelectionError::Unavailable) => {
                    let _ = reply.send(TeamRuntimeCommandOutcome::DependencyPlan(
                        organization::package::TeamSkillDependencyPlanResult::Unavailable,
                    ));
                    return None;
                }
            };
            let catalog = host.open_claw_installed_skill_catalog();
            let operation = OperationHandle::spawn(move |_| async move {
                TeamRuntimeCompletion::TeamRuntimeDependencyPlan {
                    selection_id,
                    catalog: catalog.await,
                    reply,
                }
            })
            .0;
            operations.push(TeamRuntimeOperation { operation });
            None
        }
        TeamRuntimeCommand::ProvisionAgents {
            package_root,
            team_id: Some(team_id),
            idempotency_key,
            source: TeamRuntimeCreateSource::TeamSkill,
        } => {
            if operations.len() >= TEAM_RUNTIME_OPERATION_CAPACITY {
                let _ = reply.send(TeamRuntimeCommandOutcome::ProvisionAgents(
                    TeamMaterializationCommandOutcome::Unavailable,
                ));
                return None;
            }
            let selection_id = match host.authorize_team_skill_selection(package_root) {
                Ok(selection_id) => selection_id,
                Err(organization::package::TeamSkillSelectionError::InvalidSelection) => {
                    let _ = reply.send(TeamRuntimeCommandOutcome::ProvisionAgents(
                        TeamMaterializationCommandOutcome::Rejected,
                    ));
                    return None;
                }
                Err(organization::package::TeamSkillSelectionError::Unavailable) => {
                    let _ = reply.send(TeamRuntimeCommandOutcome::ProvisionAgents(
                        TeamMaterializationCommandOutcome::Unavailable,
                    ));
                    return None;
                }
            };
            let (team_id, request) =
                match host.begin_team_skill_materialization(selection_id, team_id, idempotency_key)
                {
                    Ok(start) => start,
                    Err(outcome) => {
                        let _ = reply.send(TeamRuntimeCommandOutcome::ProvisionAgents(outcome));
                        return None;
                    }
                };
            let operation = team_ops_materialize_team(host, request);
            let operation = OperationHandle::spawn(move |_| async move {
                let outcome = operation.await;
                TeamRuntimeCompletion::TeamRuntimeProvisionAgents {
                    team_id,
                    outcome,
                    reply,
                }
            })
            .0;
            operations.push(TeamRuntimeOperation { operation });
            None
        }
        TeamRuntimeCommand::ProvisionAgents { .. } => {
            let _ = reply.send(TeamRuntimeCommandOutcome::ProvisionAgents(
                TeamMaterializationCommandOutcome::Rejected,
            ));
            None
        }
        TeamRuntimeCommand::Delete {
            team_id,
            idempotency_key,
            observed_at,
        } => {
            if operations.len() >= TEAM_RUNTIME_OPERATION_CAPACITY {
                let _ = reply.send(TeamRuntimeCommandOutcome::Delete(Ok(
                    crate::composition::TeamDeleteOutcome::OutcomeUnknown,
                )));
                return None;
            }
            start_team_delete_operation(
                host,
                team_id,
                idempotency_key.as_str().to_owned(),
                observed_at,
                TeamDeleteReply::TeamRuntime(reply),
                team_run_operations,
            );
            None
        }
        TeamRuntimeCommand::RunCreate {
            team_id,
            package_root,
            run_id,
            idempotency_key,
            source,
        } => {
            if operations.len() >= TEAM_RUNTIME_OPERATION_CAPACITY {
                let _ = reply.send(TeamRuntimeCommandOutcome::RunCreate(Err(
                    TeamRuntimeStatus::Unavailable,
                )));
                return None;
            }
            let run_id = run_id.unwrap_or_else(|| {
                GraphRunId::new(format!("team-run:{}", idempotency_key.as_str()))
            });
            let created_at = now_millis();
            match source {
                TeamRuntimeCreateSource::TeamSkill => {
                    let selection_id = match host.authorize_team_skill_selection(package_root) {
                        Ok(selection_id) => selection_id,
                        Err(organization::package::TeamSkillSelectionError::InvalidSelection) => {
                            let _ = reply.send(TeamRuntimeCommandOutcome::RunCreate(Err(
                                TeamRuntimeStatus::Rejected,
                            )));
                            return None;
                        }
                        Err(organization::package::TeamSkillSelectionError::Unavailable) => {
                            let _ = reply.send(TeamRuntimeCommandOutcome::RunCreate(Err(
                                TeamRuntimeStatus::Unavailable,
                            )));
                            return None;
                        }
                    };
                    let team_id = match team_id {
                        Some(team_id) => team_id,
                        None => match host.validate_team_skill_selection(selection_id.clone()) {
                            organization::package::TeamSkillPackageValidation::Valid {
                                package,
                            } => match organization::TeamId::try_new(package.name().to_owned()) {
                                Ok(team_id) => team_id,
                                Err(_) => {
                                    let _ = reply.send(TeamRuntimeCommandOutcome::RunCreate(Err(
                                        TeamRuntimeStatus::Rejected,
                                    )));
                                    return None;
                                }
                            },
                            organization::package::TeamSkillPackageValidation::Invalid => {
                                let _ = reply.send(TeamRuntimeCommandOutcome::RunCreate(Err(
                                    TeamRuntimeStatus::Rejected,
                                )));
                                return None;
                            }
                            organization::package::TeamSkillPackageValidation::Unavailable => {
                                let _ = reply.send(TeamRuntimeCommandOutcome::RunCreate(Err(
                                    TeamRuntimeStatus::Unavailable,
                                )));
                                return None;
                            }
                        },
                    };
                    let (team_id, request) = match host.begin_team_skill_materialization(
                        selection_id,
                        team_id,
                        idempotency_key.clone(),
                    ) {
                        Ok(start) => start,
                        Err(outcome) => {
                            let _ = reply.send(TeamRuntimeCommandOutcome::RunCreate(Err(
                                team_materialization_status(outcome),
                            )));
                            return None;
                        }
                    };
                    let operation = team_ops_materialize_team(host, request);
                    let operation = OperationHandle::spawn(move |_| async move {
                        let outcome = operation.await;
                        TeamRuntimeCompletion::TeamRuntimeRunCreateMaterialize {
                            team_id,
                            run_id,
                            idempotency_key,
                            created_at,
                            outcome,
                            reply,
                        }
                    })
                    .0;
                    operations.push(TeamRuntimeOperation { operation });
                    None
                }
                TeamRuntimeCreateSource::Manual => {
                    let Some(team_id) = team_id else {
                        let _ = reply.send(TeamRuntimeCommandOutcome::RunCreate(Err(
                            TeamRuntimeStatus::Rejected,
                        )));
                        return None;
                    };
                    start_team_run_receipt_operation(
                        host,
                        team_id,
                        run_id,
                        idempotency_key.as_str(),
                        created_at,
                        reply,
                        operations,
                    );
                    None
                }
            }
        }
        TeamRuntimeCommand::RunCancel {
            run_id,
            idempotency_key,
            requested_at,
        } => {
            if operations.len() >= TEAM_RUNTIME_OPERATION_CAPACITY {
                let _ = reply.send(TeamRuntimeCommandOutcome::RunCancel(Ok(
                    organization::BeginCancellationOutcome::OutcomeUnknown,
                )));
                return None;
            }
            let plan = match host.begin_team_run_cancellation(
                &run_id,
                idempotency_key.as_str(),
                requested_at,
            ) {
                Ok(organization::BeginCancellationOutcome::Started(plan))
                | Ok(organization::BeginCancellationOutcome::Replayed(plan)) => plan,
                outcome => {
                    let _ = reply.send(TeamRuntimeCommandOutcome::RunCancel(outcome));
                    return None;
                }
            };
            let bindings = plan.bindings().to_vec();
            let operation = host.team_abort_role_sessions(bindings);
            let operation = OperationHandle::spawn(move |_| async move {
                let outcome = operation.await;
                TeamRuntimeCompletion::TeamRuntimeCancel {
                    run_id,
                    idempotency_key,
                    observed_at: requested_at,
                    outcome,
                    reply,
                }
            })
            .0;
            operations.push(TeamRuntimeOperation { operation });
            None
        }
        TeamRuntimeCommand::RunDelete {
            run_id,
            idempotency_key,
            tombstoned_at,
        } => {
            if operations.len() >= TEAM_RUNTIME_OPERATION_CAPACITY {
                let _ = reply.send(TeamRuntimeCommandOutcome::RunDelete(Ok(
                    organization::GraphRunPurgeOutcome::OutcomeUnknown(
                        organization::GraphRunPurgeUnknown::NativeDeletionOutcomeUnknown,
                    ),
                )));
                return None;
            }
            let (bindings, abort_first) = match host.begin_team_run_cancellation(
                &run_id,
                idempotency_key.as_str(),
                tombstoned_at,
            ) {
                Ok(organization::BeginCancellationOutcome::Started(plan)) => {
                    (plan.bindings().to_vec(), true)
                }
                Ok(organization::BeginCancellationOutcome::Replayed(_))
                | Ok(organization::BeginCancellationOutcome::OutcomeUnknown) => {
                    let _ = reply.send(TeamRuntimeCommandOutcome::RunDelete(
                        host.complete_team_run_delete_native_evidence(
                            run_id,
                            idempotency_key.as_str(),
                            NativeDeletionEvidence::OutcomeUnknown,
                            tombstoned_at,
                        ),
                    ));
                    return None;
                }
                Ok(organization::BeginCancellationOutcome::AlreadyCancelled)
                | Ok(organization::BeginCancellationOutcome::Tombstoned) => {
                    (host.team_run_bindings(&run_id), false)
                }
                Err(error) => {
                    let _ = reply.send(TeamRuntimeCommandOutcome::RunDelete(Err(error)));
                    return None;
                }
            };
            let delete_run_id = run_id.clone();
            let operation = host.team_delete_role_sessions(delete_run_id, bindings, abort_first);
            let operation = OperationHandle::spawn(move |_| async move {
                let outcome = operation.await;
                TeamRuntimeCompletion::TeamRuntimeDelete {
                    run_id,
                    idempotency_key,
                    observed_at: tombstoned_at,
                    outcome,
                    reply,
                }
            })
            .0;
            operations.push(TeamRuntimeOperation { operation });
            None
        }
        TeamRuntimeCommand::PackageValidate { package_root } => {
            let outcome = host
                .authorize_team_skill_selection(package_root)
                .map(|selection_id| host.validate_team_skill_selection(selection_id))
                .unwrap_or(organization::package::TeamSkillPackageValidation::Unavailable);
            let _ = reply.send(TeamRuntimeCommandOutcome::PackageValidate(outcome));
            None
        }
        TeamRuntimeCommand::RunList { team_id } => {
            let _ = reply.send(TeamRuntimeCommandOutcome::RunList(
                host.list_team_runs(&team_id),
            ));
            None
        }
        TeamRuntimeCommand::TriggerList { team_id } => {
            let _ = reply.send(TeamRuntimeCommandOutcome::TriggerList(
                host.armed_team_triggers(team_id.as_ref()),
            ));
            None
        }
        TeamRuntimeCommand::WebhookTriggerFire {
            webhook_path,
            idempotency_key,
            fired_at,
        } => {
            let outcome = match host.resolve_team_webhook_trigger(&webhook_path, idempotency_key) {
                crate::composition::TeamTriggerFireResolution::Request(request) => host
                    .fire_team_webhook_trigger(request, fired_at)
                    .map_err(|_| TeamRuntimeStatus::Unavailable),
                crate::composition::TeamTriggerFireResolution::NotFound => {
                    Ok(organization::TeamTriggerFireOutcome::NotFound)
                }
                crate::composition::TeamTriggerFireResolution::Rejected => {
                    Ok(organization::TeamTriggerFireOutcome::Rejected)
                }
            };
            let _ = reply.send(TeamRuntimeCommandOutcome::WebhookTriggerFire(outcome));
            None
        }
        TeamRuntimeCommand::RunSnapshot {
            team_id,
            run_id,
            event_cursor,
            event_limit,
        } => {
            let outcome = match team_id {
                Some(team_id) => host.query_team_run_public_snapshot(
                    &match organization::run::public_projection::TeamRunPublicSnapshotRequest::try_new(
                        team_id,
                        run_id,
                        event_cursor.unwrap_or_default(),
                        event_limit,
                    ) {
                        Ok(request) => request,
                        Err(_) => {
                            let _ = reply.send(TeamRuntimeCommandOutcome::RunSnapshotInvalidInput);
                            return None;
                        }
                    },
                ),
                None => match host.query_team_run_public_snapshot_for_run(
                    &run_id,
                    event_cursor.unwrap_or_default(),
                    event_limit,
                ) {
                    Ok(outcome) => outcome,
                    Err(_) => {
                        let _ = reply.send(TeamRuntimeCommandOutcome::RunSnapshotInvalidInput);
                        return None;
                    }
                },
            };
            let _ = reply.send(TeamRuntimeCommandOutcome::RunSnapshot(outcome));
            None
        }
        TeamRuntimeCommand::GraphSave {
            command,
            definition,
        } => {
            let _ = reply.send(TeamRuntimeCommandOutcome::GraphSave(
                host.replace_team_run_graph(*command, definition),
            ));
            None
        }
        TeamRuntimeCommand::GraphPatch { command, patch } => {
            let _ = reply.send(TeamRuntimeCommandOutcome::GraphPatch(
                host.apply_team_graph_patch(*command, patch),
            ));
            None
        }
        TeamRuntimeCommand::GraphContext {
            team_id,
            run_id,
            view,
            node_execution_id,
        } => {
            let outcome = team_id
                .and_then(|team_id| {
                    organization::TeamGraphContextQuery::new(
                        team_id,
                        run_id,
                        view,
                        node_execution_id,
                    )
                    .ok()
                })
                .map_or(organization::TeamGraphContextResult::Unavailable, |query| {
                    host.query_team_graph_context(&query)
                });
            let _ = reply.send(TeamRuntimeCommandOutcome::GraphContext(outcome));
            None
        }
        TeamRuntimeCommand::GraphExportYaml { run_id } => {
            let outcome = host
                .team_run_graph_yaml(&run_id)
                .ok_or(TeamRuntimeStatus::Unavailable);
            let _ = reply.send(TeamRuntimeCommandOutcome::GraphExportYaml(outcome));
            None
        }
        TeamRuntimeCommand::GraphImportYaml {
            command,
            definition,
        } => {
            let _ = reply.send(TeamRuntimeCommandOutcome::GraphImportYaml(
                host.replace_team_run_graph(*command, definition),
            ));
            None
        }
        TeamRuntimeCommand::TriggerFire { request, fired_at } => {
            let _ = reply.send(TeamRuntimeCommandOutcome::TriggerFire(
                host.fire_team_run_trigger(request, fired_at),
            ));
            None
        }
        TeamRuntimeCommand::RoleMessageSubmit { admission } => {
            let _ = reply.send(TeamRuntimeCommandOutcome::RoleMessageSubmit(
                host.admit_team_run_role_chat(admission),
            ));
            None
        }
        TeamRuntimeCommand::RoleMessageSubmitForRun {
            run_id,
            role_id,
            message,
            idempotency_key,
            requested_at,
        } => {
            let _ = reply.send(TeamRuntimeCommandOutcome::RoleMessageSubmitForRun(
                host.admit_team_run_role_chat_for_run(
                    run_id,
                    role_id,
                    message,
                    idempotency_key,
                    requested_at,
                ),
            ));
            None
        }
        TeamRuntimeCommand::NodePromptRetryDue { run_id } => {
            let query =
                organization::run::scheduler::NodePromptRetryDueQuery::new(run_id, now_millis());
            let outcome = query.map_or(
                organization::run::scheduler::NodePromptRetryDueQueryOutcome::Invalid(
                    organization::run::scheduler::NodePromptRetryDueInvalidReason::InvalidFacts,
                ),
                |query| host.query_team_run_retry_due(&query),
            );
            let _ = reply.send(TeamRuntimeCommandOutcome::NodePromptRetryDue(outcome));
            None
        }
        TeamRuntimeCommand::NodePromptSettled {
            session_key,
            prompt_run_id,
            phase,
        } => {
            let native = match phase {
                super::command::TeamRuntimePromptPhase::Final => {
                    organization::NativeTerminalStatus::Completed
                }
                super::command::TeamRuntimePromptPhase::Error => {
                    organization::NativeTerminalStatus::Failed
                }
                super::command::TeamRuntimePromptPhase::Aborted => {
                    organization::NativeTerminalStatus::Cancelled
                }
            };
            let outcome = host
                .settle_team_node_prompt(
                    session_key.as_str(),
                    prompt_run_id.as_str(),
                    native,
                    now_millis(),
                )
                .map_err(|_| TeamRuntimeStatus::Unavailable);
            let _ = reply.send(TeamRuntimeCommandOutcome::NodePromptSettled(outcome));
            None
        }
        TeamRuntimeCommand::NodeEvent {
            run_id,
            node_execution_id,
            event,
            summary,
            role_id,
            requested_action,
            idempotency_key,
            terminal_resolution,
            output_port,
        } => {
            let outcome = if matches!(event.as_str(), "complete" | "reject") {
                let terminal = terminal_resolution
                    .as_ref()
                    .ok_or(TeamRuntimeStatus::Rejected);
                terminal.and_then(|terminal| {
                    host.resolve_team_node_terminal(
                        &run_id,
                        &node_execution_id,
                        event.as_str(),
                        Some(terminal),
                        &summary,
                        output_port.as_deref(),
                        idempotency_key.as_str(),
                        now_millis(),
                    )
                    .map(TeamNodeEventCommandOutcome::Terminal)
                    .map_err(|_| TeamRuntimeStatus::Unavailable)
                })
            } else {
                let event = match event.as_str() {
                    "progress" => organization::TeamNodeEvent::progress(node_execution_id, role_id),
                    "request_input" => {
                        organization::TeamNodeEvent::request_input(node_execution_id, role_id)
                    }
                    "request_approval" => {
                        match requested_action.as_deref().and_then(team_approval_action) {
                            Some(action) => organization::TeamNodeEvent::request_approval(
                                node_execution_id,
                                role_id,
                                action,
                            ),
                            None => {
                                let _ = reply.send(TeamRuntimeCommandOutcome::NodeEvent(Err(
                                    TeamRuntimeStatus::Rejected,
                                )));
                                return None;
                            }
                        }
                    }
                    _ => {
                        let _ = reply.send(TeamRuntimeCommandOutcome::NodeEvent(Err(
                            TeamRuntimeStatus::Rejected,
                        )));
                        return None;
                    }
                };
                let command_id = match organization::run::event::OpaqueId::try_new(format!(
                    "team-node-event-{}",
                    idempotency_key.as_str()
                )) {
                    Ok(command_id) => command_id,
                    Err(_) => {
                        let _ = reply.send(TeamRuntimeCommandOutcome::NodeEvent(Err(
                            TeamRuntimeStatus::Rejected,
                        )));
                        return None;
                    }
                };
                organization::TeamNodeEventProducer::non_terminal(
                    organization::run::event::OpaqueId::try_new(run_id.as_str())
                        .expect("graph run id is opaque"),
                    command_id,
                    organization::run::event::OpaqueId::try_new(
                        idempotency_key.as_str().to_owned(),
                    )
                    .expect("team runtime idempotency key is opaque"),
                    event,
                    now_millis(),
                )
                .map_err(|_| TeamRuntimeStatus::Rejected)
                .and_then(|event| {
                    let (command, event) = event.into_parts();
                    host.record_team_node_event(command, event)
                        .map(TeamNodeEventCommandOutcome::NonTerminal)
                        .map_err(|_| TeamRuntimeStatus::Unavailable)
                })
            };
            let _ = reply.send(TeamRuntimeCommandOutcome::NodeEvent(outcome.map(
                |outcome| match outcome {
                    TeamNodeEventCommandOutcome::NonTerminal(outcome) => {
                        super::command::TeamNodeEventCommandOutcome::NonTerminal(outcome)
                    }
                    TeamNodeEventCommandOutcome::Terminal(outcome) => {
                        super::command::TeamNodeEventCommandOutcome::Terminal(outcome)
                    }
                },
            )));
            None
        }
        TeamRuntimeCommand::RunDiagnostics { run_id } => {
            let _ = reply.send(TeamRuntimeCommandOutcome::RunDiagnostics(
                host.query_team_run_diagnostics_for_run(&run_id),
            ));
            None
        }
        TeamRuntimeCommand::RunDecisionSubmit {
            run_id,
            decision,
            note,
            idempotency_key,
            resolved_at,
        } => {
            let command = organization::TeamDecisionCommand::try_new(
                format!("team-decision-{}", idempotency_key.as_str()),
                run_id.as_str().to_owned(),
                "run",
                decision,
                note,
                idempotency_key.as_str().to_owned(),
                resolved_at,
            );
            let outcome = command
                .map_err(|_| TeamRuntimeStatus::Rejected)
                .and_then(|command| {
                    host.submit_team_decision(command)
                        .map_err(|_| TeamRuntimeStatus::Unavailable)
                });
            let _ = reply.send(TeamRuntimeCommandOutcome::RunDecisionSubmit(outcome));
            None
        }
        TeamRuntimeCommand::Resume { team_id } => {
            let _ = reply.send(TeamRuntimeCommandOutcome::Resume(
                host.resume_team_runs(&team_id),
            ));
            None
        }
        TeamRuntimeCommand::ApprovalResolve { command } => {
            let _ = reply.send(TeamRuntimeCommandOutcome::ApprovalResolve(
                host.resolve_team_human_decision(command),
            ));
            None
        }
    }
}

fn team_approval_action(value: &str) -> Option<organization::ApprovalAction> {
    match value {
        "continue_node" => Some(organization::ApprovalAction::ContinueNode),
        "execute_tool" => Some(organization::ApprovalAction::ExecuteTool),
        "publish_result" => Some(organization::ApprovalAction::PublishResult),
        "external_action" => Some(organization::ApprovalAction::ExternalAction),
        _ => None,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
