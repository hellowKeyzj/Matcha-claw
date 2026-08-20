use std::{collections::BTreeMap, fmt};

use super::{
    Delivery, DeliveryId, DeliveryRequest, DeliveryRequestError, DeliverySnapshot,
    RestoreDeliveryError,
};

#[derive(Clone, Default, Eq, PartialEq)]
pub struct DeliveryLedger {
    deliveries: BTreeMap<DeliveryId, Delivery>,
    delivery_ids_by_idempotency_key: BTreeMap<String, DeliveryId>,
}

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
            let facts = delivery.facts();
            if ledger.deliveries.contains_key(&facts.delivery_id) {
                return Err(RestoreLedgerError::DuplicateDeliveryId(
                    facts.delivery_id.clone(),
                ));
            }
            if ledger
                .delivery_ids_by_idempotency_key
                .contains_key(&facts.idempotency_key)
            {
                return Err(RestoreLedgerError::DuplicateIdempotencyKey(
                    facts.idempotency_key.clone(),
                ));
            }
            ledger
                .delivery_ids_by_idempotency_key
                .insert(facts.idempotency_key.clone(), facts.delivery_id.clone());
            ledger
                .deliveries
                .insert(facts.delivery_id.clone(), delivery);
        }
        Ok(ledger)
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
        self.delivery_ids_by_idempotency_key.insert(
            delivery.facts().idempotency_key.clone(),
            delivery.facts().delivery_id.clone(),
        );
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
        self.deliveries.get_mut(delivery_id)
    }

    pub fn deliveries(&self) -> impl Iterator<Item = &Delivery> {
        self.deliveries.values()
    }

    pub(crate) fn retain_without_run(&mut self, run_id: &str) {
        self.deliveries
            .retain(|_, delivery| delivery.facts().run_id != run_id);
        self.delivery_ids_by_idempotency_key
            .retain(|_, delivery_id| self.deliveries.contains_key(delivery_id));
    }
}
