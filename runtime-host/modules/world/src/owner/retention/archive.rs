use world_protocol::api::WorldCommand;

use super::{Error, OperationRecord, RunRecord, StepRecord, decode, invalid, number, workflows};
use crate::store::{RetentionRoots, WorldSnapshot};

/// Read the owner's durable material references in the archive's existing snapshot.
pub(crate) async fn archive_retention_roots(
    snapshot: &WorldSnapshot<'_>,
) -> Result<RetentionRoots, Error> {
    let world = snapshot.world();
    let mut roots = crate::facts::assertions::archive_retention_roots(snapshot).await?;
    let candidates = crate::learning::archive_retention_roots(snapshot).await?;
    roots.source_versions.extend(candidates.source_versions);
    roots.parse_artifacts.extend(candidates.parse_artifacts);
    let sources = crate::sources::sync::archive_source_roots(snapshot).await?;
    roots.source_versions.extend(sources.source_versions);
    roots.parse_artifacts.extend(sources.parse_artifacts);
    let mut after = String::new();
    loop {
        let rows = snapshot.query(
            "SELECT operation_id,revision,body FROM world_operation WHERE tenant_id=$1 AND world_id=$2 AND operation_id>$3 ORDER BY operation_id LIMIT 256",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &after],
        ).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = row.get("operation_id");
            let operation: OperationRecord = decode(row.get("body"))?;
            if operation.input.world() != world || operation.receipt.accepted.world != *world
                || operation.receipt.accepted.operation_id.as_str() != after
                || number(operation.receipt.accepted.revision)? != row.get::<_, i64>("revision") {
                return Err(invalid());
            }
            workflows::materials::archive_operation_retention_roots(
                world, operation.receipt.result.as_ref(), &mut roots,
            )?;
        }
        if done { break; }
    }
    let mut after = (String::new(), String::new());
    loop {
        let rows = snapshot.query(
            "SELECT s.run_id,s.step_id,s.revision,s.kind,s.body,r.body AS run_body,r.revision AS run_revision,r.kind AS run_kind,o.body AS operation_body,o.operation_id,o.revision AS operation_revision FROM world_step s JOIN world_run r USING(tenant_id,world_id,run_id) JOIN world_operation o ON o.tenant_id=r.tenant_id AND o.world_id=r.world_id AND o.operation_id=r.operation_id WHERE s.tenant_id=$1 AND s.world_id=$2 AND s.kind LIKE 'materials.%' AND (s.run_id,s.step_id)>($3,$4) ORDER BY s.run_id,s.step_id LIMIT 256",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &after.0, &after.1],
        ).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = (row.get("run_id"), row.get("step_id"));
            let step: StepRecord = decode(row.get("body"))?;
            let run: RunRecord = decode(row.get("run_body"))?;
            let operation: OperationRecord = decode(row.get("operation_body"))?;
            if step.run_id.as_str() != after.0 || step.id.as_str() != after.1
                || step.kind != row.get::<_, String>("kind")
                || number(step.revision)? != row.get::<_, i64>("revision")
                || run.id != step.run_id || run.operation.world != *world
                || number(run.revision)? != row.get::<_, i64>("run_revision")
                || operation.input.world() != world || operation.receipt.accepted.world != *world
                || operation.receipt.accepted.operation_id.as_str() != row.get::<_, String>("operation_id")
                || number(operation.receipt.accepted.revision)? != row.get::<_, i64>("operation_revision")
                || run.operation.operation_id != operation.receipt.accepted.operation_id
                || run.operation.incarnation != operation.receipt.accepted.incarnation
                || operation.receipt.progress.run_id.as_ref() != Some(&run.id)
                || operation.input.operation_name() != row.get::<_, String>("run_kind") {
                return Err(invalid());
            }
            let WorldCommand::ImportMaterials(request) = operation.input.command()? else {
                return Err(invalid());
            };
            if matches!(step.kind.as_str(), "materials.parse" | "materials.draft")
                && step.input_digest != crate::definitions::canonical_digest(request)? {
                return Err(invalid());
            }
            workflows::materials::archive_step_retention_roots(world, &step, &mut roots)?;
        }
        if done { break; }
    }
    roots.source_versions.sort_by(|left, right| {
        (&left.source_id, &left.version_id).cmp(&(&right.source_id, &right.version_id))
    });
    roots.source_versions.dedup();
    roots.parse_artifacts.sort();
    roots.parse_artifacts.dedup();
    Ok(roots)
}
