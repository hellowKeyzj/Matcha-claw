use std::{collections::BTreeMap, fmt};

use super::{
    Activity, ActivityId, ActivityRequest, ActivityRequestError, ActivitySnapshot,
    RestoreActivityError,
};

#[derive(Clone, Default)]
pub struct ActivityLedger {
    activities: BTreeMap<ActivityId, Activity>,
    activity_ids_by_run_and_idempotency_key: BTreeMap<(String, String), ActivityId>,
    undo: Option<BTreeMap<ActivityId, Option<Activity>>>,
}

impl PartialEq for ActivityLedger {
    fn eq(&self, other: &Self) -> bool {
        self.activities == other.activities
            && self.activity_ids_by_run_and_idempotency_key
                == other.activity_ids_by_run_and_idempotency_key
    }
}
impl Eq for ActivityLedger {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActivityRegistrationOutcome {
    Recorded(Activity),
    Replayed(Activity),
    ConflictingIdempotencyKey,
    ConflictingActivityId { activity_id: ActivityId },
}

#[derive(Clone, Eq, PartialEq)]
pub struct ActivityLedgerSnapshot {
    activities: Vec<ActivitySnapshot>,
}

impl fmt::Debug for ActivityLedger {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActivityLedger")
            .field("activity_count", &self.activities.len())
            .finish()
    }
}

impl fmt::Debug for ActivityLedgerSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActivityLedgerSnapshot")
            .field("activity_count", &self.activities.len())
            .finish()
    }
}

impl ActivityLedgerSnapshot {
    pub fn new(activities: Vec<ActivitySnapshot>) -> Self {
        Self { activities }
    }

    pub fn activities(&self) -> &[ActivitySnapshot] {
        &self.activities
    }

    fn into_activities(self) -> Vec<ActivitySnapshot> {
        self.activities
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum RestoreActivityLedgerError {
    InvalidActivity(RestoreActivityError),
    DuplicateActivityId(ActivityId),
    DuplicateIdempotencyKey,
}

impl fmt::Debug for RestoreActivityLedgerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidActivity(error) => formatter
                .debug_tuple("InvalidActivity")
                .field(error)
                .finish(),
            Self::DuplicateActivityId(_) => formatter.write_str("DuplicateActivityId"),
            Self::DuplicateIdempotencyKey => formatter.write_str("DuplicateIdempotencyKey"),
        }
    }
}

impl ActivityLedger {
    pub fn snapshot(&self) -> ActivityLedgerSnapshot {
        ActivityLedgerSnapshot::new(self.activities.values().map(Activity::snapshot).collect())
    }

    pub fn restore(snapshot: ActivityLedgerSnapshot) -> Result<Self, RestoreActivityLedgerError> {
        let mut ledger = Self::default();
        for snapshot in snapshot.into_activities() {
            let activity =
                Activity::restore(snapshot).map_err(RestoreActivityLedgerError::InvalidActivity)?;
            let facts = activity.facts();
            if ledger.activities.contains_key(&facts.activity_id) {
                return Err(RestoreActivityLedgerError::DuplicateActivityId(
                    facts.activity_id.clone(),
                ));
            }
            let key = activity_key(facts);
            if ledger
                .activity_ids_by_run_and_idempotency_key
                .contains_key(&key)
            {
                return Err(RestoreActivityLedgerError::DuplicateIdempotencyKey);
            }
            ledger
                .activity_ids_by_run_and_idempotency_key
                .insert(key, facts.activity_id.clone());
            ledger
                .activities
                .insert(facts.activity_id.clone(), activity);
        }
        Ok(ledger)
    }

    pub fn register(
        &mut self,
        request: ActivityRequest,
    ) -> Result<ActivityRegistrationOutcome, ActivityRequestError> {
        request.validate()?;
        let key = activity_key(&request);
        if let Some(activity_id) = self.activity_ids_by_run_and_idempotency_key.get(&key) {
            let existing = self
                .activities
                .get(activity_id)
                .expect("idempotency key index always references an activity");
            return Ok(if existing.facts() == &request {
                ActivityRegistrationOutcome::Replayed(existing.clone())
            } else {
                ActivityRegistrationOutcome::ConflictingIdempotencyKey
            });
        }
        if self.activities.contains_key(&request.activity_id) {
            return Ok(ActivityRegistrationOutcome::ConflictingActivityId {
                activity_id: request.activity_id,
            });
        }

        let activity = Activity::request(request)?;
        if let Some(undo) = &mut self.undo {
            undo.entry(activity.facts().activity_id.clone())
                .or_insert(None);
        }
        self.activity_ids_by_run_and_idempotency_key.insert(
            activity_key(activity.facts()),
            activity.facts().activity_id.clone(),
        );
        self.activities
            .insert(activity.facts().activity_id.clone(), activity.clone());
        Ok(ActivityRegistrationOutcome::Recorded(activity))
    }

    pub fn activity(&self, activity_id: &ActivityId) -> Option<&Activity> {
        self.activities.get(activity_id)
    }

    pub fn activity_by_idempotency_key(
        &self,
        run_id: &str,
        idempotency_key: &str,
    ) -> Option<&Activity> {
        self.activity_ids_by_run_and_idempotency_key
            .get(&(run_id.to_owned(), idempotency_key.to_owned()))
            .and_then(|activity_id| self.activities.get(activity_id))
    }

    pub fn activity_mut(&mut self, activity_id: &ActivityId) -> Option<&mut Activity> {
        let activity = self.activities.get_mut(activity_id)?;
        if let Some(undo) = &mut self.undo {
            undo.entry(activity_id.clone())
                .or_insert_with(|| Some(activity.clone()));
        }
        Some(activity)
    }

    pub(crate) fn restore_record(
        &mut self,
        activity: Activity,
    ) -> Result<(), RestoreActivityLedgerError> {
        let id = activity.facts().activity_id.clone();
        let key = activity_key(activity.facts());
        if self
            .activity_ids_by_run_and_idempotency_key
            .get(&key)
            .is_some_and(|existing| existing != &id)
        {
            return Err(RestoreActivityLedgerError::DuplicateIdempotencyKey);
        }
        self.remove_record(&id);
        if let Some(undo) = &mut self.undo {
            undo.entry(id.clone()).or_insert(None);
        }
        self.activity_ids_by_run_and_idempotency_key
            .insert(key, id.clone());
        self.activities.insert(id, activity);
        Ok(())
    }

    pub(crate) fn remove_record(&mut self, id: &ActivityId) {
        if let Some(activity) = self.activities.remove(id) {
            self.activity_ids_by_run_and_idempotency_key
                .remove(&activity_key(activity.facts()));
            if let Some(undo) = &mut self.undo {
                undo.entry(id.clone()).or_insert(Some(activity));
            }
        }
    }

    pub(crate) fn begin_transaction(&mut self) {
        assert!(self.undo.is_none(), "activity transaction already active");
        self.undo = Some(BTreeMap::new());
    }

    pub(crate) fn previous(&self, id: &ActivityId) -> Option<&Activity> {
        self.undo.as_ref()?.get(id)?.as_ref()
    }

    pub(crate) fn changed_ids(&self) -> impl Iterator<Item = &ActivityId> {
        self.undo.iter().flat_map(|undo| undo.keys())
    }

    pub(crate) fn commit_transaction(&mut self) {
        self.undo = None;
    }

    pub(crate) fn rollback_transaction(&mut self) {
        for (id, previous) in self.undo.take().into_iter().flatten() {
            if let Some(current) = self.activities.remove(&id) {
                self.activity_ids_by_run_and_idempotency_key
                    .remove(&activity_key(current.facts()));
            }
            if let Some(activity) = previous {
                self.activity_ids_by_run_and_idempotency_key
                    .insert(activity_key(activity.facts()), id.clone());
                self.activities.insert(id, activity);
            }
        }
    }

    pub fn activities(&self) -> impl Iterator<Item = &Activity> {
        self.activities.values()
    }

    pub fn retain_without_run(&mut self, run_id: &str) {
        self.activities.retain(|id, activity| {
            if activity.facts().run_id.as_str() != run_id {
                return true;
            }
            if let Some(undo) = &mut self.undo {
                undo.entry(id.clone())
                    .or_insert_with(|| Some(activity.clone()));
            }
            false
        });
        self.activity_ids_by_run_and_idempotency_key
            .retain(|_, activity_id| self.activities.contains_key(activity_id));
    }
}

fn activity_key(request: &ActivityRequest) -> (String, String) {
    (
        request.run_id.as_str().to_owned(),
        request.idempotency_key.clone(),
    )
}
