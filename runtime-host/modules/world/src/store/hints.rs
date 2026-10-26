use super::{StoreError, WorldStore};
use world_protocol::{
    commit::CommitFailure,
    events::WorldHint,
    failure::FailureStage,
    ids::{EventId, Generation, WorldRef},
};

#[derive(Clone, Copy)]
pub(crate) struct HintCursor {
    pub incarnation: Generation,
    pub sequence: u64,
}
pub(crate) struct DurableHint {
    pub event_id: EventId,
    pub sequence: u64,
    pub hint: WorldHint,
}
pub(crate) struct HintPage {
    pub cursor: HintCursor,
    pub events: Vec<DurableHint>,
    pub resync: Option<WorldHint>,
}
fn invalid() -> StoreError {
    StoreError::new(CommitFailure::InternalFault, FailureStage::Read)
}
impl WorldStore {
    /// Durable hints only; recipients still re-read current authorized canonical facts.
    pub(crate) async fn read_hints(
        &self,
        world: WorldRef,
        cursor: Option<HintCursor>,
        limit: u16,
    ) -> Result<HintPage, StoreError> {
        if limit == 0 || limit > 256 {
            return Err(StoreError::new(
                CommitFailure::InvalidBatch,
                FailureStage::Read,
            ));
        }
        self.snapshot(world.clone(), move |snapshot| Box::pin(async move {
            let head = snapshot.query_opt("SELECT r.generation,coalesce(c.last_sequence,0) AS last_sequence FROM world_runtime_head r LEFT JOIN world_outbox_counter c USING(tenant_id,world_id) WHERE r.tenant_id=$1 AND r.world_id=$2", &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await?.ok_or_else(invalid)?;
            let incarnation = Generation(u64::try_from(head.get::<_, i64>("generation")).map_err(|_| invalid())?);
            let high = u64::try_from(head.get::<_, i64>("last_sequence")).map_err(|_| invalid())?;
            let current = HintCursor { incarnation, sequence: high };
            let resync = || HintPage { cursor: current, events: Vec::new(), resync: Some(WorldHint::ResyncRequired { world: world.clone(), incarnation }) };
            let Some(cursor) = cursor else { return Ok(resync()); };
            if cursor.incarnation != incarnation || cursor.sequence > high || high - cursor.sequence > u64::from(limit) { return Ok(resync()); }
            let rows = snapshot.query("SELECT event_id,sequence,event_kind,CASE WHEN event_kind='world.changed' THEN payload ELSE NULL END AS payload FROM world_outbox WHERE tenant_id=$1 AND world_id=$2 AND sequence>$3 AND sequence<=$4 ORDER BY sequence LIMIT $5", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &(cursor.sequence as i64), &(high as i64), &i64::from(limit)]).await?;
            let mut next = cursor.sequence;
            let mut events = Vec::new();
            for row in rows {
                let sequence = u64::try_from(row.get::<_, i64>("sequence")).map_err(|_| invalid())?;
                if next.checked_add(1) != Some(sequence) { return Ok(resync()); }
                next = sequence;
                if row.get::<_, String>("event_kind") != "world.changed" { continue; }
                let hint: WorldHint = serde_json::from_value(row.get("payload")).map_err(|error| StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Read, error))?;
                let (hint_world, hint_incarnation) = match &hint {
                    WorldHint::Changed { world, incarnation, .. } | WorldHint::ResyncRequired { world, incarnation } => (world, incarnation),
                };
                if hint_world != &world { return Err(invalid()); }
                if *hint_incarnation != incarnation { return Ok(resync()); }
                let event_id = EventId::try_new(row.get::<_, String>("event_id")).map_err(|_| invalid())?;
                events.push(DurableHint { event_id, sequence, hint });
            }
            if next != high { return Ok(resync()); }
            Ok(HintPage { cursor: current, events, resync: None })
        })).await
    }
}
