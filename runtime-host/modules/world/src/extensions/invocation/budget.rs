use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::time::Instant;
use world_protocol::{
    budget::{Budget, BudgetDimension, Cost, Usage},
    ids::CommitId,
    time::{DurationMs, Timestamp},
};

#[derive(Clone, Copy, Debug)]
pub(crate) struct BudgetFailure {
    pub dimension: BudgetDimension,
}

#[derive(Clone, Debug)]
pub(crate) enum ReservationFailure {
    Budget(BudgetFailure),
    IdentityConflict(CommitId),
}

struct Reservation {
    scopes: Vec<usize>,
    usage: Usage,
    phase: ReservationPhase,
    observed: Option<CommitId>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ReservationPhase {
    Pending,
    Committed,
    Actual,
    Acknowledged,
    Released,
}

/// Scopes charge the same root account and every ancestor. A provider's local
/// cap cannot lower a sibling's allowance or reset the invocation's clock.
#[derive(Clone)]
pub(crate) struct CallBudget {
    inner: Arc<Accounting>,
    scopes: Vec<usize>,
    checkpoint_scope: usize,
}
struct Accounting {
    started: Instant,
    state: Mutex<Accounts>,
}
struct Accounts {
    scopes: Vec<Scope>,
    reservations: BTreeMap<CommitId, Reservation>,
    failure: Option<BudgetFailure>,
}
struct Scope {
    limit: Budget,
    deadline: Instant,
    deadline_dimension: BudgetDimension,
    usage: Usage,
    checkpoint: Usage,
    pending: Usage,
    run: Option<RunScope>,
}
struct RunScope {
    commit: CommitId,
    parent: Vec<usize>,
    limit: Budget,
}

impl CallBudget {
    pub fn new(limit: Budget, now: &Timestamp) -> Result<Self, BudgetFailure> {
        Self::resume(limit, empty_usage(), now)
    }

    pub fn resume(limit: Budget, used: Usage, now: &Timestamp) -> Result<Self, BudgetFailure> {
        let value = Self::resume_for_settlement(limit, used, now)?;
        value.check()?;
        Ok(value)
    }

    /// Reconstructs the original expired account for identity-bound cleanup, not new work.
    pub fn resume_for_settlement(limit: Budget, used: Usage, now: &Timestamp) -> Result<Self, BudgetFailure> {
        let started = Instant::now()
            .checked_sub(Duration::from_millis(used.elapsed.0))
            .ok_or(BudgetFailure {
                dimension: BudgetDimension::WallTime,
            })?;
        let (deadline, deadline_dimension) = deadline(&limit, started, now)?;
        let value = Self {
            inner: Arc::new(Accounting {
                started,
                state: Mutex::new(Accounts {
                    scopes: vec![Scope {
                        limit,
                        deadline,
                        deadline_dimension,
                        checkpoint: used.clone(),
                        usage: used,
                        pending: empty_usage(),
                        run: None,
                    }],
                    reservations: BTreeMap::new(),
                    failure: None,
                }),
            }),
            scopes: vec![0],
            checkpoint_scope: 0,
        };
        Ok(value)
    }

    pub fn scoped(&self, limit: &Budget, now: &Timestamp) -> Result<Self, BudgetFailure> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        self.check_locked(&mut state)?;
        self.scoped_locked(&mut state, limit, now)
    }

    /// A distinct durable Run shares live ancestor charges but owns its checkpoint anchor.
    pub fn run_scoped(
        &self, commit: &CommitId, limit: &Budget, used: &Usage, now: &Timestamp,
    ) -> Result<Self, ReservationFailure> {
        let mut state = self.inner.state.lock().expect("world call accounting poisoned");
        self.check_locked(&mut state).map_err(ReservationFailure::Budget)?;
        if let Some(id) = state.scopes.iter().position(|scope| {
            scope.run.as_ref().is_some_and(|run| &run.commit == commit)
        }) {
            let scope = &state.scopes[id];
            let run = scope.run.as_ref().expect("matched run scope");
            if run.parent != self.scopes || &run.limit != limit
                || exceeded_allowance(used, &scope.usage).is_some()
                || (used.cost.is_some() && scope.usage.cost.is_none())
                || used.elapsed.0 > u64::try_from(self.inner.started.elapsed().as_millis()).unwrap_or(u64::MAX)
            {
                return Err(ReservationFailure::IdentityConflict(commit.clone()));
            }
            let mut scopes = self.scopes.clone();
            scopes.push(id);
            let value = Self { inner: self.inner.clone(), scopes, checkpoint_scope: id };
            value.check_locked(&mut state).map_err(ReservationFailure::Budget)?;
            return Ok(value);
        }
        if used != &empty_usage() || state.reservations.contains_key(commit) {
            return Err(ReservationFailure::IdentityConflict(commit.clone()));
        }
        let mut value = self.scoped_locked(&mut state, limit, now)
            .map_err(ReservationFailure::Budget)?;
        let id = *value.scopes.last().expect("run scope");
        state.scopes[id].run = Some(RunScope {
            commit: commit.clone(), parent: self.scopes.clone(), limit: limit.clone(),
        });
        value.checkpoint_scope = id;
        Ok(value)
    }

    fn scoped_locked(&self, state: &mut Accounts, limit: &Budget, now: &Timestamp) -> Result<Self, BudgetFailure> {
        let mut effective = state.scopes[0].limit.clone();
        for id in &self.scopes {
            if let Err(error) = intersect(&mut effective, &state.scopes[*id].limit) {
                return fail(state, error.dimension);
            }
        }
        if let Err(error) = intersect(&mut effective, limit) {
            return fail(state, error.dimension);
        }
        let (local, dimension) = match deadline(&effective, self.inner.started, now) {
            Ok(value) => value,
            Err(error) => return fail(state, error.dimension),
        };
        let parent = self
            .scopes
            .iter()
            .map(|id| state.scopes[*id].deadline)
            .min()
            .expect("root scope");
        if Instant::now() >= local.min(parent) {
            return fail(state, dimension);
        }
        let id = state.scopes.len();
        state.scopes.push(Scope {
            limit: effective,
            deadline: local.min(parent),
            deadline_dimension: dimension,
            usage: empty_usage(),
            checkpoint: empty_usage(),
            pending: empty_usage(),
            run: None,
        });
        let mut scopes = self.scopes.clone();
        scopes.push(id);
        Ok(Self {
            inner: self.inner.clone(),
            scopes,
            checkpoint_scope: self.checkpoint_scope,
        })
    }

    /// A reservation consumes availability, not usage. Dropping its observer changes nothing.
    pub fn reserve(&self, commit: &CommitId, usage: Usage) -> Result<(), ReservationFailure> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        if usage.elapsed.0 != 0 {
            return Err(ReservationFailure::IdentityConflict(commit.clone()));
        }
        if let Some(previous) = state.reservations.get(commit) {
            if previous.scopes != self.scopes
                || previous.usage != usage
                || (previous.phase == ReservationPhase::Released && previous.observed.is_some())
                || matches!(
                    previous.phase,
                    ReservationPhase::Actual | ReservationPhase::Acknowledged
                )
            {
                return Err(ReservationFailure::IdentityConflict(commit.clone()));
            }
            if previous.phase != ReservationPhase::Released {
                return Ok(());
            }
        }
        if let Some(failure) = state.failure {
            return Err(ReservationFailure::Budget(failure));
        }
        let mut pending = Vec::with_capacity(self.scopes.len());
        for id in &self.scopes {
            let scope = &state.scopes[*id];
            let next = add_usage(&scope.pending, &usage).map_err(ReservationFailure::Budget)?;
            let total = add_usage(&scope.usage, &next).map_err(ReservationFailure::Budget)?;
            check_scope(scope, &total).map_err(ReservationFailure::Budget)?;
            pending.push((*id, next));
        }
        for (id, pending) in pending {
            state.scopes[id].pending = pending;
        }
        state.reservations.insert(
            commit.clone(),
            Reservation {
                scopes: self.scopes.clone(),
                usage,
                phase: ReservationPhase::Pending,
                observed: None,
            },
        );
        Ok(())
    }

    /// Rehydrates only a confirmed original allowance; never admission for new work.
    pub fn restore_reserved(
        &self,
        commit: &CommitId,
        usage: Usage,
    ) -> Result<(), ReservationFailure> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        if usage.elapsed.0 != 0 {
            return Err(ReservationFailure::IdentityConflict(commit.clone()));
        }
        if let Some(previous) = state.reservations.get(commit) {
            if previous.scopes != self.scopes
                || previous.usage != usage
                || !matches!(
                    previous.phase,
                    ReservationPhase::Pending | ReservationPhase::Released
                )
            {
                return Err(ReservationFailure::IdentityConflict(commit.clone()));
            }
            return Ok(());
        }
        for id in &self.scopes {
            if let Some(dimension) = record_usage(&mut state.scopes[*id].pending, &usage) {
                state.failure.get_or_insert(BudgetFailure { dimension });
            }
        }
        state.reservations.insert(
            commit.clone(),
            Reservation {
                scopes: self.scopes.clone(),
                usage,
                phase: ReservationPhase::Pending,
                observed: None,
            },
        );
        let _ = self.check_locked(&mut state);
        Ok(())
    }

    /// Restores an already-checkpointed lower bound, never charges it again.
    pub fn restore_partial(
        &self,
        allowance: &CommitId,
        commit: &CommitId,
        allowance_usage: Usage,
        observed_usage: Usage,
    ) -> Result<(), ReservationFailure> {
        let mut state = self.inner.state.lock().expect("world call accounting poisoned");
        if allowance == commit || allowance_usage.elapsed.0 != 0 || observed_usage.elapsed.0 != 0 {
            return Err(ReservationFailure::IdentityConflict(commit.clone()));
        }
        if let Some(previous) = state.reservations.get(allowance) {
            if previous.scopes != self.scopes || previous.usage != allowance_usage
                || previous.phase != ReservationPhase::Pending
                || previous.observed.as_ref() != Some(commit)
            {
                return Err(ReservationFailure::IdentityConflict(allowance.clone()));
            }
            let actual = state.reservations.get(commit)
                .ok_or_else(|| ReservationFailure::IdentityConflict(commit.clone()))?;
            if actual.scopes != self.scopes || actual.usage != observed_usage
                || actual.observed.as_ref() != Some(allowance)
                || !matches!(actual.phase, ReservationPhase::Actual | ReservationPhase::Acknowledged)
            {
                return Err(ReservationFailure::IdentityConflict(commit.clone()));
            }
            drop(state);
            return self.ack_actual(commit);
        }
        if state.reservations.contains_key(commit)
            || self.scopes.iter().any(|id| {
                let checkpoint = &state.scopes[*id].checkpoint;
                exceeded_allowance(&observed_usage, checkpoint).is_some()
                    || (observed_usage.cost.is_some() && checkpoint.cost.is_none())
            })
        {
            return Err(ReservationFailure::IdentityConflict(commit.clone()));
        }
        let exceeded = exceeded_allowance(&observed_usage, &allowance_usage);
        state.reservations.insert(allowance.clone(), Reservation {
            scopes: self.scopes.clone(), usage: allowance_usage, phase: ReservationPhase::Pending,
            observed: Some(commit.clone()),
        });
        state.reservations.insert(commit.clone(), Reservation {
            scopes: self.scopes.clone(), usage: observed_usage, phase: ReservationPhase::Acknowledged,
            observed: Some(allowance.clone()),
        });
        rebuild_pending(&mut state, &self.scopes);
        if let Some(dimension) = exceeded {
            state.failure.get_or_insert(BudgetFailure { dimension });
        }
        let _ = self.check_locked(&mut state);
        Ok(())
    }

    /// Only an authoritative outcome for the original commit may settle its reservation.
    /// Actual committed consumption is recorded even after a sticky failure or deadline.
    pub fn commit_reserved(&self, commit: &CommitId) -> Result<(), ReservationFailure> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        let reservation = state
            .reservations
            .get(commit)
            .ok_or_else(|| ReservationFailure::IdentityConflict(commit.clone()))?;
        if reservation.scopes != self.scopes
            || reservation.observed.is_some()
            || !matches!(
                reservation.phase,
                ReservationPhase::Pending | ReservationPhase::Committed
            )
        {
            return Err(ReservationFailure::IdentityConflict(commit.clone()));
        }
        if reservation.phase == ReservationPhase::Committed {
            return Ok(());
        }
        let usage = reservation.usage.clone();
        let scopes = reservation.scopes.clone();
        for id in &scopes {
            if let Some(dimension) = record_charge(&mut state.scopes[*id], &usage) {
                state.failure.get_or_insert(BudgetFailure { dimension });
            }
        }
        state
            .reservations
            .get_mut(commit)
            .expect("validated reservation")
            .phase = ReservationPhase::Committed;
        rebuild_pending(&mut state, &scopes);
        self.check_locked(&mut state)
            .map_err(ReservationFailure::Budget)
    }

    /// Records already-consumed work once, without an availability precheck.
    /// The original commit identifies consumption even when its SQL outcome is unknown.
    pub fn record_actual(&self, commit: &CommitId, usage: Usage) -> Result<(), ReservationFailure> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        if usage.elapsed.0 != 0 {
            return Err(ReservationFailure::IdentityConflict(commit.clone()));
        }
        if let Some(previous) = state.reservations.get(commit) {
            if previous.scopes != self.scopes
                || previous.usage != usage
                || !matches!(
                    previous.phase,
                    ReservationPhase::Actual | ReservationPhase::Acknowledged
                )
            {
                return Err(ReservationFailure::IdentityConflict(commit.clone()));
            }
            return self
                .check_locked(&mut state)
                .map_err(ReservationFailure::Budget);
        }
        for id in &self.scopes {
            if let Some(dimension) = record_usage(&mut state.scopes[*id].usage, &usage) {
                state.failure.get_or_insert(BudgetFailure { dimension });
            }
        }
        state.reservations.insert(
            commit.clone(),
            Reservation {
                scopes: self.scopes.clone(),
                usage,
                phase: ReservationPhase::Actual,
                observed: None,
            },
        );
        self.check_locked(&mut state)
            .map_err(ReservationFailure::Budget)
    }

    /// Keeps the unknown part of the original allowance without charging its observed part twice.
    pub fn record_partial(
        &self,
        allowance: &CommitId,
        commit: &CommitId,
        usage: Usage,
    ) -> Result<(), ReservationFailure> {
        self.record_settlement(allowance, commit, usage, false)
    }

    /// Full coverage releases the original allowance; actual consumption remains charged once.
    pub fn settle_actual(
        &self,
        allowance: &CommitId,
        commit: &CommitId,
        usage: Usage,
    ) -> Result<(), ReservationFailure> {
        self.record_settlement(allowance, commit, usage, true)
    }

    fn record_settlement(
        &self,
        allowance: &CommitId,
        commit: &CommitId,
        usage: Usage,
        complete: bool,
    ) -> Result<(), ReservationFailure> {
        let mut state = self.inner.state.lock().expect("world call accounting poisoned");
        if allowance == commit || usage.elapsed.0 != 0 {
            return Err(ReservationFailure::IdentityConflict(commit.clone()));
        }
        let bound = state.reservations.get(allowance)
            .ok_or_else(|| ReservationFailure::IdentityConflict(allowance.clone()))?;
        if bound.scopes != self.scopes
            || !matches!(bound.phase, ReservationPhase::Pending | ReservationPhase::Released)
            || bound.observed.as_ref().is_some_and(|previous| previous != commit)
            || (bound.phase == ReservationPhase::Released && (!complete || bound.observed.as_ref() != Some(commit)))
        {
            return Err(ReservationFailure::IdentityConflict(allowance.clone()));
        }
        let missing_cost = complete && bound.usage.cost.is_some() && usage.cost.is_none();
        let exceeded = exceeded_allowance(&usage, &bound.usage)
            .or(missing_cost.then_some(BudgetDimension::Cost));
        let recorded = if let Some(previous) = state.reservations.get(commit) {
            if previous.scopes != self.scopes || previous.usage != usage
                || previous.observed.as_ref() != Some(allowance)
                || !matches!(previous.phase, ReservationPhase::Actual | ReservationPhase::Acknowledged)
            {
                return Err(ReservationFailure::IdentityConflict(commit.clone()));
            }
            true
        } else {
            false
        };
        let bound = state.reservations.get_mut(allowance).expect("validated allowance");
        bound.observed = Some(commit.clone());
        if complete && !missing_cost {
            bound.phase = ReservationPhase::Released;
        }
        if !recorded {
            for id in &self.scopes {
                if let Some(dimension) = record_usage(&mut state.scopes[*id].usage, &usage) {
                    state.failure.get_or_insert(BudgetFailure { dimension });
                }
            }
            state.reservations.insert(commit.clone(), Reservation {
                scopes: self.scopes.clone(), usage, phase: ReservationPhase::Actual,
                observed: Some(allowance.clone()),
            });
        }
        rebuild_pending(&mut state, &self.scopes);
        if let Some(dimension) = exceeded {
            state.failure.get_or_insert(BudgetFailure { dimension });
        }
        self.check_locked(&mut state).map_err(ReservationFailure::Budget)
    }

    /// Only the confirmed receipt for the original finish makes its actual delta checkpointable.
    pub fn ack_actual(&self, commit: &CommitId) -> Result<(), ReservationFailure> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        let reservation = state
            .reservations
            .get(commit)
            .ok_or_else(|| ReservationFailure::IdentityConflict(commit.clone()))?;
        if reservation.scopes != self.scopes
            || !matches!(
                reservation.phase,
                ReservationPhase::Actual | ReservationPhase::Acknowledged
            )
        {
            return Err(ReservationFailure::IdentityConflict(commit.clone()));
        }
        if reservation.phase == ReservationPhase::Acknowledged {
            return Ok(());
        }
        let usage = reservation.usage.clone();
        let scopes = reservation.scopes.clone();
        for id in &scopes {
            if let Some(dimension) = record_usage(&mut state.scopes[*id].checkpoint, &usage) {
                state.failure.get_or_insert(BudgetFailure { dimension });
            }
        }
        state
            .reservations
            .get_mut(commit)
            .expect("validated actual consumption")
            .phase = ReservationPhase::Acknowledged;
        Ok(())
    }

    pub fn release_reserved(&self, commit: &CommitId) -> Result<(), ReservationFailure> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        let reservation = state
            .reservations
            .get_mut(commit)
            .ok_or_else(|| ReservationFailure::IdentityConflict(commit.clone()))?;
        if reservation.scopes != self.scopes
            || reservation.observed.is_some()
            || !matches!(
                reservation.phase,
                ReservationPhase::Pending | ReservationPhase::Released
            )
        {
            return Err(ReservationFailure::IdentityConflict(commit.clone()));
        }
        if reservation.phase == ReservationPhase::Released {
            return Ok(());
        }
        reservation.phase = ReservationPhase::Released;
        let scopes = reservation.scopes.clone();
        rebuild_pending(&mut state, &scopes);
        Ok(())
    }

    pub fn reserved_usage(&self, commit: &CommitId) -> Option<Usage> {
        self.inner
            .state
            .lock()
            .expect("world call accounting poisoned")
            .reservations
            .get(commit)
            .filter(|reservation| reservation.scopes == self.scopes)
            .map(|reservation| reservation.usage.clone())
    }

    pub fn has_pending_reservations(&self) -> bool {
        self.inner.state.lock().expect("world call accounting poisoned")
            .reservations.values().any(|reservation| {
                reservation.phase == ReservationPhase::Pending
                    && reservation.scopes.contains(&self.checkpoint_scope)
            })
    }

    /// Restriction affects this scope only; clones of it still share the same cap.
    pub fn restrict(&self, limit: &Budget, now: &Timestamp) -> Result<(), BudgetFailure> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        self.check_locked(&mut state)?;
        let id = *self.scopes.last().expect("root scope");
        if let Err(error) = intersect(&mut state.scopes[id].limit, limit) {
            return fail(&mut state, error.dimension);
        }
        match deadline(&state.scopes[id].limit, self.inner.started, now) {
            Ok((deadline, dimension)) if deadline < state.scopes[id].deadline => {
                state.scopes[id].deadline = deadline;
                state.scopes[id].deadline_dimension = dimension;
            }
            Ok(_) => {}
            Err(error) => return fail(&mut state, error.dimension),
        }
        self.check_locked(&mut state)
    }

    pub(crate) fn same_scope(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner) && self.scopes == other.scopes
    }

    pub fn limit(&self) -> Budget {
        let state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        let mut limit = state.scopes[0].limit.clone();
        for id in &self.scopes {
            let _ = intersect(&mut limit, &state.scopes[*id].limit);
        }
        limit
    }
    pub fn deadline(&self) -> Instant {
        let state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        self.scopes
            .iter()
            .map(|id| state.scopes[*id].deadline)
            .min()
            .expect("root scope")
    }
    /// The tightest unspent allowance across this scope and every ancestor.
    pub fn remaining(&self, dimension: BudgetDimension) -> Result<u64, BudgetFailure> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        self.check_locked(&mut state)?;
        let mut remaining = u64::MAX;
        for id in &self.scopes {
            let scope = &state.scopes[*id];
            let usage = match add_usage(&scope.usage, &scope.pending) {
                Ok(usage) => usage,
                Err(error) => return fail(&mut state, error.dimension),
            };
            let (maximum, used) = match dimension {
                BudgetDimension::Steps => (scope.limit.max_steps, usage.steps),
                BudgetDimension::SourceReads => (scope.limit.max_source_reads, usage.source_reads),
                BudgetDimension::Rows => (scope.limit.max_rows, usage.rows),
                BudgetDimension::Bytes => (scope.limit.max_bytes, usage.bytes),
                BudgetDimension::ModelCalls => (scope.limit.max_model_calls, usage.model_calls),
                BudgetDimension::InputTokens => (scope.limit.max_input_tokens, usage.input_tokens),
                BudgetDimension::OutputTokens => {
                    (scope.limit.max_output_tokens, usage.output_tokens)
                }
                _ => return fail(&mut state, dimension),
            };
            remaining = remaining.min(maximum.saturating_sub(used));
        }
        Ok(remaining)
    }

    pub fn remaining_cost(&self) -> Result<Option<Cost>, BudgetFailure> {
        let mut state = self.inner.state.lock().expect("world call accounting poisoned");
        self.check_locked(&mut state)?;
        let mut remaining: Option<Cost> = None;
        for id in &self.scopes {
            let scope = &state.scopes[*id];
            let Some(maximum) = &scope.limit.max_cost else { continue; };
            let usage = add_usage(&scope.usage, &scope.pending)?;
            let amount = match usage.cost {
                Some(used) if used.currency == maximum.currency => {
                    remaining_cost(&maximum.amount, &used.amount)
                        .ok_or(BudgetFailure { dimension: BudgetDimension::Cost })?
                }
                Some(_) => return fail(&mut state, BudgetDimension::Cost),
                None => maximum.amount.clone(),
            };
            match &remaining {
                Some(previous) if previous.currency != maximum.currency => {
                    return fail(&mut state, BudgetDimension::Cost);
                }
                Some(previous) if previous.amount.cmp_numeric(&amount).is_le() => {}
                _ => remaining = Some(Cost { amount, currency: maximum.currency.clone() }),
            }
        }
        Ok(remaining)
    }

    pub fn check(&self) -> Result<(), BudgetFailure> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        self.check_locked(&mut state)
    }

    /// Actual consumption is recorded even if an earlier trap/deadline already
    /// failed the account; the first failure remains sticky.
    pub fn charge(&self, dimension: BudgetDimension, amount: u64) -> Result<(), BudgetFailure> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        let mut usage = empty_usage();
        match dimension {
            BudgetDimension::Steps => usage.steps = amount,
            BudgetDimension::SourceReads => usage.source_reads = amount,
            BudgetDimension::Rows => usage.rows = amount,
            BudgetDimension::Bytes => usage.bytes = amount,
            BudgetDimension::ModelCalls => usage.model_calls = amount,
            BudgetDimension::InputTokens => usage.input_tokens = amount,
            BudgetDimension::OutputTokens => usage.output_tokens = amount,
            _ => return fail(&mut state, dimension),
        }
        for id in &self.scopes {
            if let Some(dimension) = record_charge(&mut state.scopes[*id], &usage) {
                state.failure.get_or_insert(BudgetFailure { dimension });
            }
        }
        self.check_locked(&mut state)
    }

    pub fn charge_cost(&self, cost: &Cost) -> Result<(), BudgetFailure> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        if cost.amount.as_str().starts_with('-') {
            return fail(&mut state, BudgetDimension::Cost);
        }
        let mut usage = empty_usage();
        usage.cost = Some(cost.clone());
        for id in &self.scopes {
            if let Some(dimension) = record_charge(&mut state.scopes[*id], &usage) {
                state.failure.get_or_insert(BudgetFailure { dimension });
            }
        }
        self.check_locked(&mut state)
    }

    /// Cumulative usage safe for generic checkpoints; unconfirmed tagged actuals stay live-only.
    pub fn checkpoint_usage(&self) -> Usage {
        let state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        let mut usage = state.scopes[self.checkpoint_scope].checkpoint.clone();
        usage.elapsed =
            DurationMs(u64::try_from(self.inner.started.elapsed().as_millis()).unwrap_or(u64::MAX));
        usage
    }

    /// Includes the named actual in the durable checkpoint before its acknowledgement.
    pub fn checkpoint_with_actual(&self, commit: &CommitId) -> Result<Usage, ReservationFailure> {
        let state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        let reservation = state
            .reservations
            .get(commit)
            .filter(|reservation| reservation.scopes == self.scopes)
            .ok_or_else(|| ReservationFailure::IdentityConflict(commit.clone()))?;
        let mut usage = match reservation.phase {
            ReservationPhase::Actual => add_usage(&state.scopes[self.checkpoint_scope].checkpoint, &reservation.usage)
                .map_err(ReservationFailure::Budget)?,
            ReservationPhase::Acknowledged => state.scopes[self.checkpoint_scope].checkpoint.clone(),
            _ => return Err(ReservationFailure::IdentityConflict(commit.clone())),
        };
        usage.elapsed =
            DurationMs(u64::try_from(self.inner.started.elapsed().as_millis()).unwrap_or(u64::MAX));
        Ok(usage)
    }

    pub fn usage(&self) -> Usage {
        self.usage_at(self.checkpoint_scope)
    }
    pub fn scope_usage(&self) -> Usage {
        self.usage_at(*self.scopes.last().expect("root scope"))
    }
    fn usage_at(&self, id: usize) -> Usage {
        let state = self
            .inner
            .state
            .lock()
            .expect("world call accounting poisoned");
        let mut usage = state.scopes[id].usage.clone();
        usage.elapsed =
            DurationMs(u64::try_from(self.inner.started.elapsed().as_millis()).unwrap_or(u64::MAX));
        usage
    }
    fn check_locked(&self, state: &mut Accounts) -> Result<(), BudgetFailure> {
        if let Some(failure) = state.failure {
            return Err(failure);
        }
        for id in &self.scopes {
            let scope = &state.scopes[*id];
            let result = add_usage(&scope.usage, &scope.pending)
                .and_then(|usage| check_scope(scope, &usage));
            if let Err(error) = result {
                return fail(state, error.dimension);
            }
        }
        Ok(())
    }
}

fn check_scope(scope: &Scope, usage: &Usage) -> Result<(), BudgetFailure> {
    if Instant::now() >= scope.deadline {
        return Err(BudgetFailure {
            dimension: scope.deadline_dimension,
        });
    }
    let limit = &scope.limit;
    for (dimension, used, maximum) in [
        (BudgetDimension::Steps, usage.steps, limit.max_steps),
        (
            BudgetDimension::SourceReads,
            usage.source_reads,
            limit.max_source_reads,
        ),
        (BudgetDimension::Rows, usage.rows, limit.max_rows),
        (BudgetDimension::Bytes, usage.bytes, limit.max_bytes),
        (
            BudgetDimension::ModelCalls,
            usage.model_calls,
            limit.max_model_calls,
        ),
        (
            BudgetDimension::InputTokens,
            usage.input_tokens,
            limit.max_input_tokens,
        ),
        (
            BudgetDimension::OutputTokens,
            usage.output_tokens,
            limit.max_output_tokens,
        ),
    ] {
        if used > maximum {
            return Err(BudgetFailure { dimension });
        }
    }
    if usage
        .cost
        .as_ref()
        .is_some_and(|used| used.amount.as_str().starts_with('-'))
        || limit.max_cost.as_ref().is_some_and(|maximum| {
            maximum.amount.as_str().starts_with('-')
                || usage.cost.as_ref().is_some_and(|used| {
                    used.currency != maximum.currency
                        || used.amount.cmp_numeric(&maximum.amount).is_gt()
                })
        })
    {
        return Err(BudgetFailure {
            dimension: BudgetDimension::Cost,
        });
    }
    Ok(())
}

fn add_usage(previous: &Usage, delta: &Usage) -> Result<Usage, BudgetFailure> {
    let mut total = previous.clone();
    match record_usage(&mut total, delta) {
        Some(dimension) => Err(BudgetFailure { dimension }),
        None => Ok(total),
    }
}

fn record_charge(scope: &mut Scope, usage: &Usage) -> Option<BudgetDimension> {
    let actual = record_usage(&mut scope.usage, usage);
    let checkpoint = record_usage(&mut scope.checkpoint, usage);
    actual.or(checkpoint)
}

fn record_usage(total: &mut Usage, delta: &Usage) -> Option<BudgetDimension> {
    let mut failure = None;
    for (dimension, used, amount) in [
        (BudgetDimension::Steps, &mut total.steps, delta.steps),
        (
            BudgetDimension::SourceReads,
            &mut total.source_reads,
            delta.source_reads,
        ),
        (BudgetDimension::Rows, &mut total.rows, delta.rows),
        (BudgetDimension::Bytes, &mut total.bytes, delta.bytes),
        (
            BudgetDimension::ModelCalls,
            &mut total.model_calls,
            delta.model_calls,
        ),
        (
            BudgetDimension::InputTokens,
            &mut total.input_tokens,
            delta.input_tokens,
        ),
        (
            BudgetDimension::OutputTokens,
            &mut total.output_tokens,
            delta.output_tokens,
        ),
    ] {
        match used.checked_add(amount) {
            Some(value) => *used = value,
            None => {
                *used = u64::MAX;
                failure.get_or_insert(dimension);
            }
        }
    }
    if let Some(cost) = &delta.cost {
        let amount = match &total.cost {
            Some(previous) if previous.currency == cost.currency => {
                previous.amount.checked_add_nonnegative(&cost.amount)
            }
            None if !cost.amount.as_str().starts_with('-') => Some(cost.amount.clone()),
            _ => None,
        };
        match amount {
            Some(amount) => {
                total.cost = Some(Cost {
                    amount,
                    currency: cost.currency.clone(),
                })
            }
            None => {
                failure.get_or_insert(BudgetDimension::Cost);
            }
        }
    }
    total.elapsed = total.elapsed.max(delta.elapsed);
    failure
}

fn exceeded_allowance(usage: &Usage, bound: &Usage) -> Option<BudgetDimension> {
    for (dimension, used, maximum) in [
        (BudgetDimension::Steps, usage.steps, bound.steps),
        (BudgetDimension::SourceReads, usage.source_reads, bound.source_reads),
        (BudgetDimension::Rows, usage.rows, bound.rows),
        (BudgetDimension::Bytes, usage.bytes, bound.bytes),
        (BudgetDimension::ModelCalls, usage.model_calls, bound.model_calls),
        (BudgetDimension::InputTokens, usage.input_tokens, bound.input_tokens),
        (BudgetDimension::OutputTokens, usage.output_tokens, bound.output_tokens),
    ] {
        if used > maximum { return Some(dimension); }
    }
    if usage.cost.as_ref().is_some_and(|used| {
        used.amount.as_str().starts_with('-') || bound.cost.as_ref().is_some_and(|maximum| {
            used.currency != maximum.currency || used.amount.cmp_numeric(&maximum.amount).is_gt()
        })
    }) {
        return Some(BudgetDimension::Cost);
    }
    None
}

fn remaining_allowance(bound: &Usage, observed: &Usage) -> Result<Usage, BudgetFailure> {
    let mut remaining = bound.clone();
    remaining.steps = bound.steps.saturating_sub(observed.steps);
    remaining.source_reads = bound.source_reads.saturating_sub(observed.source_reads);
    remaining.rows = bound.rows.saturating_sub(observed.rows);
    remaining.bytes = bound.bytes.saturating_sub(observed.bytes);
    remaining.model_calls = bound.model_calls.saturating_sub(observed.model_calls);
    remaining.input_tokens = bound.input_tokens.saturating_sub(observed.input_tokens);
    remaining.output_tokens = bound.output_tokens.saturating_sub(observed.output_tokens);
    if let (Some(maximum), Some(used)) = (&bound.cost, &observed.cost) {
        if maximum.currency == used.currency && !maximum.amount.as_str().starts_with('-')
            && !used.amount.as_str().starts_with('-')
        {
            remaining.cost = Some(Cost {
                amount: remaining_cost(&maximum.amount, &used.amount).ok_or(BudgetFailure {
                    dimension: BudgetDimension::Cost,
                })?,
                currency: maximum.currency.clone(),
            });
        }
    }
    Ok(remaining)
}

fn remaining_cost(bound: &world_protocol::value::Decimal, used: &world_protocol::value::Decimal) -> Option<world_protocol::value::Decimal> {
    use world_protocol::value::Decimal;
    if used.cmp_numeric(bound).is_ge() { return Decimal::try_new("0").ok(); }
    let parts = |value: &Decimal| value.as_str().split_once('.').map_or_else(
        || (value.as_str().to_owned(), String::new()),
        |(integer, fraction)| (integer.to_owned(), fraction.to_owned()),
    );
    let (integer, fraction) = parts(bound);
    let (used_integer, used_fraction) = parts(used);
    let scale = fraction.len().max(used_fraction.len());
    let mut left = format!("{integer}{fraction}").into_bytes();
    left.resize(integer.len() + scale, b'0');
    let mut right = format!("{used_integer}{used_fraction}").into_bytes();
    right.resize(used_integer.len() + scale, b'0');
    let mut borrow = 0i16;
    for offset in 0..left.len() {
        let index = left.len() - 1 - offset;
        let digit = right.len().checked_sub(offset + 1).map_or(0, |index| right[index] - b'0');
        let difference = i16::from(left[index] - b'0') - i16::from(digit) - borrow;
        borrow = if difference < 0 { 1 } else { 0 };
        left[index] = b'0' + difference.rem_euclid(10) as u8;
    }
    if scale != 0 { left.insert(left.len() - scale, b'.'); }
    let value = String::from_utf8(left).ok()?;
    let value = value.trim_start_matches('0');
    Decimal::try_new(if value.is_empty() || value.starts_with('.') { format!("0{value}") } else { value.to_owned() }).ok()
}

fn rebuild_pending(state: &mut Accounts, scopes: &[usize]) {
    for id in scopes {
        let mut pending = empty_usage();
        for reservation in state.reservations.values().filter(|reservation| {
            reservation.phase == ReservationPhase::Pending && reservation.scopes.contains(id)
        }) {
            let observed = reservation.observed.as_ref()
                .and_then(|commit| state.reservations.get(commit));
            let remaining = match observed.map(|observed| remaining_allowance(&reservation.usage, &observed.usage)) {
                Some(Ok(remaining)) => remaining,
                Some(Err(error)) => {
                    state.failure.get_or_insert(error);
                    reservation.usage.clone()
                }
                None => reservation.usage.clone(),
            };
            if let Some(dimension) = record_usage(&mut pending, &remaining) {
                state.failure.get_or_insert(BudgetFailure { dimension });
            }
        }
        state.scopes[*id].pending = pending;
    }
}

fn intersect(current: &mut Budget, limit: &Budget) -> Result<(), BudgetFailure> {
    let max_cost = match (&current.max_cost, &limit.max_cost) {
        (Some(left), Some(right)) if left.currency != right.currency => {
            return Err(BudgetFailure {
                dimension: BudgetDimension::Cost,
            });
        }
        (Some(left), Some(right)) => Some(
            if left.amount.cmp_numeric(&right.amount).is_le() {
                left
            } else {
                right
            }
            .clone(),
        ),
        (left, right) => left.as_ref().or(right.as_ref()).cloned(),
    };
    current.max_wall_time = current.max_wall_time.min(limit.max_wall_time);
    current.max_steps = current.max_steps.min(limit.max_steps);
    current.max_source_reads = current.max_source_reads.min(limit.max_source_reads);
    current.max_rows = current.max_rows.min(limit.max_rows);
    current.max_bytes = current.max_bytes.min(limit.max_bytes);
    current.max_model_calls = current.max_model_calls.min(limit.max_model_calls);
    current.max_input_tokens = current.max_input_tokens.min(limit.max_input_tokens);
    current.max_output_tokens = current.max_output_tokens.min(limit.max_output_tokens);
    current.max_cost = max_cost;
    current.deadline = match (&current.deadline, &limit.deadline) {
        (Some(left), Some(right)) => Some(left.min(right).clone()),
        (left, right) => left.as_ref().or(right.as_ref()).cloned(),
    };
    Ok(())
}
fn empty_usage() -> Usage {
    Usage {
        elapsed: DurationMs(0),
        steps: 0,
        source_reads: 0,
        rows: 0,
        bytes: 0,
        model_calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost: None,
    }
}
fn deadline(
    limit: &Budget,
    started: Instant,
    now: &Timestamp,
) -> Result<(Instant, BudgetDimension), BudgetFailure> {
    let wall = started
        .checked_add(Duration::from_millis(limit.max_wall_time.0))
        .ok_or(BudgetFailure {
            dimension: BudgetDimension::WallTime,
        })?;
    let absolute = limit
        .deadline
        .as_ref()
        .map(|deadline| {
            let millis = i128::from(deadline.unix_millis()) - i128::from(now.unix_millis());
            let duration = Duration::from_millis(u64::try_from(millis.unsigned_abs()).map_err(|_| BudgetFailure {
                dimension: BudgetDimension::Deadline,
            })?);
            let instant = Instant::now();
            if millis < 0 { instant.checked_sub(duration) } else { instant.checked_add(duration) }
                .ok_or(BudgetFailure {
                    dimension: BudgetDimension::Deadline,
                })
        })
        .transpose()?;
    Ok(match absolute {
        Some(absolute) if absolute <= wall => (absolute, BudgetDimension::Deadline),
        _ => (wall, BudgetDimension::WallTime),
    })
}
fn fail<T>(state: &mut Accounts, dimension: BudgetDimension) -> Result<T, BudgetFailure> {
    let failure = *state.failure.get_or_insert(BudgetFailure { dimension });
    Err(failure)
}
