use super::{
    error::{codec, rejected},
    ledger::LedgerInput,
};
use crate::{
    owner::Error,
    store::{RetentionRoots, WorldTransaction},
};
use world_protocol::{
    failure::Failure, generation::GenerationReceipt, operation::OperationFailure,
};

pub(crate) async fn world_deletion_roots(
    tx: &WorldTransaction<'_>,
) -> Result<RetentionRoots, Error> {
    let mut roots = RetentionRoots::default();
    let mut after: Option<String> = None;
    loop {
        let rows = tx.query(
            "SELECT model_call_id,request,receipt,failure FROM world_model_call WHERE tenant_id=$1 AND world_id=$2 AND ($3::text IS NULL OR model_call_id>$3) ORDER BY model_call_id LIMIT 256",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after],
        ).await?;
        let more = rows.len() == 256;
        for row in rows {
            let input: LedgerInput = serde_json::from_value(row.get("request")).map_err(codec)?;
            if input.request.world != *tx.world() {
                return Err(rejected(
                    world_protocol::generation::GenerationStage::Read,
                    world_protocol::generation::GenerationFailureKind::BindingInvalid,
                ));
            }
            roots.source_versions.extend(input.sources);
            for access in input.impact.access {
                roots.scopes.push(access.scope);
                roots.resources.extend(access.resources);
                roots.definitions.extend(access.fields);
            }
            let receipt: Option<GenerationReceipt> = row
                .get::<_, Option<serde_json::Value>>("receipt")
                .map(serde_json::from_value)
                .transpose()
                .map_err(codec)?;
            if let Some(value) = receipt.as_ref().and_then(|receipt| receipt.value.as_ref()) {
                crate::definitions::value_resources(value, &mut roots.resources);
            }
            let failure: Option<Failure<OperationFailure>> = row
                .get::<_, Option<serde_json::Value>>("failure")
                .map(serde_json::from_value)
                .transpose()
                .map_err(codec)?;
            if let Some(failure) = failure {
                crate::owner::operation_failure_roots(tx.world(), &failure.details, &mut roots)?;
            }
            after = Some(row.get("model_call_id"));
        }
        if !more {
            return Ok(roots);
        }
    }
}
