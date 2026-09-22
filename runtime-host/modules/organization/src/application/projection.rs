use organization::{GraphRunId, OrganizationStore, TeamId};

pub(crate) fn team_public_projection(
    store: &OrganizationStore,
    team_id: &TeamId,
    run_id: &GraphRunId,
) -> organization::run::public_projection::TeamPublicQueryOutcome {
    organization::run::public_projection::query_team_public_projection(
        store.facts(),
        team_id,
        run_id,
    )
}

pub(crate) fn team_run_public_snapshot(
    store: &OrganizationStore,
    team_id: Option<TeamId>,
    run_id: GraphRunId,
    event_cursor: Option<u64>,
    event_limit: Option<u64>,
) -> Option<organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome> {
    match team_id {
        Some(team_id) => {
            organization::run::public_projection::TeamRunPublicSnapshotRequest::try_new(
                team_id,
                run_id,
                event_cursor.unwrap_or_default(),
                event_limit,
            )
            .ok()
            .map(|request| {
                organization::run::public_projection::produce_team_run_public_snapshot(
                    store.facts(),
                    &request,
                )
            })
        }
        None => organization::run::public_projection::produce_team_run_public_snapshot_for_run(
            store.facts(),
            &run_id,
            event_cursor.unwrap_or_default(),
            event_limit,
        )
        .ok(),
    }
}
