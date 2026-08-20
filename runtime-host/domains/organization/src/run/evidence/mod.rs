mod ledger;
mod model;
mod record;

pub use ledger::{EvidenceLedger, RecordOutcome, RestoreLedgerError};
pub use model::{EvidenceReference, EvidenceReferenceError, EvidenceReferenceKind};
pub use record::{EvidenceId, EvidenceIdError, EvidenceRecord, EvidenceRecordError};

#[cfg(test)]
mod tests;
