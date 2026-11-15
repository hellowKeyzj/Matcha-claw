use crate::{IdempotencyKey, OrganizationStore, RuntimeEndpointReference, TeamId, package::{TeamSkillDependencyCatalog, TeamSkillDependencyPlan, TeamSkillSelectionError, TeamSkillSelectionId}};

use super::{actor::OrganizationShared, team_run::TeamMaterializationCommandOutcome};

pub(super) async fn materialize(
    store: &mut OrganizationStore,
    shared: &OrganizationShared,
    selection_id: TeamSkillSelectionId,
    endpoint: RuntimeEndpointReference,
    source_agent: Option<crate::ManagedAgentReference>,
    team_id: TeamId,
    idempotency_key: IdempotencyKey,
    call: crate::call::CallReply<TeamMaterializationCommandOutcome>,
) {
    let prepared = async {
        let runtime = shared.team_runtime_for_endpoint(&endpoint).ok_or(TeamMaterializationCommandOutcome::Unavailable)?;
        let cancellation = call.cancellation();
        let names = tokio::select! {
            _ = cancellation.cancelled() => None,
            names = runtime.installed_skill_names(source_agent.clone()) => names,
        }.ok_or(TeamMaterializationCommandOutcome::Unavailable)?;
        let reader = shared.team_skill_selections.lock().await.package_reader(&selection_id)
            .map_err(|_| TeamMaterializationCommandOutcome::Unavailable)?;
        let package = reader.read().map_err(|error| match TeamSkillSelectionError::from(error) {
            TeamSkillSelectionError::Unavailable => TeamMaterializationCommandOutcome::Unavailable,
            _ => TeamMaterializationCommandOutcome::Rejected,
        })?;
        if !TeamSkillDependencyPlan::from_package(
            selection_id, &package, &TeamSkillDependencyCatalog::from_installed_names(names),
        ).can_proceed() {
            return Err(TeamMaterializationCommandOutcome::Rejected);
        }
        crate::compile_team_skill_materialization(&package, team_id, endpoint, idempotency_key)
            .map(|materialization| materialization.with_source_agent(source_agent))
            .map_err(|_| TeamMaterializationCommandOutcome::Rejected)
    }.await;
    let materialization = match prepared {
        Ok(materialization) => materialization,
        Err(outcome) => { let _ = call.send(outcome).await; return; }
    };
    let outcome = super::manual_team::materialize_team(
        store, shared, materialization, None, call.cancellation(), Some(&call),
    ).await;
    let _ = call.send(outcome).await;
}
