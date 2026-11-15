use crate::prompts::{TeamPromptSettings, validate_values};

use super::super::{
    StoreFault,
    schema::{RecordKey, RecordKind, StoredRecord},
};

pub(crate) fn encode(settings: &TeamPromptSettings) -> Result<StoredRecord, StoreFault> {
    Ok(StoredRecord {
        key: RecordKey {
            kind: RecordKind::TeamPrompts,
            scope: String::new(),
            id: String::new(),
        },
        team_id: None,
        run_id: None,
        payload: serde_json::to_vec(settings).map_err(|_| StoreFault::InvalidFacts)?,
    })
}

pub(crate) fn decode(record: &StoredRecord) -> Result<TeamPromptSettings, StoreFault> {
    if record.key.kind != RecordKind::TeamPrompts
        || !record.key.scope.is_empty()
        || !record.key.id.is_empty()
        || record.team_id.is_some()
        || record.run_id.is_some()
    {
        return Err(StoreFault::CorruptRecord);
    }
    let settings: TeamPromptSettings =
        serde_json::from_slice(&record.payload).map_err(|_| StoreFault::CorruptRecord)?;
    validate_values(&settings.values).map_err(|_| StoreFault::CorruptRecord)?;
    Ok(settings)
}
