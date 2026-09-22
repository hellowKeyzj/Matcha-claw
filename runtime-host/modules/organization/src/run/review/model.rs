use std::fmt;

use crate::run::graph::ExecutionFence;

const MAX_REVIEW_ID_BYTES: usize = 256;
const MAX_REVIEW_FACT_BYTES: usize = 256;
const MAX_REVIEW_PROMPT_BYTES: usize = 64 * 1024;
const MAX_REVIEW_SUMMARY_BYTES: usize = 4 * 1024;

#[derive(Clone, Eq, PartialEq)]
pub struct ReviewerRequest {
    pub review_id: String,
    pub run_id: String,
    pub node_id: String,
    pub fence: ExecutionFence,
    pub role_id: String,
    pub session_id: String,
    pub prompt: String,
    pub idempotency_key: String,
    pub requested_at: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReviewerRequestError {
    BlankReviewId,
    BlankRunId,
    BlankNodeId,
    BlankRoleId,
    BlankSessionId,
    BlankFact,
    BlankPrompt,
    BlankIdempotencyKey,
    OversizedReviewId,
    OversizedFact,
    OversizedPrompt,
    NodeFenceMismatch,
    AcceptedBeforeRequest,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReviewVerdict {
    Pass,
    Fail,
    Rework,
}

impl ReviewVerdict {
    pub const fn output_port(self) -> &'static str {
        match self {
            Self::Pass => "passed",
            Self::Fail | Self::Rework => "failed",
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ReviewerReceipt {
    request: ReviewerRequest,
    accepted_at: u64,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ReviewVerdictReceipt {
    review_id: String,
    run_id: String,
    node_id: String,
    fence: ExecutionFence,
    role_id: String,
    session_id: String,
    verdict: ReviewVerdict,
    summary: String,
    idempotency_key: String,
    resolved_at: u64,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ReviewDurableSnapshot {
    pub request: ReviewerRequest,
    pub accepted_at: u64,
    pub verdict: Option<ReviewVerdictReceipt>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReviewRestoreError {
    InvalidRequest(ReviewerRequestError),
    InvalidVerdict,
    VerdictRequestMismatch,
    DuplicateIdempotencyKey,
}

impl ReviewerRequest {
    pub fn validate(&self) -> Result<(), ReviewerRequestError> {
        if self.review_id.trim().is_empty() {
            return Err(ReviewerRequestError::BlankReviewId);
        }
        if self.review_id.len() > MAX_REVIEW_ID_BYTES {
            return Err(ReviewerRequestError::OversizedReviewId);
        }
        for (value, blank_error) in [
            (&self.run_id, ReviewerRequestError::BlankRunId),
            (&self.node_id, ReviewerRequestError::BlankNodeId),
            (&self.role_id, ReviewerRequestError::BlankRoleId),
            (&self.session_id, ReviewerRequestError::BlankSessionId),
            (
                &self.idempotency_key,
                ReviewerRequestError::BlankIdempotencyKey,
            ),
        ] {
            if value.trim().is_empty() {
                return Err(blank_error);
            }
            if value.len() > MAX_REVIEW_FACT_BYTES {
                return Err(ReviewerRequestError::OversizedFact);
            }
        }
        if self.prompt.trim().is_empty() {
            return Err(ReviewerRequestError::BlankPrompt);
        }
        if self.prompt.len() > MAX_REVIEW_PROMPT_BYTES {
            return Err(ReviewerRequestError::OversizedPrompt);
        }
        if self.fence.node_execution_id().as_str().trim().is_empty()
            || self.fence.attempt_id().as_str().trim().is_empty()
            || !fence_belongs_to_node(&self.fence, &self.node_id)
        {
            return Err(ReviewerRequestError::NodeFenceMismatch);
        }
        Ok(())
    }
}

impl ReviewerReceipt {
    pub(crate) fn recorded(request: ReviewerRequest, accepted_at: u64) -> Self {
        Self {
            request,
            accepted_at,
        }
    }
    pub fn request(&self) -> &ReviewerRequest {
        &self.request
    }
    pub const fn accepted_at(&self) -> u64 {
        self.accepted_at
    }
}

impl ReviewVerdictReceipt {
    pub(crate) fn new(
        request: &ReviewerRequest,
        verdict: ReviewVerdict,
        summary: String,
        idempotency_key: String,
        resolved_at: u64,
    ) -> Result<Self, ReviewVerdictError> {
        let receipt = Self {
            review_id: request.review_id.clone(),
            run_id: request.run_id.clone(),
            node_id: request.node_id.clone(),
            fence: request.fence.clone(),
            role_id: request.role_id.clone(),
            session_id: request.session_id.clone(),
            verdict,
            summary,
            idempotency_key,
            resolved_at,
        };
        receipt.validate(request)?;
        Ok(receipt)
    }

    pub(crate) fn validate(&self, request: &ReviewerRequest) -> Result<(), ReviewVerdictError> {
        if self.review_id != request.review_id
            || self.run_id != request.run_id
            || self.node_id != request.node_id
            || self.fence != request.fence
            || self.role_id != request.role_id
            || self.session_id != request.session_id
        {
            return Err(ReviewVerdictError::BindingMismatch);
        }
        if self.idempotency_key.trim().is_empty()
            || self.idempotency_key.len() > MAX_REVIEW_FACT_BYTES
        {
            return Err(ReviewVerdictError::InvalidIdempotencyKey);
        }
        if self.summary.trim().is_empty() || self.summary.len() > MAX_REVIEW_SUMMARY_BYTES {
            return Err(ReviewVerdictError::InvalidSummary);
        }
        if self.resolved_at < request.requested_at {
            return Err(ReviewVerdictError::BeforeRequest);
        }
        Ok(())
    }

    pub fn review_id(&self) -> &str {
        &self.review_id
    }
    pub fn run_id(&self) -> &str {
        &self.run_id
    }
    pub fn node_id(&self) -> &str {
        &self.node_id
    }
    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
    }
    pub fn role_id(&self) -> &str {
        &self.role_id
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub const fn verdict(&self) -> ReviewVerdict {
        self.verdict
    }
    pub fn summary(&self) -> &str {
        &self.summary
    }
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }
    pub const fn resolved_at(&self) -> u64 {
        self.resolved_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReviewVerdictError {
    BindingMismatch,
    InvalidIdempotencyKey,
    InvalidSummary,
    BeforeRequest,
}

fn fence_belongs_to_node(fence: &ExecutionFence, node_id: &str) -> bool {
    fence
        .attempt_id()
        .as_str()
        .starts_with(&format!("{node_id}:"))
}

impl fmt::Debug for ReviewerRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReviewerRequest")
            .field("review_id", &"<redacted>")
            .field("run_id", &"<redacted>")
            .field("node_id", &"<redacted>")
            .field("fence", &"<redacted>")
            .field("role_id", &"<redacted>")
            .field("session_id", &"<redacted>")
            .field("prompt", &"<redacted>")
            .field("idempotency_key", &"<redacted>")
            .field("requested_at", &self.requested_at)
            .finish()
    }
}

impl fmt::Debug for ReviewerReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReviewerReceipt")
            .field("request", &self.request)
            .field("accepted_at", &self.accepted_at)
            .finish()
    }
}

impl fmt::Debug for ReviewVerdictReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReviewVerdictReceipt")
            .field("review_id", &"<redacted>")
            .field("verdict", &self.verdict)
            .field("summary", &"<redacted>")
            .field("resolved_at", &self.resolved_at)
            .finish()
    }
}

impl fmt::Debug for ReviewDurableSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReviewDurableSnapshot")
            .field("request", &self.request)
            .field("accepted_at", &self.accepted_at)
            .field("has_verdict", &self.verdict.is_some())
            .finish()
    }
}
