use std::{collections::BTreeMap, fmt};

use super::{TriggerFireRequest, TriggerFireRequestError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriggerRegistration {
    Recorded(TriggerFireRequest),
    Replayed(TriggerFireRequest),
    ConflictingIdempotencyKey { idempotency_key: String },
}

#[derive(Clone, PartialEq, Eq)]
pub enum RestoreTriggerLedgerError {
    InvalidRequest(TriggerFireRequestError),
    DuplicateIdempotencyKey(String),
}

impl fmt::Debug for RestoreTriggerLedgerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::InvalidRequest(_) => "RestoreTriggerLedgerError::InvalidRequest",
            Self::DuplicateIdempotencyKey(_) => {
                "RestoreTriggerLedgerError::DuplicateIdempotencyKey"
            }
        };
        formatter.write_str(name)
    }
}

impl fmt::Display for RestoreTriggerLedgerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidRequest(_) => "trigger ledger contains an invalid request",
            Self::DuplicateIdempotencyKey(_) => "trigger ledger repeats an idempotency key",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for RestoreTriggerLedgerError {}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TriggerLedger {
    requests_by_run_and_idempotency_key: BTreeMap<(String, String), TriggerFireRequest>,
}

impl TriggerLedger {
    pub fn restore(
        requests: impl IntoIterator<Item = TriggerFireRequest>,
    ) -> Result<Self, RestoreTriggerLedgerError> {
        let mut ledger = Self::default();
        for request in requests {
            request
                .validate()
                .map_err(RestoreTriggerLedgerError::InvalidRequest)?;
            if ledger
                .requests_by_run_and_idempotency_key
                .contains_key(&request_key(&request))
            {
                return Err(RestoreTriggerLedgerError::DuplicateIdempotencyKey(
                    request.idempotency_key,
                ));
            }
            ledger
                .requests_by_run_and_idempotency_key
                .insert(request_key(&request), request);
        }
        Ok(ledger)
    }

    pub fn register(
        &mut self,
        request: TriggerFireRequest,
    ) -> Result<TriggerRegistration, TriggerFireRequestError> {
        request.validate()?;
        if let Some(existing) = self
            .requests_by_run_and_idempotency_key
            .get(&request_key(&request))
        {
            return if existing == &request {
                Ok(TriggerRegistration::Replayed(existing.clone()))
            } else {
                Ok(TriggerRegistration::ConflictingIdempotencyKey {
                    idempotency_key: request.idempotency_key,
                })
            };
        }

        self.requests_by_run_and_idempotency_key
            .insert(request_key(&request), request.clone());
        Ok(TriggerRegistration::Recorded(request))
    }

    pub fn request(&self, run_id: &str, idempotency_key: &str) -> Option<&TriggerFireRequest> {
        self.requests_by_run_and_idempotency_key
            .get(&(run_id.to_owned(), idempotency_key.to_owned()))
    }

    pub fn requests(&self) -> impl Iterator<Item = &TriggerFireRequest> {
        self.requests_by_run_and_idempotency_key.values()
    }

    pub(crate) fn retain_without_run(&mut self, run_id: &str) {
        self.requests_by_run_and_idempotency_key
            .retain(|(candidate, _), _| candidate != run_id);
    }
}

fn request_key(request: &TriggerFireRequest) -> (String, String) {
    (request.run_id.clone(), request.idempotency_key.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::trigger::TriggerSource;

    fn request(run_id: &str, source: TriggerSource, key: &str) -> TriggerFireRequest {
        TriggerFireRequest::try_new(run_id, "start-1", source, key).unwrap()
    }

    #[test]
    fn records_then_replays_an_identical_trigger_within_one_run() {
        let request = request("run-1", TriggerSource::Cron, "slot-1");
        let mut ledger = TriggerLedger::default();

        assert_eq!(
            ledger.register(request.clone()),
            Ok(TriggerRegistration::Recorded(request.clone()))
        );
        assert_eq!(
            ledger.register(request.clone()),
            Ok(TriggerRegistration::Replayed(request.clone()))
        );
        assert_eq!(ledger.request("run-1", "slot-1"), Some(&request));
    }

    #[test]
    fn rejects_a_reused_key_for_different_trigger_facts_within_one_run() {
        let mut ledger = TriggerLedger::default();
        ledger
            .register(request("run-1", TriggerSource::Cron, "slot-1"))
            .unwrap();

        let conflicting =
            TriggerFireRequest::try_new("run-1", "start-2", TriggerSource::Webhook, "slot-1")
                .unwrap();

        assert_eq!(
            ledger.register(conflicting),
            Ok(TriggerRegistration::ConflictingIdempotencyKey {
                idempotency_key: "slot-1".into(),
            })
        );
    }

    #[test]
    fn allows_the_same_idempotency_key_in_different_runs() {
        let mut ledger = TriggerLedger::default();
        let first = request("run-1", TriggerSource::Webhook, "shared");
        let second = request("run-2", TriggerSource::Webhook, "shared");

        assert_eq!(
            ledger.register(first.clone()),
            Ok(TriggerRegistration::Recorded(first.clone()))
        );
        assert_eq!(
            ledger.register(second.clone()),
            Ok(TriggerRegistration::Recorded(second.clone()))
        );
        assert_eq!(ledger.request("run-1", "shared"), Some(&first));
        assert_eq!(ledger.request("run-2", "shared"), Some(&second));
    }

    #[test]
    fn restore_rejects_duplicate_keys_only_within_the_same_run() {
        let error = TriggerLedger::restore([
            request("run-1", TriggerSource::Cron, "slot-1"),
            request("run-1", TriggerSource::Webhook, "slot-1"),
        ])
        .unwrap_err();

        assert_eq!(
            error,
            RestoreTriggerLedgerError::DuplicateIdempotencyKey("slot-1".into())
        );
    }

    #[test]
    fn restore_accepts_the_same_key_across_runs() {
        let ledger = TriggerLedger::restore([
            request("run-1", TriggerSource::Cron, "slot-1"),
            request("run-2", TriggerSource::Webhook, "slot-1"),
        ])
        .unwrap();

        assert_eq!(ledger.requests().count(), 2);
    }

    #[test]
    fn restore_errors_do_not_reveal_trigger_ids() {
        let error = TriggerLedger::restore([
            request("run-1", TriggerSource::Cron, "private-slot"),
            request("run-1", TriggerSource::Webhook, "private-slot"),
        ])
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            "trigger ledger repeats an idempotency key"
        );
        assert_eq!(
            format!("{error:?}"),
            "RestoreTriggerLedgerError::DuplicateIdempotencyKey"
        );
        assert!(!error.to_string().contains("private-slot"));
        assert!(!format!("{error:?}").contains("private-slot"));
    }
}
