use std::{fmt, time::SystemTime};

use super::{LeaseDuration, LeaseId, LeaseOwner};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseTimeError {
    ExpiryOutOfRange,
}

impl fmt::Display for LeaseTimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ExpiryOutOfRange => {
                formatter.write_str("lease expiry exceeds the supported time range")
            }
        }
    }
}

impl std::error::Error for LeaseTimeError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Lease<E> {
    id: LeaseId,
    endpoint: E,
    owner: LeaseOwner,
    acquired_at: SystemTime,
    state: LeaseState,
}

impl<E> Lease<E> {
    pub fn restore(
        id: LeaseId,
        endpoint: E,
        owner: LeaseOwner,
        acquired_at: SystemTime,
        state: LeaseState,
    ) -> Result<Self, LeaseTimeError> {
        if matches!(state, LeaseState::Active { expires_at } if expires_at <= acquired_at) {
            return Err(LeaseTimeError::ExpiryOutOfRange);
        }
        Ok(Self {
            id,
            endpoint,
            owner,
            acquired_at,
            state,
        })
    }

    pub(super) fn try_acquire(
        id: LeaseId,
        endpoint: E,
        owner: LeaseOwner,
        acquired_at: SystemTime,
        duration: LeaseDuration,
    ) -> Result<Self, LeaseTimeError> {
        let expires_at = acquired_at
            .checked_add(duration.duration())
            .ok_or(LeaseTimeError::ExpiryOutOfRange)?;

        Ok(Self {
            id,
            endpoint,
            owner,
            acquired_at,
            state: LeaseState::Active { expires_at },
        })
    }

    pub fn id(&self) -> &LeaseId {
        &self.id
    }

    pub fn endpoint(&self) -> &E {
        &self.endpoint
    }

    pub fn owner(&self) -> &LeaseOwner {
        &self.owner
    }

    pub fn acquired_at(&self) -> SystemTime {
        self.acquired_at
    }

    pub fn state(&self) -> LeaseState {
        self.state
    }

    pub(super) fn renew(
        &mut self,
        renewed_at: SystemTime,
        duration: LeaseDuration,
    ) -> Result<RenewTransition, LeaseTimeError> {
        let LeaseState::Active { expires_at } = self.state else {
            return Ok(RenewTransition::NotActive);
        };
        if expires_at <= renewed_at {
            self.state = LeaseState::Expired {
                expired_at: renewed_at,
            };
            return Ok(RenewTransition::Expired);
        }

        let expires_at = renewed_at
            .checked_add(duration.duration())
            .ok_or(LeaseTimeError::ExpiryOutOfRange)?;
        self.state = LeaseState::Active { expires_at };
        Ok(RenewTransition::Renewed)
    }

    pub(super) fn release(&mut self, released_at: SystemTime) -> ReleaseTransition {
        let LeaseState::Active { expires_at } = self.state else {
            return ReleaseTransition::NotActive;
        };
        if expires_at <= released_at {
            self.state = LeaseState::Expired {
                expired_at: released_at,
            };
            return ReleaseTransition::Expired;
        }

        self.state = LeaseState::Released { released_at };
        ReleaseTransition::Released
    }

    pub(super) fn expire(&mut self, expired_at: SystemTime) -> bool {
        let LeaseState::Active { expires_at } = self.state else {
            return false;
        };
        if expires_at > expired_at {
            return false;
        }
        self.state = LeaseState::Expired { expired_at };
        true
    }

    pub(super) fn is_active_at(&self, now: SystemTime) -> bool {
        matches!(self.state, LeaseState::Active { expires_at } if expires_at > now)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RenewTransition {
    Renewed,
    Expired,
    NotActive,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ReleaseTransition {
    Released,
    Expired,
    NotActive,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseState {
    Active { expires_at: SystemTime },
    Released { released_at: SystemTime },
    Expired { expired_at: SystemTime },
}
