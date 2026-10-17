use foundation::process::supervision::StartOutcome;

use crate::composition::runtime_ports::{LifecycleOps, RuntimeStartFailure};

use super::actor::PeerShared;

pub(super) async fn start(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<StartOutcome, RuntimeStartFailure> {
    let result = async {
        let outcome = lifecycle.start().await?;
        if outcome == StartOutcome::Started {
            apply_projections(shared, lifecycle, true).await?;
        }
        Ok(outcome)
    }
    .await;
    shared.record_matcha_start(result.clone());
    result
}

pub(super) async fn apply_ready_projections(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<(), RuntimeStartFailure> {
    apply_projections(shared, lifecycle, false).await
}

async fn apply_projections(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
    retry_failed: bool,
) -> Result<(), RuntimeStartFailure> {
    let mut projection = shared.matcha_ready_projection().lock().await;
    if matches!(
        shared.admission().state().phase(),
        crate::HostPhase::ShuttingDown | crate::HostPhase::ShutDown
    ) {
        return Err(RuntimeStartFailure::ShuttingDown);
    }
    let snapshot = lifecycle.snapshot();
    if snapshot.phase() != foundation::process::supervision::SupervisorPhase::Running
        || snapshot.process().is_none()
    {
        return Err(RuntimeStartFailure::CompletionFailed);
    }
    if projection.process != snapshot.process() {
        projection.process = snapshot.process();
        projection.provider = None;
        projection.connector = None;
        projection.sealed = None;
    }
    // Lifecycle notifications only fill missing evidence; a start action may retry failures.
    if projection.provider.is_none() || (retry_failed && !projection.provider_ready()) {
        projection.provider = Some(
            shared
                .provider()
                .prepare_private_projection(
                    runtime_directory::RuntimeDriverIdentity::matcha_agent().endpoint(),
                )
                .await,
        );
    }
    if projection.connector.is_none() || (retry_failed && !projection.connector_projected()) {
        projection.connector = Some(
            shared
                .connector()
                .reproject_private_projection(
                    runtime_directory::RuntimeDriverIdentity::matcha_agent().endpoint(),
                )
                .await,
        );
    }
    if projection.sealed.is_none() || (retry_failed && !projection.sealed_projected()) {
        projection.sealed = Some(match shared.matcha_agent().sealed_reader_source() {
            Some(reader) => {
                matcha_agent::sealed::project(&shared.matcha_agent().native_client(), reader).await
            }
            None => Err(matcha_agent::sealed::ProjectionError::missing_source()),
        });
    }
    if matches!(
        shared.admission().state().phase(),
        crate::HostPhase::ShuttingDown | crate::HostPhase::ShutDown
    ) {
        return Err(RuntimeStartFailure::ShuttingDown);
    }
    let current = lifecycle.snapshot();
    if !projection.provider_ready()
        || !projection.connector_projected()
        || !projection.sealed_projected()
        || current.phase() != foundation::process::supervision::SupervisorPhase::Running
        || current.process() != snapshot.process()
    {
        return Err(RuntimeStartFailure::CompletionFailed);
    }
    Ok(())
}

impl super::MatchaReadyProjection {
    fn provider_ready(&self) -> bool {
        self.provider.as_ref().is_some_and(|effect| {
            !matches!(
                effect.providers,
                provider_module::ProviderConfigWriteEffect::Unknown(_)
            ) && effect.restart != provider_module::ProviderRestartPreparation::Unknown
        })
    }

    fn connector_projected(&self) -> bool {
        matches!(
            self.connector,
            Some(connectors::ports::ConnectorProjectionEffect::Written { .. })
        )
    }

    fn sealed_projected(&self) -> bool {
        self.sealed.as_ref().is_some_and(|effect| {
            effect.as_ref().is_ok_and(|receipt| {
                receipt.projected
                    && receipt.application == matcha_agent::sealed::Application::FutureCliInstances
            })
        })
    }
}
