//! Host-side Fleet lifecycle orchestration.
//!
//! Domain transitions are committed before provider I/O and completed only after a
//! provider reports a real result.  An ambiguous provider result is returned as
//! `Unknown`; it is never converted into a successful or unhealthy domain fact.

use std::time::{Duration, SystemTime};

use crate as fleet;
use fleet::{
    CustomTargetConfig, FleetTargetConfig,
    command::{CommandAttempt, CommandId},
    connection::{ConnectionId, ConnectionMutation, ProbeOutcome},
    effect::{
        EffectIdentity, EffectOperationOutcome, EffectReceipt, EffectRecord, PhaseKey, ProviderKind,
    },
    environment::{
        EnvironmentId, EnvironmentMutation, ManagedResourceId, ManagedResourceLifecycleContext,
        ManagedResourceMutation,
    },
    reachability::RuntimeAgentReachabilityAdapter,
    runtime_agent::CommandCorrelation,
};

use super::actor::{FleetOwner, FleetTargetResolution};
use crate::application::{
    connection_probe::{
        FleetConnectionProbe, FleetConnectionProbeOutcome, FleetConnectionProbeProvider,
    },
    custom_lifecycle::{
        self, CustomLifecycleOperation, CustomLifecycleRequest, CustomReceiptOutcome,
        DEFAULT_TIMEOUT,
    },
    docker::{DockerEffectClient, DockerEffectError, DockerEffectOutcome, DockerLifecycleEffect},
    kubernetes::{
        KubernetesEffectClient, KubernetesEffectError, KubernetesEffectOutcome,
        KubernetesLifecycleEffect,
    },
    provider_resource::ProviderResourceReceipt,
    ssh::{SshEffect, SshEffectError, SshLifecycleEffect},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FleetLifecycleDispatch {
    outcome: FleetLifecycleOutcome,
    receipt: Option<ProviderResourceReceipt>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FleetLifecycleMutation {
    Environment(EnvironmentMutation),
    ManagedResource(ManagedResourceMutation),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FleetLifecycleOutcome {
    Completed,
    AlreadyAbsent,
    Rejected(String),
    Unknown(String),
}

impl FleetLifecycleOutcome {
    fn from_docker(result: Result<DockerEffectOutcome, DockerEffectError>) -> Self {
        match result {
            Ok(DockerEffectOutcome::Completed) => Self::Completed,
            Ok(DockerEffectOutcome::AlreadyAbsent) => Self::AlreadyAbsent,
            Err(error) if docker_unknown(&error) => Self::Unknown(error.to_string()),
            Err(error) => Self::Rejected(error.to_string()),
        }
    }

    fn from_kubernetes(result: Result<KubernetesEffectOutcome, KubernetesEffectError>) -> Self {
        match result {
            Ok(KubernetesEffectOutcome::Completed) => Self::Completed,
            Ok(KubernetesEffectOutcome::AlreadyAbsent) => Self::AlreadyAbsent,
            Err(error) if kubernetes_unknown(&error) => Self::Unknown(error.to_string()),
            Err(error) => Self::Rejected(error.to_string()),
        }
    }

    fn from_ssh(
        result: Result<Option<crate::application::ssh::SshOutput>, SshEffectError>,
    ) -> Self {
        match result {
            Ok(_) => Self::Completed,
            Err(error) if ssh_unknown(&error) => Self::Unknown(error.to_string()),
            Err(error) => Self::Rejected(error.to_string()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FleetConnectionLifecycleOutcome {
    Ready(ConnectionMutation),
    Unhealthy(ConnectionMutation),
    Unknown(String),
    Rejected(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum CustomDispatchOutcome {
    Completed,
    Rejected {
        reason: String,
        definitive_peer_failure: bool,
    },
    Unknown(String),
}

impl CustomDispatchOutcome {
    fn into_lifecycle(self) -> FleetLifecycleOutcome {
        match self {
            Self::Completed => FleetLifecycleOutcome::Completed,
            Self::Rejected { reason, .. } => FleetLifecycleOutcome::Rejected(reason),
            Self::Unknown(reason) => FleetLifecycleOutcome::Unknown(reason),
        }
    }
}

/// The sole Host owner for multi-step Fleet lifecycle operations.
pub(crate) struct FleetLifecycleOrchestrator<'a> {
    owner: &'a mut FleetOwner,
}

impl<'a> FleetLifecycleOrchestrator<'a> {
    pub(crate) fn new(owner: &'a mut FleetOwner) -> Self {
        Self { owner }
    }

    /// Begin, perform the typed native probe, and complete the connection fact.
    /// Unknown provider outcomes deliberately leave the domain in `Probing` so a
    /// later authenticated retry can establish the next fact.
    pub(crate) async fn probe_connection(
        &mut self,
        id: ConnectionId,
        command_id: CommandId,
        now: SystemTime,
    ) -> Result<FleetConnectionLifecycleOutcome, fleet::FleetDeliveryError> {
        self.owner
            .begin_connection_probe(&id, command_id.clone(), now)?;
        let resolution = self
            .owner
            .connection_target_resolution(&id)
            .ok_or(fleet::FleetDeliveryError::InvalidTransition)?;
        let target_id = resolution.selector.id().clone();
        if let FleetTargetConfig::Custom(config) = &resolution.config {
            return match self
                .dispatch_custom_target(
                    config,
                    CustomLifecycleOperation::Probe,
                    &command_id,
                    ManagedResourceLifecycleContext::NotApplicable,
                    now,
                )
                .await?
            {
                CustomDispatchOutcome::Completed => Ok(FleetConnectionLifecycleOutcome::Ready(
                    self.owner.complete_connection_probe(
                        &id,
                        &command_id,
                        ProbeOutcome::Ready,
                        SystemTime::now(),
                        None,
                    )?,
                )),
                CustomDispatchOutcome::Rejected {
                    reason,
                    definitive_peer_failure: true,
                } => Ok(FleetConnectionLifecycleOutcome::Unhealthy(
                    self.owner.complete_connection_probe(
                        &id,
                        &command_id,
                        ProbeOutcome::Unhealthy,
                        SystemTime::now(),
                        Some(reason),
                    )?,
                )),
                CustomDispatchOutcome::Rejected {
                    reason,
                    definitive_peer_failure: false,
                } => Ok(FleetConnectionLifecycleOutcome::Rejected(reason)),
                CustomDispatchOutcome::Unknown(message) => {
                    Ok(FleetConnectionLifecycleOutcome::Unknown(message))
                }
            };
        }

        let pinned_host_key = self.owner.ssh_host_key(&target_id);
        let provider = FleetConnectionProbeProvider::from_target(
            &resolution.config,
            &target_id,
            &self.owner.docker_ownership,
            pinned_host_key.as_ref(),
        );
        let outcome = match provider {
            Ok(provider) => {
                FleetConnectionProbe::probe(provider, &mut self.owner.credentials).await
            }
            Err(error) => FleetConnectionProbeOutcome::Failed {
                message: error.to_string(),
            },
        };
        match outcome {
            FleetConnectionProbeOutcome::Ready => Ok(FleetConnectionLifecycleOutcome::Ready(
                self.owner.complete_connection_probe(
                    &id,
                    &command_id,
                    ProbeOutcome::Ready,
                    SystemTime::now(),
                    None,
                )?,
            )),
            FleetConnectionProbeOutcome::Failed { message } => Ok(
                FleetConnectionLifecycleOutcome::Unhealthy(self.owner.complete_connection_probe(
                    &id,
                    &command_id,
                    ProbeOutcome::Unhealthy,
                    SystemTime::now(),
                    Some(message),
                )?),
            ),
            FleetConnectionProbeOutcome::Unknown { message } => {
                Ok(FleetConnectionLifecycleOutcome::Unknown(message))
            }
        }
    }

    /// Dispatch a typed provider lifecycle effect.  This is intentionally
    /// separate from domain transactions: callers decide which durable fact to
    /// complete after this operation returns.
    pub(crate) async fn dispatch_target(
        &mut self,
        target: FleetTargetResolution,
        effect: TargetLifecycleEffect,
        command_id: &CommandId,
        phase: &PhaseKey,
        lifecycle_context: ManagedResourceLifecycleContext,
        now: SystemTime,
    ) -> Result<FleetLifecycleDispatch, fleet::FleetDeliveryError> {
        let FleetTargetResolution { selector, config } = target;
        let target_id = selector.id().clone();
        match (config, effect) {
            (FleetTargetConfig::Docker(config), effect) => {
                let provider_effect = effect.docker();
                let (identity, attempt) = self.begin_native_effect(
                    &selector,
                    command_id,
                    phase,
                    ProviderKind::Docker,
                    provider_effect.lifecycle_timeout(),
                    now,
                )?;
                let dispatch =
                    match DockerEffectClient::new(config, self.owner.docker_ownership.clone()) {
                        Ok(client) => match client
                            .execute_lifecycle_readback(
                                provider_effect,
                                &mut self.owner.credentials,
                                SystemTime::now(),
                            )
                            .await
                        {
                            Ok(readback) => FleetLifecycleDispatch {
                                outcome: provider_receipt_outcome(
                                    &readback.receipt,
                                    effect,
                                    lifecycle_context,
                                ),
                                receipt: Some(readback.receipt),
                            },
                            Err(error) => FleetLifecycleDispatch {
                                outcome: FleetLifecycleOutcome::from_docker(Err(error)),
                                receipt: None,
                            },
                        },
                        Err(_) => FleetLifecycleDispatch {
                            outcome: FleetLifecycleOutcome::Rejected(
                                "Docker client configuration is invalid".into(),
                            ),
                            receipt: None,
                        },
                    };
                self.settle_native_effect(&identity, &attempt, &dispatch.outcome)?;
                Ok(dispatch)
            }
            (FleetTargetConfig::Kubernetes(config), effect) => {
                let provider_effect = effect.kubernetes();
                let (identity, attempt) = self.begin_native_effect(
                    &selector,
                    command_id,
                    phase,
                    ProviderKind::Kubernetes,
                    provider_effect.lifecycle_timeout(),
                    now,
                )?;
                let dispatch = match KubernetesEffectClient::new(
                    config,
                    self.owner.docker_ownership.clone(),
                ) {
                    Ok(client) => match client
                        .execute_lifecycle_readback(
                            provider_effect,
                            &mut self.owner.credentials,
                            SystemTime::now(),
                        )
                        .await
                    {
                        Ok(readback) => FleetLifecycleDispatch {
                            outcome: provider_receipt_outcome(
                                &readback.receipt,
                                effect,
                                lifecycle_context,
                            ),
                            receipt: Some(readback.receipt),
                        },
                        Err(error) => FleetLifecycleDispatch {
                            outcome: FleetLifecycleOutcome::from_kubernetes(Err(error)),
                            receipt: None,
                        },
                    },
                    Err(_) => FleetLifecycleDispatch {
                        outcome: FleetLifecycleOutcome::Rejected(
                            "Kubernetes client configuration is invalid".into(),
                        ),
                        receipt: None,
                    },
                };
                self.settle_native_effect(&identity, &attempt, &dispatch.outcome)?;
                Ok(dispatch)
            }
            (FleetTargetConfig::Ssh(config), effect) => {
                let provider_effect = effect.ssh();
                let (identity, attempt) = self.begin_native_effect(
                    &selector,
                    command_id,
                    phase,
                    ProviderKind::Ssh,
                    provider_effect.lifecycle_timeout(),
                    now,
                )?;
                let dispatch = match self.owner.ssh_host_key(&target_id) {
                    Some(key) => match SshEffect::default()
                        .execute_lifecycle_readback(
                            provider_effect,
                            &config,
                            &mut self.owner.credentials,
                            &key,
                            SystemTime::now(),
                        )
                        .await
                    {
                        Ok(readback) => FleetLifecycleDispatch {
                            outcome: provider_receipt_outcome(
                                &readback.receipt,
                                effect,
                                lifecycle_context,
                            ),
                            receipt: Some(readback.receipt),
                        },
                        Err(error) => FleetLifecycleDispatch {
                            outcome: FleetLifecycleOutcome::from_ssh(Err(error)),
                            receipt: None,
                        },
                    },
                    None => FleetLifecycleDispatch {
                        outcome: FleetLifecycleOutcome::Rejected(
                            "SSH host-key pin is unavailable".into(),
                        ),
                        receipt: None,
                    },
                };
                self.settle_native_effect(&identity, &attempt, &dispatch.outcome)?;
                Ok(dispatch)
            }
            (FleetTargetConfig::Custom(config), effect) => {
                let operation = match effect {
                    TargetLifecycleEffect::Probe => CustomLifecycleOperation::Probe,
                    TargetLifecycleEffect::Provision => CustomLifecycleOperation::Install,
                    TargetLifecycleEffect::Deploy => CustomLifecycleOperation::Deploy,
                    TargetLifecycleEffect::Delete => CustomLifecycleOperation::Delete,
                };
                self.dispatch_custom_target(&config, operation, command_id, lifecycle_context, now)
                    .await
                    .map(|outcome| FleetLifecycleDispatch {
                        outcome: outcome.into_lifecycle(),
                        receipt: None,
                    })
            }
        }
    }

    fn begin_native_effect(
        &mut self,
        selector: &fleet::FleetTargetSelector,
        command_id: &CommandId,
        phase: &PhaseKey,
        provider_kind: ProviderKind,
        timeout: Duration,
        now: SystemTime,
    ) -> Result<(EffectIdentity, CommandAttempt), fleet::FleetDeliveryError> {
        let record = EffectRecord::with_timeout(
            command_id.clone(),
            phase.clone(),
            selector.clone(),
            selector.revision(),
            provider_kind,
            now,
            timeout,
        )
        .map_err(fleet::FleetDeliveryError::Effect)?;
        self.owner.insert_and_begin_effect(record)
    }

    fn settle_native_effect(
        &mut self,
        identity: &EffectIdentity,
        attempt: &CommandAttempt,
        outcome: &FleetLifecycleOutcome,
    ) -> Result<(), fleet::FleetDeliveryError> {
        let operation = match outcome {
            FleetLifecycleOutcome::Completed | FleetLifecycleOutcome::AlreadyAbsent => {
                self.owner
                    .accept_effect(identity, &EffectReceipt::delivered(attempt.clone()))?
            }
            FleetLifecycleOutcome::Rejected(_) => self
                .owner
                .reject_effect(identity, &EffectReceipt::rejected(attempt.clone()))?,
            FleetLifecycleOutcome::Unknown(_) => {
                self.owner.mark_effect_unknown_attempt(identity, attempt)?
            }
        };
        match operation {
            EffectOperationOutcome::Applied { .. } => Ok(()),
            EffectOperationOutcome::NotFound => Err(fleet::FleetDeliveryError::EffectNotFound),
            EffectOperationOutcome::Rejected(error) => {
                Err(fleet::FleetDeliveryError::Effect(error))
            }
        }
    }

    async fn dispatch_custom_target(
        &mut self,
        config: &CustomTargetConfig,
        operation: CustomLifecycleOperation,
        command_id: &CommandId,
        lifecycle_context: ManagedResourceLifecycleContext,
        now: SystemTime,
    ) -> Result<CustomDispatchOutcome, fleet::FleetDeliveryError> {
        if operation.authority()
            == custom_lifecycle::CustomLifecycleAuthority::UnsupportedPeerProtocol
        {
            return Ok(CustomDispatchOutcome::Rejected {
                reason: custom_lifecycle::CustomReceiptReason::UnsupportedOperation.to_string(),
                definitive_peer_failure: false,
            });
        }

        let dispatch = self
            .owner
            .delivery
            .begin_dispatch_for_command(command_id, now)?;
        if dispatch.operation_kind()
            != operation
                .command_kind()
                .expect("supported custom operation has a command kind")
        {
            let message = "Custom lifecycle command kind does not match the requested operation";
            self.owner.delivery.reject_dispatch(
                dispatch.dispatch().dispatch_id(),
                dispatch.attempt(),
                now,
            )?;
            return Ok(CustomDispatchOutcome::Rejected {
                reason: message.into(),
                definitive_peer_failure: false,
            });
        }
        let command_attempt = dispatch.command_attempt();
        let correlation = CommandCorrelation::new(
            dispatch.command_id().clone(),
            dispatch.command().idempotency_key().clone(),
        );
        if let Err(error) = self.owner.delivery.register_runtime_agent_command(
            dispatch.agent_id(),
            correlation,
            dispatch.command().queued_at(),
            command_attempt,
            dispatch.attempt().clone(),
        ) {
            let _ = self.owner.delivery.reject_dispatch(
                dispatch.dispatch().dispatch_id(),
                dispatch.attempt(),
                now,
            );
            return Err(error);
        }
        let callback = match RuntimeAgentReachabilityAdapter.resolve(
            self.owner.delivery.facts(),
            dispatch.agent_id(),
            now,
        ) {
            Ok(callback) => callback,
            Err(error) => {
                self.owner.delivery.mark_outcome_unknown(
                    dispatch.dispatch().dispatch_id(),
                    dispatch.attempt(),
                    now,
                )?;
                return Ok(CustomDispatchOutcome::Unknown(error.to_string()));
            }
        };
        let request = match CustomLifecycleRequest::try_from_dispatch_request(
            config,
            operation,
            &dispatch,
            DEFAULT_TIMEOUT,
            now,
            lifecycle_context,
        ) {
            Ok(request) => request,
            Err(error) => {
                self.owner.delivery.reject_dispatch(
                    dispatch.dispatch().dispatch_id(),
                    dispatch.attempt(),
                    now,
                )?;
                return Ok(CustomDispatchOutcome::Rejected {
                    reason: error.to_string(),
                    definitive_peer_failure: false,
                });
            }
        };
        let admission =
            custom_lifecycle::dispatch(&request, &callback, &mut self.owner.credentials).await;
        let outcome = match admission.outcome() {
            CustomReceiptOutcome::Rejected => {
                self.owner.delivery.reject_dispatch(
                    dispatch.dispatch().dispatch_id(),
                    dispatch.attempt(),
                    now,
                )?;
                CustomDispatchOutcome::Rejected {
                    reason: admission.reason().to_string(),
                    definitive_peer_failure: false,
                }
            }
            CustomReceiptOutcome::Unknown => {
                self.owner.delivery.mark_outcome_unknown(
                    dispatch.dispatch().dispatch_id(),
                    dispatch.attempt(),
                    now,
                )?;
                CustomDispatchOutcome::Unknown(admission.reason().to_string())
            }
            CustomReceiptOutcome::Accepted | CustomReceiptOutcome::Completed => {
                let readback = match self
                    .owner
                    .delivery
                    .runtime_agent_command_for_dispatch(&dispatch)
                {
                    Ok(readback) => readback,
                    Err(error) => {
                        self.owner.delivery.mark_outcome_unknown(
                            dispatch.dispatch().dispatch_id(),
                            dispatch.attempt(),
                            now,
                        )?;
                        return Ok(CustomDispatchOutcome::Unknown(error.to_string()));
                    }
                };
                let receipt = custom_lifecycle::readback_receipt(
                    &request,
                    dispatch.agent_id(),
                    readback,
                    SystemTime::now(),
                );
                match receipt.outcome() {
                    CustomReceiptOutcome::Completed => {
                        self.owner.delivery.accept_dispatch(
                            dispatch.dispatch().dispatch_id(),
                            dispatch.attempt(),
                            now,
                        )?;
                        CustomDispatchOutcome::Completed
                    }
                    CustomReceiptOutcome::Rejected => {
                        self.owner.delivery.reject_dispatch(
                            dispatch.dispatch().dispatch_id(),
                            dispatch.attempt(),
                            now,
                        )?;
                        CustomDispatchOutcome::Rejected {
                            reason: receipt.reason().to_string(),
                            definitive_peer_failure: matches!(
                                receipt.readback(),
                                custom_lifecycle::CustomReadbackEvidence::PeerFailed
                                    | custom_lifecycle::CustomReadbackEvidence::PeerCancelled
                                    | custom_lifecycle::CustomReadbackEvidence::PeerTimedOut
                            ),
                        }
                    }
                    CustomReceiptOutcome::Accepted => {
                        self.owner.delivery.mark_outcome_unknown(
                            dispatch.dispatch().dispatch_id(),
                            dispatch.attempt(),
                            now,
                        )?;
                        CustomDispatchOutcome::Unknown(receipt.reason().to_string())
                    }
                    CustomReceiptOutcome::Unknown => {
                        self.owner.delivery.mark_outcome_unknown(
                            dispatch.dispatch().dispatch_id(),
                            dispatch.attempt(),
                            now,
                        )?;
                        CustomDispatchOutcome::Unknown(receipt.reason().to_string())
                    }
                }
            }
        };
        Ok(outcome)
    }

    pub(crate) async fn deploy_environment(
        &mut self,
        id: EnvironmentId,
        command_id: CommandId,
        phase: PhaseKey,
        target: FleetTargetResolution,
        now: SystemTime,
    ) -> Result<(FleetLifecycleMutation, FleetLifecycleOutcome), fleet::FleetDeliveryError> {
        let started = FleetLifecycleMutation::Environment(
            self.owner
                .start_environment_deployment(&id, command_id.clone(), phase.clone(), now)?,
        );
        let dispatch = self
            .dispatch_target(
                target,
                TargetLifecycleEffect::Deploy,
                &command_id,
                &phase,
                ManagedResourceLifecycleContext::NotApplicable,
                now,
            )
            .await?;
        let FleetLifecycleDispatch { outcome, receipt } = dispatch;
        match &outcome {
            FleetLifecycleOutcome::Completed => {
                let mutation = match receipt {
                    Some(ProviderResourceReceipt::Confirmed(fact)) => {
                        FleetLifecycleMutation::ManagedResource(
                            self.owner.materialize_provider_environment(
                                &id,
                                &command_id,
                                &phase,
                                fact,
                                SystemTime::now(),
                            )?,
                        )
                    }
                    Some(ProviderResourceReceipt::NoAuthoritativeResourceIdentity { .. }) => {
                        FleetLifecycleMutation::Environment(
                            self.owner.complete_environment_deployment(
                                &id,
                                &command_id,
                                &phase,
                                SystemTime::now(),
                            )?,
                        )
                    }
                    _ => {
                        let message =
                            "provider completed deployment without a recognized resource receipt";
                        return Ok((
                            FleetLifecycleMutation::Environment(
                                self.owner.fail_environment_deployment(
                                    &id,
                                    &command_id,
                                    &phase,
                                    message.into(),
                                    SystemTime::now(),
                                )?,
                            ),
                            FleetLifecycleOutcome::Rejected(message.into()),
                        ));
                    }
                };
                Ok((mutation, outcome))
            }
            FleetLifecycleOutcome::AlreadyAbsent => Ok((
                FleetLifecycleMutation::Environment(self.owner.fail_environment_deployment(
                    &id,
                    &command_id,
                    &phase,
                    "provider reported the environment already absent during deployment".into(),
                    SystemTime::now(),
                )?),
                outcome,
            )),
            FleetLifecycleOutcome::Rejected(message) => Ok((
                FleetLifecycleMutation::Environment(self.owner.fail_environment_deployment(
                    &id,
                    &command_id,
                    &phase,
                    message.clone(),
                    SystemTime::now(),
                )?),
                outcome,
            )),
            FleetLifecycleOutcome::Unknown(_) => Ok((started, outcome)),
        }
    }

    pub(crate) async fn delete_environment(
        &mut self,
        id: EnvironmentId,
        command_id: CommandId,
        phase: PhaseKey,
        target: FleetTargetResolution,
        now: SystemTime,
    ) -> Result<(EnvironmentMutation, FleetLifecycleOutcome), fleet::FleetDeliveryError> {
        let started =
            self.owner
                .start_environment_deletion(&id, command_id.clone(), phase.clone(), now)?;
        let dispatch = self
            .dispatch_target(
                target,
                TargetLifecycleEffect::Delete,
                &command_id,
                &phase,
                ManagedResourceLifecycleContext::NotApplicable,
                now,
            )
            .await?;
        let outcome = dispatch.outcome;
        match &outcome {
            FleetLifecycleOutcome::Completed | FleetLifecycleOutcome::AlreadyAbsent => Ok((
                self.owner.complete_environment_deletion(
                    &id,
                    &command_id,
                    &phase,
                    SystemTime::now(),
                )?,
                outcome,
            )),
            FleetLifecycleOutcome::Rejected(message) => Ok((
                self.owner.fail_environment_deletion(
                    &id,
                    &command_id,
                    &phase,
                    message.clone(),
                    SystemTime::now(),
                )?,
                outcome,
            )),
            FleetLifecycleOutcome::Unknown(_) => Ok((started, outcome)),
        }
    }

    pub(crate) async fn provision_resource(
        &mut self,
        id: ManagedResourceId,
        command_id: CommandId,
        phase: PhaseKey,
        target: FleetTargetResolution,
        now: SystemTime,
    ) -> Result<(ManagedResourceMutation, FleetLifecycleOutcome), fleet::FleetDeliveryError> {
        let started =
            self.owner
                .start_resource_provisioning(&id, command_id.clone(), phase.clone(), now)?;
        let lifecycle_context = self
            .owner
            .delivery
            .managed_resource_lifecycle_context(Some(&id));
        let dispatch = self
            .dispatch_target(
                target,
                TargetLifecycleEffect::Provision,
                &command_id,
                &phase,
                lifecycle_context,
                now,
            )
            .await?;
        let FleetLifecycleDispatch { outcome, receipt } = dispatch;
        match &outcome {
            FleetLifecycleOutcome::Completed => match receipt {
                Some(ProviderResourceReceipt::Confirmed(fact)) => Ok((
                    self.owner.materialize_provider_resource(&id, fact, now)?,
                    outcome,
                )),
                _ => {
                    let message =
                        "provider completed provisioning without a confirmed resource receipt";
                    Ok((
                        self.owner.fail_resource_provisioning(
                            &id,
                            &command_id,
                            &phase,
                            message.into(),
                            SystemTime::now(),
                        )?,
                        FleetLifecycleOutcome::Rejected(message.into()),
                    ))
                }
            },
            FleetLifecycleOutcome::AlreadyAbsent => Ok((
                self.owner.fail_resource_provisioning(
                    &id,
                    &command_id,
                    &phase,
                    "provider reported the resource already absent during provisioning".into(),
                    SystemTime::now(),
                )?,
                outcome,
            )),
            FleetLifecycleOutcome::Rejected(message) => Ok((
                self.owner.fail_resource_provisioning(
                    &id,
                    &command_id,
                    &phase,
                    message.clone(),
                    SystemTime::now(),
                )?,
                outcome,
            )),
            FleetLifecycleOutcome::Unknown(_) => Ok((started, outcome)),
        }
    }

    pub(crate) async fn delete_resource(
        &mut self,
        id: ManagedResourceId,
        command_id: CommandId,
        phase: PhaseKey,
        target: FleetTargetResolution,
        now: SystemTime,
    ) -> Result<(ManagedResourceMutation, FleetLifecycleOutcome), fleet::FleetDeliveryError> {
        let started =
            self.owner
                .start_resource_deletion(&id, command_id.clone(), phase.clone(), now)?;
        let dispatch = self
            .dispatch_target(
                target,
                TargetLifecycleEffect::Delete,
                &command_id,
                &phase,
                ManagedResourceLifecycleContext::NotApplicable,
                now,
            )
            .await?;
        let outcome = dispatch.outcome;
        match &outcome {
            FleetLifecycleOutcome::Completed | FleetLifecycleOutcome::AlreadyAbsent => Ok((
                self.owner.complete_resource_deletion(
                    &id,
                    &command_id,
                    &phase,
                    SystemTime::now(),
                )?,
                outcome,
            )),
            FleetLifecycleOutcome::Rejected(message) => Ok((
                self.owner.fail_resource_deletion(
                    &id,
                    &command_id,
                    &phase,
                    message.clone(),
                    SystemTime::now(),
                )?,
                outcome,
            )),
            FleetLifecycleOutcome::Unknown(_) => Ok((started, outcome)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TargetLifecycleEffect {
    Probe,
    Provision,
    Deploy,
    Delete,
}

impl TargetLifecycleEffect {
    fn docker(self) -> DockerLifecycleEffect {
        match self {
            Self::Probe => DockerLifecycleEffect::Probe,
            Self::Provision | Self::Deploy => DockerLifecycleEffect::Provision,
            Self::Delete => DockerLifecycleEffect::Delete,
        }
    }
    fn kubernetes(self) -> KubernetesLifecycleEffect {
        match self {
            Self::Probe => KubernetesLifecycleEffect::Probe,
            Self::Provision | Self::Deploy => KubernetesLifecycleEffect::Provision,
            Self::Delete => KubernetesLifecycleEffect::Delete,
        }
    }
    fn ssh(self) -> SshLifecycleEffect {
        match self {
            Self::Probe => SshLifecycleEffect::Probe,
            Self::Provision | Self::Deploy => SshLifecycleEffect::Provision,
            Self::Delete => SshLifecycleEffect::Delete,
        }
    }
}

fn provider_receipt_outcome(
    receipt: &ProviderResourceReceipt,
    effect: TargetLifecycleEffect,
    context: ManagedResourceLifecycleContext,
) -> FleetLifecycleOutcome {
    match receipt {
        ProviderResourceReceipt::Confirmed(_) => FleetLifecycleOutcome::Completed,
        ProviderResourceReceipt::AlreadyAbsent { .. }
            if effect == TargetLifecycleEffect::Delete =>
        {
            FleetLifecycleOutcome::AlreadyAbsent
        }
        ProviderResourceReceipt::AlreadyAbsent { .. } => FleetLifecycleOutcome::Rejected(
            "provider reported the resource already absent for a non-delete lifecycle operation"
                .into(),
        ),
        ProviderResourceReceipt::NoAuthoritativeResourceIdentity { .. }
            if matches!(context, ManagedResourceLifecycleContext::NotApplicable) =>
        {
            FleetLifecycleOutcome::Completed
        }
        ProviderResourceReceipt::NoAuthoritativeResourceIdentity { .. } => {
            FleetLifecycleOutcome::Rejected(
                "provider completed without an authoritative managed-resource identity".into(),
            )
        }
    }
}

fn docker_unknown(error: &DockerEffectError) -> bool {
    matches!(
        error,
        DockerEffectError::Timeout
            | DockerEffectError::Network
            | DockerEffectError::InvalidResponse
            | DockerEffectError::BodyTooLarge
    )
}
fn kubernetes_unknown(error: &KubernetesEffectError) -> bool {
    matches!(
        error,
        KubernetesEffectError::Timeout
            | KubernetesEffectError::Network
            | KubernetesEffectError::InvalidResponse
            | KubernetesEffectError::ReadbackMismatch
            | KubernetesEffectError::BodyTooLarge
    )
}
fn ssh_unknown(error: &SshEffectError) -> bool {
    matches!(
        error,
        SshEffectError::Timeout | SshEffectError::Network | SshEffectError::Protocol
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_errors_are_not_completed() {
        assert!(docker_unknown(&DockerEffectError::Timeout));
        assert!(kubernetes_unknown(&KubernetesEffectError::Network));
        assert!(ssh_unknown(&SshEffectError::Protocol));
        assert_eq!(
            FleetLifecycleOutcome::from_docker(Err(DockerEffectError::Timeout)),
            FleetLifecycleOutcome::Unknown("Docker Engine request timed out".into())
        );
    }

    #[test]
    fn lifecycle_effect_mapping_is_typed() {
        assert_eq!(
            TargetLifecycleEffect::Provision.docker(),
            DockerLifecycleEffect::Provision
        );
        assert_eq!(
            TargetLifecycleEffect::Delete.kubernetes(),
            KubernetesLifecycleEffect::Delete
        );
        assert_eq!(
            TargetLifecycleEffect::Probe.ssh(),
            SshLifecycleEffect::Probe
        );
        assert_eq!(
            CustomLifecycleOperation::Delete.authority(),
            custom_lifecycle::CustomLifecycleAuthority::UnsupportedPeerProtocol
        );
    }

    #[test]
    fn provider_outcomes_preserve_unknown_and_rejected_boundaries() {
        assert_eq!(
            FleetLifecycleOutcome::from_docker(Ok(DockerEffectOutcome::AlreadyAbsent,)),
            FleetLifecycleOutcome::AlreadyAbsent
        );
        assert_eq!(
            FleetLifecycleOutcome::from_docker(Err(DockerEffectError::Timeout)),
            FleetLifecycleOutcome::Unknown("Docker Engine request timed out".into())
        );
        assert_eq!(
            FleetLifecycleOutcome::from_kubernetes(Err(KubernetesEffectError::RemoteStatus(403))),
            FleetLifecycleOutcome::Rejected("Kubernetes API returned HTTP 403".into())
        );
        let rejected = FleetLifecycleOutcome::from_docker(Err(DockerEffectError::SetupFailed(
            1,
            "provider-secret".into(),
        )));
        assert_eq!(
            rejected,
            FleetLifecycleOutcome::Rejected("Docker setup exited with code 1".into())
        );
        assert!(!format!("{rejected:?}").contains("provider-secret"));
    }

    #[test]
    fn deployment_receipts_preserve_materialization_boundaries() {
        let observed_at = SystemTime::UNIX_EPOCH;
        let confirmed = ProviderResourceReceipt::Confirmed(
            crate::application::provider_resource::ProviderResourceFact::confirmed(
                crate::application::provider_resource::ProviderResourceProvider::Docker,
                crate::application::provider_resource::ProviderResourceKind::DockerContainer,
                "container-id",
                vec![
                    crate::application::provider_resource::ProviderResourceRef::new(
                        crate::application::provider_resource::ProviderResourceProvider::Docker,
                        crate::application::provider_resource::ProviderResourceKind::DockerContainer,
                        "container-id",
                        None,
                        Some("container".into()),
                    )
                    .unwrap(),
                ],
                crate::application::provider_resource::ProviderOwnershipEvidence::required(
                    [("managed-by".into(), "matcha".into())]
                        .into_iter()
                        .collect(),
                )
                .unwrap(),
                crate::application::provider_resource::ProviderResourceAssociation::docker_container(
                    "container",
                )
                .unwrap(),
                "container",
                [("managed-by".into(), "matcha".into())]
                    .into_iter()
                    .collect(),
                observed_at,
            )
            .unwrap(),
        );
        assert_eq!(
            provider_receipt_outcome(
                &confirmed,
                TargetLifecycleEffect::Deploy,
                ManagedResourceLifecycleContext::NotApplicable,
            ),
            FleetLifecycleOutcome::Completed
        );

        let no_identity = ProviderResourceReceipt::NoAuthoritativeResourceIdentity {
            provider: crate::application::provider_resource::ProviderResourceProvider::Ssh,
            observed_at,
        };
        assert_eq!(
            provider_receipt_outcome(
                &no_identity,
                TargetLifecycleEffect::Deploy,
                ManagedResourceLifecycleContext::NotApplicable,
            ),
            FleetLifecycleOutcome::Completed
        );
        assert_eq!(
            provider_receipt_outcome(
                &no_identity,
                TargetLifecycleEffect::Provision,
                ManagedResourceLifecycleContext::Unavailable,
            ),
            FleetLifecycleOutcome::Rejected(
                "provider completed without an authoritative managed-resource identity".into()
            )
        );
    }
}
