use std::{collections::{BTreeMap, BTreeSet}, fmt};

use super::{
    Delivery, DeliveryId, DeliveryRequest, DeliveryRequestError, DeliverySnapshot,
    RestoreDeliveryError,
};

#[derive(Clone, Default)]
pub struct DeliveryLedger {
    deliveries: BTreeMap<DeliveryId, Delivery>,
    delivery_ids_by_idempotency_key: BTreeMap<String, DeliveryId>,
    delivery_ids_by_run: BTreeMap<String, BTreeSet<DeliveryId>>,
    undo: Option<BTreeMap<DeliveryId, Option<Delivery>>>,
}

impl PartialEq for DeliveryLedger {
    fn eq(&self, other: &Self) -> bool {
        self.deliveries == other.deliveries
            && self.delivery_ids_by_idempotency_key == other.delivery_ids_by_idempotency_key
    }
}
impl Eq for DeliveryLedger {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RegisterOutcome {
    Recorded(Delivery),
    Replayed(Delivery),
    ConflictingIdempotencyKey,
    ConflictingDeliveryId { delivery_id: DeliveryId },
}

#[derive(Clone, Eq, PartialEq)]
pub struct DeliveryLedgerSnapshot {
    deliveries: Vec<DeliverySnapshot>,
}

impl fmt::Debug for DeliveryLedger {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeliveryLedger")
            .field("delivery_count", &self.deliveries.len())
            .finish()
    }
}

impl fmt::Debug for DeliveryLedgerSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeliveryLedgerSnapshot")
            .field("delivery_count", &self.deliveries.len())
            .finish()
    }
}

impl DeliveryLedgerSnapshot {
    pub fn new(deliveries: Vec<DeliverySnapshot>) -> Self {
        Self { deliveries }
    }

    pub fn deliveries(&self) -> &[DeliverySnapshot] {
        &self.deliveries
    }

    fn into_deliveries(self) -> Vec<DeliverySnapshot> {
        self.deliveries
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum RestoreLedgerError {
    InvalidDelivery(RestoreDeliveryError),
    DuplicateDeliveryId(DeliveryId),
    DuplicateIdempotencyKey(String),
}

impl fmt::Debug for RestoreLedgerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDelivery(error) => formatter
                .debug_tuple("InvalidDelivery")
                .field(error)
                .finish(),
            Self::DuplicateDeliveryId(_) => formatter.write_str("DuplicateDeliveryId"),
            Self::DuplicateIdempotencyKey(_) => formatter.write_str("DuplicateIdempotencyKey"),
        }
    }
}

impl DeliveryLedger {
    pub fn snapshot(&self) -> DeliveryLedgerSnapshot {
        DeliveryLedgerSnapshot::new(self.deliveries.values().map(Delivery::snapshot).collect())
    }

    pub fn restore(snapshot: DeliveryLedgerSnapshot) -> Result<Self, RestoreLedgerError> {
        let mut ledger = Self::default();
        for snapshot in snapshot.into_deliveries() {
            let delivery =
                Delivery::restore(snapshot).map_err(RestoreLedgerError::InvalidDelivery)?;
            ledger.insert_restored(delivery)?;
        }
        Ok(ledger)
    }

    pub(crate) fn from_restored(
        deliveries: impl IntoIterator<Item = Delivery>,
    ) -> Result<Self, RestoreLedgerError> {
        let mut ledger = Self::default();
        for delivery in deliveries {
            ledger.insert_restored(delivery)?;
        }
        Ok(ledger)
    }

    fn insert_restored(&mut self, delivery: Delivery) -> Result<(), RestoreLedgerError> {
        let facts = delivery.facts();
        if self.deliveries.contains_key(&facts.delivery_id) {
            return Err(RestoreLedgerError::DuplicateDeliveryId(facts.delivery_id.clone()));
        }
        if self.delivery_ids_by_idempotency_key.contains_key(&facts.idempotency_key) {
            return Err(RestoreLedgerError::DuplicateIdempotencyKey(facts.idempotency_key.clone()));
        }
        self.delivery_ids_by_idempotency_key.insert(facts.idempotency_key.clone(), facts.delivery_id.clone());
        self.delivery_ids_by_run.entry(facts.run_id.clone()).or_default().insert(facts.delivery_id.clone());
        self.deliveries.insert(facts.delivery_id.clone(), delivery);
        Ok(())
    }

    pub(crate) fn validate(&self) -> Result<(), RestoreLedgerError> {
        let mut ids = std::collections::BTreeSet::new();
        let mut keys = std::collections::BTreeSet::new();
        for delivery in self.deliveries() {
            delivery.validate_restored().map_err(RestoreLedgerError::InvalidDelivery)?;
            let facts = delivery.facts();
            if !ids.insert(&facts.delivery_id) {
                return Err(RestoreLedgerError::DuplicateDeliveryId(facts.delivery_id.clone()));
            }
            if !keys.insert(&facts.idempotency_key) {
                return Err(RestoreLedgerError::DuplicateIdempotencyKey(facts.idempotency_key.clone()));
            }
        }
        Ok(())
    }

    pub fn register(
        &mut self,
        request: DeliveryRequest,
    ) -> Result<RegisterOutcome, DeliveryRequestError> {
        request.validate()?;
        if let Some(delivery_id) = self
            .delivery_ids_by_idempotency_key
            .get(&request.idempotency_key)
        {
            let existing = self
                .deliveries
                .get(delivery_id)
                .expect("idempotency key index always references a delivery");
            return Ok(if existing.facts() == &request {
                RegisterOutcome::Replayed(existing.clone())
            } else {
                RegisterOutcome::ConflictingIdempotencyKey
            });
        }
        if self.deliveries.contains_key(&request.delivery_id) {
            return Ok(RegisterOutcome::ConflictingDeliveryId {
                delivery_id: request.delivery_id,
            });
        }

        let delivery = Delivery::request(request)?;
        if let Some(undo) = &mut self.undo {
            undo.entry(delivery.facts().delivery_id.clone())
                .or_insert(None);
        }
        self.delivery_ids_by_idempotency_key.insert(
            delivery.facts().idempotency_key.clone(),
            delivery.facts().delivery_id.clone(),
        );
        self.delivery_ids_by_run.entry(delivery.facts().run_id.clone()).or_default()
            .insert(delivery.facts().delivery_id.clone());
        self.deliveries
            .insert(delivery.facts().delivery_id.clone(), delivery.clone());
        Ok(RegisterOutcome::Recorded(delivery))
    }

    pub fn delivery(&self, delivery_id: &DeliveryId) -> Option<&Delivery> {
        self.deliveries.get(delivery_id)
    }

    pub(crate) fn delivery_by_idempotency_key(&self, key: &str) -> Option<&Delivery> {
        self.delivery_ids_by_idempotency_key
            .get(key)
            .and_then(|delivery_id| self.deliveries.get(delivery_id))
    }

    pub fn delivery_mut(&mut self, delivery_id: &DeliveryId) -> Option<&mut Delivery> {
        let delivery = self.deliveries.get_mut(delivery_id)?;
        if let Some(undo) = &mut self.undo {
            undo.entry(delivery_id.clone())
                .or_insert_with(|| Some(delivery.clone()));
        }
        Some(delivery)
    }

    pub(crate) fn restore_record(&mut self, delivery: Delivery) -> Result<(), RestoreLedgerError> {
        let id = delivery.facts().delivery_id.clone();
        let key = delivery.facts().idempotency_key.clone();
        if self
            .delivery_ids_by_idempotency_key
            .get(&key)
            .is_some_and(|existing| existing != &id)
        {
            return Err(RestoreLedgerError::DuplicateIdempotencyKey(key));
        }
        self.remove_record(&id);
        if let Some(undo) = &mut self.undo {
            undo.entry(id.clone()).or_insert(None);
        }
        self.delivery_ids_by_idempotency_key.insert(key, id.clone());
        self.delivery_ids_by_run.entry(delivery.facts().run_id.clone()).or_default().insert(id.clone());
        self.deliveries.insert(id, delivery);
        Ok(())
    }

    pub(crate) fn remove_record(&mut self, id: &DeliveryId) {
        if let Some(delivery) = self.deliveries.remove(id) {
            self.delivery_ids_by_idempotency_key
                .remove(&delivery.facts().idempotency_key);
            if let Some(ids) = self.delivery_ids_by_run.get_mut(&delivery.facts().run_id) {
                ids.remove(id);
                if ids.is_empty() { self.delivery_ids_by_run.remove(&delivery.facts().run_id); }
            }
            if let Some(undo) = &mut self.undo {
                undo.entry(id.clone()).or_insert(Some(delivery));
            }
        }
    }

    pub(crate) fn begin_transaction(&mut self) {
        assert!(self.undo.is_none(), "delivery transaction already active");
        self.undo = Some(BTreeMap::new());
    }

    pub(crate) fn previous(&self, id: &DeliveryId) -> Option<&Delivery> {
        self.undo.as_ref()?.get(id)?.as_ref()
    }

    pub(crate) fn changed_ids(&self) -> impl Iterator<Item = &DeliveryId> {
        self.undo.iter().flat_map(|undo| undo.keys())
    }

    pub(crate) fn commit_transaction(&mut self) {
        self.undo = None;
    }

    pub(crate) fn rollback_transaction(&mut self) {
        let Some(undo) = self.undo.take() else { return; };
        // Remove all final identities before restoring keys reused inside the transaction.
        for id in undo.keys() { self.remove_record(id); }
        for delivery in undo.into_values().flatten() {
            self.restore_record(delivery).expect("previous delivery keys are unique");
        }
    }

    pub fn deliveries(&self) -> impl Iterator<Item = &Delivery> {
        self.deliveries.values()
    }

    pub(crate) fn deliveries_for_run(&self, run_id: &str) -> impl Iterator<Item = &Delivery> {
        self.delivery_ids_by_run.get(run_id).into_iter().flatten()
            .map(|id| self.deliveries.get(id).expect("delivery Run index references its delivery"))
    }

    pub(crate) fn retain_without_run(&mut self, run_id: &str) {
        let ids = self.deliveries_for_run(run_id)
            .map(|delivery| delivery.facts().delivery_id.clone()).collect::<Vec<_>>();
        for id in ids { self.remove_record(&id); }
    }
}
