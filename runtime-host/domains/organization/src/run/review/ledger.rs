use std::collections::{BTreeMap, BTreeSet};

use super::model::{
    ReviewDurableSnapshot, ReviewRestoreError, ReviewVerdict, ReviewVerdictError,
    ReviewVerdictReceipt, ReviewerReceipt, ReviewerRequest, ReviewerRequestError,
};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ReviewLedger {
    reviews: BTreeMap<String, ReviewDurableSnapshot>,
    ids_by_idempotency: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RegisterReviewOutcome {
    Recorded(ReviewerReceipt),
    Replayed(ReviewerReceipt),
    ConflictingReviewId,
    ConflictingIdempotencyKey,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResolveReviewOutcome {
    Recorded(ReviewVerdictReceipt),
    Replayed(ReviewVerdictReceipt),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReviewLedgerError {
    InvalidRequest(ReviewerRequestError),
    InvalidVerdict(ReviewVerdictError),
    UnknownReview,
    ConflictingIdempotencyKey,
    ConflictingVerdictIdempotencyKey,
    TerminalConflict,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReviewLedgerSnapshot {
    reviews: Vec<ReviewDurableSnapshot>,
}

impl ReviewLedgerSnapshot {
    pub fn new(reviews: Vec<ReviewDurableSnapshot>) -> Self {
        Self { reviews }
    }
    pub fn reviews(&self) -> &[ReviewDurableSnapshot] {
        &self.reviews
    }
}

impl ReviewLedger {
    pub fn snapshot(&self) -> ReviewLedgerSnapshot {
        ReviewLedgerSnapshot::new(self.reviews.values().cloned().collect())
    }

    pub fn restore(snapshot: ReviewLedgerSnapshot) -> Result<Self, ReviewRestoreError> {
        let mut ledger = Self::default();
        let mut review_ids = BTreeSet::new();
        for durable in snapshot.reviews {
            durable
                .request
                .validate()
                .map_err(ReviewRestoreError::InvalidRequest)?;
            if !review_ids.insert(durable.request.review_id.clone()) {
                return Err(ReviewRestoreError::DuplicateIdempotencyKey);
            }
            if ledger
                .ids_by_idempotency
                .insert(
                    durable.request.idempotency_key.clone(),
                    durable.request.review_id.clone(),
                )
                .is_some()
            {
                return Err(ReviewRestoreError::DuplicateIdempotencyKey);
            }
            if durable.accepted_at < durable.request.requested_at {
                return Err(ReviewRestoreError::InvalidVerdict);
            }
            if let Some(verdict) = &durable.verdict {
                verdict
                    .validate_for_restore(&durable.request)
                    .map_err(|error| match error {
                        ReviewVerdictError::BindingMismatch | ReviewVerdictError::BeforeRequest => {
                            ReviewRestoreError::VerdictRequestMismatch
                        }
                        ReviewVerdictError::InvalidIdempotencyKey => {
                            ReviewRestoreError::DuplicateIdempotencyKey
                        }
                        ReviewVerdictError::InvalidSummary => ReviewRestoreError::InvalidVerdict,
                    })?;
            }
            ledger
                .reviews
                .insert(durable.request.review_id.clone(), durable);
        }
        Ok(ledger)
    }

    pub fn register(
        &mut self,
        request: ReviewerRequest,
        accepted_at: u64,
    ) -> Result<RegisterReviewOutcome, ReviewLedgerError> {
        request
            .validate()
            .map_err(ReviewLedgerError::InvalidRequest)?;
        if let Some(existing_id) = self.ids_by_idempotency.get(&request.idempotency_key) {
            let existing = self
                .reviews
                .get(existing_id)
                .expect("review id index is durable");
            if existing.request == request {
                return Ok(RegisterReviewOutcome::Replayed(ReviewerReceipt::recorded(
                    existing.request.clone(),
                    existing.accepted_at,
                )));
            }
            return Err(ReviewLedgerError::ConflictingIdempotencyKey);
        }
        if let Some(existing) = self.reviews.get(&request.review_id) {
            if existing.request == request {
                return Ok(RegisterReviewOutcome::Replayed(ReviewerReceipt::recorded(
                    existing.request.clone(),
                    existing.accepted_at,
                )));
            }
            return Ok(RegisterReviewOutcome::ConflictingReviewId);
        }
        if accepted_at < request.requested_at {
            return Err(ReviewLedgerError::InvalidRequest(
                ReviewerRequestError::AcceptedBeforeRequest,
            ));
        }
        self.ids_by_idempotency
            .insert(request.idempotency_key.clone(), request.review_id.clone());
        self.reviews.insert(
            request.review_id.clone(),
            ReviewDurableSnapshot {
                request: request.clone(),
                accepted_at,
                verdict: None,
            },
        );
        Ok(RegisterReviewOutcome::Recorded(ReviewerReceipt::recorded(
            request,
            accepted_at,
        )))
    }

    pub fn review(&self, review_id: &str) -> Option<ReviewerReceipt> {
        self.reviews
            .get(review_id)
            .map(|review| ReviewerReceipt::recorded(review.request.clone(), review.accepted_at))
    }

    pub fn verdict(&self, review_id: &str) -> Option<&ReviewVerdictReceipt> {
        self.reviews
            .get(review_id)
            .and_then(|review| review.verdict.as_ref())
    }

    pub fn resolve(
        &mut self,
        review_id: &str,
        run_id: &str,
        node_id: &str,
        fence: crate::run::graph::ExecutionFence,
        role_id: &str,
        session_id: &str,
        verdict: ReviewVerdict,
        summary: String,
        idempotency_key: String,
        resolved_at: u64,
    ) -> Result<ResolveReviewOutcome, ReviewLedgerError> {
        let durable = self
            .reviews
            .get_mut(review_id)
            .ok_or(ReviewLedgerError::UnknownReview)?;
        let receipt = ReviewVerdictReceipt::new(
            &durable.request,
            verdict,
            summary,
            idempotency_key,
            resolved_at,
        )
        .map_err(ReviewLedgerError::InvalidVerdict)?;
        if receipt.run_id() != run_id
            || receipt.node_id() != node_id
            || receipt.fence() != &fence
            || receipt.role_id() != role_id
            || receipt.session_id() != session_id
        {
            return Err(ReviewLedgerError::InvalidVerdict(
                ReviewVerdictError::BindingMismatch,
            ));
        }
        if let Some(existing) = &durable.verdict {
            if existing == &receipt {
                return Ok(ResolveReviewOutcome::Replayed(existing.clone()));
            }
            return Err(if existing.idempotency_key() == receipt.idempotency_key() {
                ReviewLedgerError::ConflictingVerdictIdempotencyKey
            } else {
                ReviewLedgerError::TerminalConflict
            });
        }
        durable.verdict = Some(receipt.clone());
        Ok(ResolveReviewOutcome::Recorded(receipt))
    }
}

impl ReviewVerdictReceipt {
    pub(crate) fn validate_for_restore(
        &self,
        request: &ReviewerRequest,
    ) -> Result<(), ReviewVerdictError> {
        self.validate(request)
    }
}
