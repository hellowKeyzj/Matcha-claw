use std::collections::BTreeMap;
use std::time::SystemTime;

use crate::command::CommandAttempt;

use super::{
    EffectIdentity, EffectReceipt, EffectRecord, EffectState, EffectTransition,
    EffectTransitionError,
};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EffectLedger {
    records: BTreeMap<EffectIdentity, EffectRecord>,
}

impl EffectLedger {
    pub fn restore(
        records: impl IntoIterator<Item = EffectRecord>,
    ) -> Result<Self, RestoreEffectError> {
        let mut ledger = Self::default();
        for record in records {
            let identity = record.identity().clone();
            if ledger.records.insert(identity.clone(), record).is_some() {
                return Err(RestoreEffectError::DuplicateIdentity(identity));
            }
        }
        Ok(ledger)
    }

    pub fn insert(&mut self, record: EffectRecord) -> Result<(), InsertEffectError> {
        let identity = record.identity().clone();
        if self.records.contains_key(&identity) {
            return Err(InsertEffectError::DuplicateIdentity(identity));
        }
        self.records.insert(identity, record);
        Ok(())
    }

    pub fn record(&self, identity: &EffectIdentity) -> Option<&EffectRecord> {
        self.records.get(identity)
    }

    pub fn records(&self) -> impl Iterator<Item = &EffectRecord> {
        self.records.values()
    }

    pub fn begin(&mut self, identity: &EffectIdentity) -> EffectOperationOutcome {
        self.apply(identity, EffectRecord::begin)
    }

    pub fn accept(
        &mut self,
        identity: &EffectIdentity,
        receipt: &EffectReceipt,
    ) -> EffectOperationOutcome {
        self.apply(identity, |record| record.apply_receipt(receipt))
    }

    pub fn reject(
        &mut self,
        identity: &EffectIdentity,
        receipt: &EffectReceipt,
    ) -> EffectOperationOutcome {
        self.apply(identity, |record| record.apply_receipt(receipt))
    }

    pub fn unknown(
        &mut self,
        identity: &EffectIdentity,
        now: SystemTime,
    ) -> EffectOperationOutcome {
        self.apply(identity, |record| record.expire(now))
    }

    pub fn mark_unknown(
        &mut self,
        identity: &EffectIdentity,
        attempt: &CommandAttempt,
    ) -> EffectOperationOutcome {
        self.apply(identity, |record| record.mark_unknown(attempt))
    }

    pub fn replay(&mut self, identity: &EffectIdentity) -> EffectOperationOutcome {
        self.apply(identity, EffectRecord::authorize_replay)
    }

    fn apply(
        &mut self,
        identity: &EffectIdentity,
        transition: impl FnOnce(&mut EffectRecord) -> Result<EffectTransition, EffectTransitionError>,
    ) -> EffectOperationOutcome {
        let Some(record) = self.records.get_mut(identity) else {
            return EffectOperationOutcome::NotFound;
        };
        match transition(record) {
            Ok(transition) => EffectOperationOutcome::Applied { transition },
            Err(error) => EffectOperationOutcome::Rejected(error),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RestoreEffectError {
    DuplicateIdentity(EffectIdentity),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InsertEffectError {
    DuplicateIdentity(EffectIdentity),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EffectOperationOutcome {
    Applied { transition: EffectTransition },
    NotFound,
    Rejected(EffectTransitionError),
}

impl EffectOperationOutcome {
    pub fn attempt(&self) -> Option<&CommandAttempt> {
        match self {
            Self::Applied {
                transition: EffectTransition::Began { attempt },
            } => Some(attempt),
            Self::Applied { .. } | Self::NotFound | Self::Rejected(_) => None,
        }
    }

    pub fn is_idempotent(&self) -> bool {
        matches!(
            self,
            Self::Applied {
                transition: EffectTransition::Idempotent
            }
        )
    }
}

#[allow(dead_code)]
fn _state_is_exhaustive(state: EffectState) -> bool {
    state.is_terminal()
}
