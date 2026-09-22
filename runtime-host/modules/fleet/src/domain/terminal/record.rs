use std::time::SystemTime;

use super::{identity::*, state::SessionStatus};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionSummary {
    id: SessionId,
    target: TargetId,
    provider: ProviderId,
    dimensions: Dimensions,
    generation: Generation,
    status: SessionStatus,
    created_at: SystemTime,
    updated_at: SystemTime,
    expires_at: SystemTime,
}

impl SessionSummary {
    pub(super) fn opening(
        id: SessionId,
        target: TargetId,
        provider: ProviderId,
        dimensions: Dimensions,
        now: SystemTime,
        expires_at: SystemTime,
    ) -> Self {
        Self {
            id,
            target,
            provider,
            dimensions,
            generation: Generation::FIRST,
            status: SessionStatus::Opening,
            created_at: now,
            updated_at: now,
            expires_at,
        }
    }

    pub fn id(&self) -> &SessionId {
        &self.id
    }
    pub fn target(&self) -> &TargetId {
        &self.target
    }
    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }
    pub const fn dimensions(&self) -> Dimensions {
        self.dimensions
    }
    pub const fn generation(&self) -> Generation {
        self.generation
    }
    pub const fn status(&self) -> SessionStatus {
        self.status
    }
    pub const fn created_at(&self) -> SystemTime {
        self.created_at
    }
    pub const fn updated_at(&self) -> SystemTime {
        self.updated_at
    }
    pub const fn expires_at(&self) -> SystemTime {
        self.expires_at
    }

    pub(super) fn set_status(&mut self, status: SessionStatus, now: SystemTime) {
        self.status = status;
        self.updated_at = now;
    }

    pub(super) fn reconnect(
        &mut self,
        now: SystemTime,
        expires_at: SystemTime,
    ) -> Option<Generation> {
        if !matches!(
            self.status,
            SessionStatus::Connected | SessionStatus::Opening
        ) {
            return None;
        }
        let generation = self.generation.next()?;
        self.generation = generation;
        self.expires_at = expires_at;
        self.status = SessionStatus::Opening;
        self.updated_at = now;
        Some(generation)
    }

    pub(super) fn expired(&mut self, now: SystemTime) -> bool {
        if matches!(
            self.status,
            SessionStatus::Closed | SessionStatus::Failed | SessionStatus::Expired
        ) || self.expires_at > now
        {
            return false;
        }
        self.set_status(SessionStatus::Expired, now);
        true
    }
}
