use std::fmt;

const MAX_APPROVAL_FACT_BYTES: usize = 256;
const MAX_APPROVAL_NOTE_BYTES: usize = 256;

#[derive(Clone, Eq, PartialEq)]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub run_id: String,
    pub stage_id: String,
    pub role_id: String,
    pub reason: String,
    pub requested_action: String,
    pub risk_summary: String,
    pub idempotency_key: String,
    pub requested_at: u64,
    pub subject: ApprovalSubject,
    pub origin: ApprovalOrigin,
    pub effect: ApprovalEffect,
    pub execution_fence: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ApprovalSubject {
    Stage { stage_id: String },
    WorkNode { node_id: String },
    HumanDecision { node_id: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalOrigin {
    StageContinuation,
    WorkNode,
    HumanDecision,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalEffect {
    ResumeStage,
    KeepNodeWaiting,
    RouteDecisionPorts,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Approval {
    facts: ApprovalRequest,
    status: ApprovalStatus,
    resolutions: Vec<ApprovalResolution>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovalDurableSnapshot {
    pub facts: ApprovalRequest,
    pub status: ApprovalStatus,
    pub resolutions: Vec<ApprovalResolution>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    Aborted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalDecision {
    Approve,
    Deny,
    Abort,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ApprovalResolution {
    pub decision: ApprovalDecision,
    pub note: Option<String>,
    pub resolved_at: u64,
    pub idempotency_key: String,
    pub cause: ApprovalResolutionCause,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalResolutionCause {
    HumanDecision,
    RunCancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalResolutionError {
    InvalidResolution,
    ConflictingIdempotencyKey,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalRestoreError {
    InvalidSnapshot,
}

impl Approval {
    pub fn request(facts: ApprovalRequest) -> Self {
        Self {
            facts,
            status: ApprovalStatus::Pending,
            resolutions: Vec::new(),
        }
    }

    pub fn facts(&self) -> &ApprovalRequest {
        &self.facts
    }

    pub fn status(&self) -> ApprovalStatus {
        self.status
    }

    pub fn resolution(&self) -> Option<&ApprovalResolution> {
        self.resolutions.last()
    }

    pub fn resolutions(&self) -> &[ApprovalResolution] {
        &self.resolutions
    }

    pub fn resolution_for_idempotency(&self, idempotency_key: &str) -> Option<&ApprovalResolution> {
        self.resolutions
            .iter()
            .find(|resolution| resolution.idempotency_key == idempotency_key)
    }

    pub(crate) fn resolution_receipt_matches(
        &self,
        idempotency_key: &str,
        decision: ApprovalDecision,
        note: Option<&str>,
        resolved_at: u64,
        cause: ApprovalResolutionCause,
    ) -> bool {
        let Some((index, existing)) = self
            .resolutions
            .iter()
            .enumerate()
            .find(|(_, resolution)| resolution.idempotency_key == idempotency_key)
        else {
            return false;
        };
        if existing.decision != decision
            || existing.resolved_at != resolved_at
            || existing.cause != cause
        {
            return false;
        }
        let inherited_note = index
            .checked_sub(1)
            .and_then(|previous| self.resolutions.get(previous))
            .and_then(|resolution| resolution.note.as_deref());
        existing.note.as_deref() == note.or(inherited_note)
    }

    pub fn is_pending(&self) -> bool {
        self.status == ApprovalStatus::Pending
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            ApprovalStatus::Approved | ApprovalStatus::Denied | ApprovalStatus::Aborted
        )
    }

    pub fn resolve(
        &mut self,
        decision: ApprovalDecision,
        resolved_at: u64,
        note: Option<String>,
    ) -> Result<(), ApprovalResolutionError> {
        self.resolve_with_receipt(
            decision,
            resolved_at,
            note,
            format!(
                "legacy:{}:{}:{}",
                self.facts.approval_id,
                self.resolutions.len(),
                resolved_at
            ),
            ApprovalResolutionCause::HumanDecision,
        )
    }

    pub fn resolve_with_receipt(
        &mut self,
        decision: ApprovalDecision,
        resolved_at: u64,
        note: Option<String>,
        idempotency_key: String,
        cause: ApprovalResolutionCause,
    ) -> Result<(), ApprovalResolutionError> {
        if !is_bounded_fact(&idempotency_key) || note.as_ref().is_some_and(|note| !is_note(note)) {
            return Err(ApprovalResolutionError::InvalidResolution);
        }
        if self.resolution_receipt_matches(
            &idempotency_key,
            decision,
            note.as_deref(),
            resolved_at,
            cause,
        ) {
            return Ok(());
        }
        if self.resolution_for_idempotency(&idempotency_key).is_some() {
            return Err(ApprovalResolutionError::ConflictingIdempotencyKey);
        }
        self.status = decision.status();
        self.resolutions.push(ApprovalResolution {
            decision,
            note: note.or_else(|| {
                self.resolution()
                    .and_then(|resolution| resolution.note.clone())
            }),
            resolved_at,
            idempotency_key,
            cause,
        });
        Ok(())
    }

    pub fn durable_snapshot(&self) -> ApprovalDurableSnapshot {
        ApprovalDurableSnapshot {
            facts: self.facts.clone(),
            status: self.status,
            resolutions: self.resolutions.clone(),
        }
    }

    pub fn restore(snapshot: ApprovalDurableSnapshot) -> Result<Self, ApprovalRestoreError> {
        let terminal_status = snapshot.status != ApprovalStatus::Pending;
        if terminal_status != !snapshot.resolutions.is_empty()
            || !facts_are_canonical(&snapshot.facts)
        {
            return Err(ApprovalRestoreError::InvalidSnapshot);
        }
        let mut resolution_keys = std::collections::BTreeSet::new();
        for resolution in &snapshot.resolutions {
            if !is_bounded_fact(&resolution.idempotency_key)
                || resolution.note.as_ref().is_some_and(|note| !is_note(note))
                || resolution.resolved_at < snapshot.facts.requested_at
                || !resolution_keys.insert(&resolution.idempotency_key)
            {
                return Err(ApprovalRestoreError::InvalidSnapshot);
            }
        }
        if snapshot
            .resolutions
            .last()
            .is_some_and(|resolution| resolution.decision.status() != snapshot.status)
        {
            return Err(ApprovalRestoreError::InvalidSnapshot);
        }
        Ok(Self {
            facts: snapshot.facts,
            status: snapshot.status,
            resolutions: snapshot.resolutions,
        })
    }
}

fn facts_are_canonical(facts: &ApprovalRequest) -> bool {
    if !is_bounded_fact(&facts.approval_id)
        || !is_bounded_fact(&facts.run_id)
        || !is_bounded_fact(&facts.stage_id)
        || !is_bounded_fact(&facts.role_id)
        || !is_bounded_fact(&facts.reason)
        || !is_bounded_fact(&facts.requested_action)
        || !is_bounded_fact(&facts.risk_summary)
        || !is_bounded_fact(&facts.idempotency_key)
        || facts
            .execution_fence
            .as_ref()
            .is_some_and(|fence| !is_bounded_fact(fence))
    {
        return false;
    }

    match (
        &facts.subject,
        facts.origin,
        facts.effect,
        &facts.execution_fence,
    ) {
        (
            ApprovalSubject::Stage { stage_id },
            ApprovalOrigin::StageContinuation,
            ApprovalEffect::ResumeStage,
            None,
        ) => stage_id == &facts.stage_id,
        (
            ApprovalSubject::WorkNode { node_id },
            ApprovalOrigin::WorkNode,
            ApprovalEffect::KeepNodeWaiting,
            Some(_),
        ) => !node_id.is_empty(),
        (
            ApprovalSubject::HumanDecision { node_id },
            ApprovalOrigin::HumanDecision,
            ApprovalEffect::RouteDecisionPorts,
            Some(_),
        ) => !node_id.is_empty(),
        _ => false,
    }
}

fn is_bounded_fact(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_APPROVAL_FACT_BYTES
}

fn is_note(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_APPROVAL_NOTE_BYTES
}

impl fmt::Debug for ApprovalRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ApprovalRequest")
            .field("approval_id", &self.approval_id)
            .field("run_id", &self.run_id)
            .field("stage_id", &self.stage_id)
            .field("role_id", &self.role_id)
            .field("has_reason", &true)
            .field("has_requested_action", &true)
            .field("has_risk_summary", &true)
            .field("idempotency_key", &self.idempotency_key)
            .field("requested_at", &self.requested_at)
            .field("subject", &self.subject)
            .field("origin", &self.origin)
            .field("effect", &self.effect)
            .field("has_execution_fence", &self.execution_fence.is_some())
            .finish()
    }
}

impl fmt::Debug for ApprovalResolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ApprovalResolution")
            .field("decision", &self.decision)
            .field("has_note", &self.note.is_some())
            .field("resolved_at", &self.resolved_at)
            .field("idempotency_key", &self.idempotency_key)
            .field("cause", &self.cause)
            .finish()
    }
}

impl ApprovalDecision {
    pub fn status(self) -> ApprovalStatus {
        match self {
            Self::Approve => ApprovalStatus::Approved,
            Self::Deny => ApprovalStatus::Denied,
            Self::Abort => ApprovalStatus::Aborted,
        }
    }
}
