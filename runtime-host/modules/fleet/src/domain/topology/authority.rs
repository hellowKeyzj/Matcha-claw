use std::{collections::BTreeMap, fmt, time::SystemTime};

use platform::endpoint::NativeAgentId;

use super::FleetTopologyFacts;

#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct CredentialHash(String);

impl CredentialHash {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidCredentialHash> {
        let value = value.into();
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(InvalidCredentialHash);
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for CredentialHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CredentialHash(<opaque>)")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidCredentialHash;

impl fmt::Display for InvalidCredentialHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("credential hash must be a 64-character hexadecimal digest")
    }
}

impl std::error::Error for InvalidCredentialHash {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnrollmentRecord {
    agent_id: NativeAgentId,
    credential_hash: CredentialHash,
    issued_at: SystemTime,
    expires_at: SystemTime,
    consumed_at: Option<SystemTime>,
}

impl EnrollmentRecord {
    pub fn restore(
        agent_id: NativeAgentId,
        credential_hash: CredentialHash,
        issued_at: SystemTime,
        expires_at: SystemTime,
        consumed_at: Option<SystemTime>,
    ) -> Result<Self, EnrollmentRestoreError> {
        if expires_at <= issued_at {
            return Err(EnrollmentRestoreError::InvalidExpiry);
        }
        if consumed_at.is_some_and(|consumed_at| consumed_at < issued_at) {
            return Err(EnrollmentRestoreError::ConsumedBeforeIssued);
        }
        Ok(Self {
            agent_id,
            credential_hash,
            issued_at,
            expires_at,
            consumed_at,
        })
    }

    pub const fn agent_id(&self) -> &NativeAgentId {
        &self.agent_id
    }

    pub const fn credential_hash(&self) -> &CredentialHash {
        &self.credential_hash
    }

    pub const fn issued_at(&self) -> SystemTime {
        self.issued_at
    }

    pub const fn expires_at(&self) -> SystemTime {
        self.expires_at
    }

    pub const fn consumed_at(&self) -> Option<SystemTime> {
        self.consumed_at
    }

    fn consume(&mut self, at: SystemTime) -> EnrollmentUse {
        if self.consumed_at.is_some() {
            return EnrollmentUse::AlreadyConsumed;
        }
        if at >= self.expires_at {
            return EnrollmentUse::Expired;
        }
        if at < self.issued_at {
            return EnrollmentUse::NotYetIssued;
        }
        self.consumed_at = Some(at);
        EnrollmentUse::Consumed
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnrollmentRestoreError {
    InvalidExpiry,
    ConsumedBeforeIssued,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnrollmentUse {
    Consumed,
    Unknown,
    AlreadyConsumed,
    Expired,
    NotYetIssued,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IngressCredentialRecord {
    agent_id: NativeAgentId,
    credential_hash: CredentialHash,
    issued_at: SystemTime,
    revoked_at: Option<SystemTime>,
}

impl IngressCredentialRecord {
    pub fn restore(
        agent_id: NativeAgentId,
        credential_hash: CredentialHash,
        issued_at: SystemTime,
        revoked_at: Option<SystemTime>,
    ) -> Result<Self, IngressCredentialRestoreError> {
        if revoked_at.is_some_and(|revoked_at| revoked_at < issued_at) {
            return Err(IngressCredentialRestoreError::RevokedBeforeIssued);
        }
        Ok(Self {
            agent_id,
            credential_hash,
            issued_at,
            revoked_at,
        })
    }

    pub const fn agent_id(&self) -> &NativeAgentId {
        &self.agent_id
    }

    pub const fn credential_hash(&self) -> &CredentialHash {
        &self.credential_hash
    }

    pub const fn issued_at(&self) -> SystemTime {
        self.issued_at
    }

    pub const fn revoked_at(&self) -> Option<SystemTime> {
        self.revoked_at
    }

    fn revoke(&mut self, at: SystemTime) -> IngressCredentialRevocation {
        match self.revoked_at {
            Some(revoked_at) if revoked_at <= at => IngressCredentialRevocation::AlreadyRevoked,
            Some(_) => IngressCredentialRevocation::InvalidTime,
            None if at < self.issued_at => IngressCredentialRevocation::InvalidTime,
            None => {
                self.revoked_at = Some(at);
                IngressCredentialRevocation::Revoked
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IngressCredentialRestoreError {
    RevokedBeforeIssued,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IngressCredentialIssue {
    Issued,
    Replaced,
    UnknownAgent,
    ExistingHash,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IngressCredentialRevocation {
    Revoked,
    Unknown,
    AlreadyRevoked,
    InvalidTime,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FleetAccessFacts {
    enrollments: BTreeMap<CredentialHash, EnrollmentRecord>,
    ingress_credentials: BTreeMap<CredentialHash, IngressCredentialRecord>,
}

impl FleetAccessFacts {
    pub fn restore(
        topology: &FleetTopologyFacts,
        enrollments: impl IntoIterator<Item = EnrollmentRecord>,
        ingress_credentials: impl IntoIterator<Item = IngressCredentialRecord>,
    ) -> Result<Self, FleetAccessFactsError> {
        let mut restored_enrollments = BTreeMap::new();
        for enrollment in enrollments {
            if !topology.has_agent(enrollment.agent_id()) {
                return Err(FleetAccessFactsError::UnknownEnrollmentAgent);
            }
            if restored_enrollments
                .insert(enrollment.credential_hash().clone(), enrollment)
                .is_some()
            {
                return Err(FleetAccessFactsError::DuplicateEnrollmentHash);
            }
        }
        let mut restored_ingress_credentials = BTreeMap::new();
        for credential in ingress_credentials {
            if !topology.has_agent(credential.agent_id()) {
                return Err(FleetAccessFactsError::UnknownIngressAgent);
            }
            if restored_ingress_credentials
                .insert(credential.credential_hash().clone(), credential)
                .is_some()
            {
                return Err(FleetAccessFactsError::DuplicateIngressHash);
            }
        }
        for credential in restored_ingress_credentials.values() {
            let active_count = restored_ingress_credentials
                .values()
                .filter(|candidate| {
                    candidate.agent_id() == credential.agent_id()
                        && candidate.revoked_at().is_none()
                })
                .count();
            if active_count > 1 {
                return Err(FleetAccessFactsError::MultipleActiveIngressCredentials);
            }
        }
        Ok(Self {
            enrollments: restored_enrollments,
            ingress_credentials: restored_ingress_credentials,
        })
    }

    pub fn enrollments(&self) -> impl Iterator<Item = &EnrollmentRecord> {
        self.enrollments.values()
    }

    pub fn ingress_credentials(&self) -> impl Iterator<Item = &IngressCredentialRecord> {
        self.ingress_credentials.values()
    }

    pub fn ingress_credential(
        &self,
        credential_hash: &CredentialHash,
    ) -> Option<&IngressCredentialRecord> {
        self.ingress_credentials.get(credential_hash)
    }

    pub(crate) fn authenticate_or_enroll_ingress(
        &mut self,
        topology: &FleetTopologyFacts,
        agent_id: &NativeAgentId,
        presented_ingress_hash: CredentialHash,
        enrollment_hash: Option<CredentialHash>,
        at: SystemTime,
    ) -> Result<Option<IngressCredentialIssue>, FleetAccessFactsError> {
        let Some(enrollment_hash) = enrollment_hash else {
            return Ok(self
                .ingress_credentials
                .get(&presented_ingress_hash)
                .filter(|credential| {
                    credential.agent_id() == agent_id && credential.revoked_at().is_none()
                })
                .map(|_| IngressCredentialIssue::ExistingHash));
        };

        let enrollment = match self.enrollments.get(&enrollment_hash) {
            Some(enrollment) if enrollment.agent_id() == agent_id => enrollment,
            _ => return Ok(None),
        };
        if enrollment.consumed_at().is_some()
            || at < enrollment.issued_at()
            || at >= enrollment.expires_at()
        {
            return Ok(None);
        }
        if self
            .ingress_credentials
            .contains_key(&presented_ingress_hash)
        {
            return Ok(None);
        }

        match self.consume_enrollment(&enrollment_hash, at) {
            EnrollmentUse::Consumed => {}
            EnrollmentUse::Unknown
            | EnrollmentUse::AlreadyConsumed
            | EnrollmentUse::Expired
            | EnrollmentUse::NotYetIssued => return Ok(None),
        }
        let credential =
            IngressCredentialRecord::restore(agent_id.clone(), presented_ingress_hash, at, None)
                .expect("an unrevoked credential issued at its current time is valid");
        let issue = self.issue_ingress_credential(topology, credential)?;
        match issue {
            IngressCredentialIssue::Issued | IngressCredentialIssue::Replaced => Ok(Some(issue)),
            IngressCredentialIssue::UnknownAgent | IngressCredentialIssue::ExistingHash => {
                Err(FleetAccessFactsError::InvalidIngressAuthentication)
            }
        }
    }

    pub fn issue_enrollment(
        &mut self,
        topology: &FleetTopologyFacts,
        enrollment: EnrollmentRecord,
    ) -> Result<(), FleetAccessFactsError> {
        if !topology.has_agent(enrollment.agent_id()) {
            return Err(FleetAccessFactsError::UnknownEnrollmentAgent);
        }
        if self
            .enrollments
            .insert(enrollment.credential_hash().clone(), enrollment)
            .is_some()
        {
            return Err(FleetAccessFactsError::DuplicateEnrollmentHash);
        }
        Ok(())
    }

    pub fn consume_enrollment(
        &mut self,
        credential_hash: &CredentialHash,
        at: SystemTime,
    ) -> EnrollmentUse {
        self.enrollments
            .get_mut(credential_hash)
            .map_or(EnrollmentUse::Unknown, |enrollment| enrollment.consume(at))
    }

    pub fn issue_ingress_credential(
        &mut self,
        topology: &FleetTopologyFacts,
        credential: IngressCredentialRecord,
    ) -> Result<IngressCredentialIssue, FleetAccessFactsError> {
        if !topology.has_agent(credential.agent_id()) {
            return Ok(IngressCredentialIssue::UnknownAgent);
        }
        if self
            .ingress_credentials
            .contains_key(credential.credential_hash())
        {
            return Ok(IngressCredentialIssue::ExistingHash);
        }
        let mut replaced = false;
        for existing in self.ingress_credentials.values_mut() {
            if existing.agent_id() == credential.agent_id() && existing.revoked_at().is_none() {
                if existing.revoke(credential.issued_at()) != IngressCredentialRevocation::Revoked {
                    return Err(FleetAccessFactsError::InvalidIngressReplacement);
                }
                replaced = true;
            }
        }
        self.ingress_credentials
            .insert(credential.credential_hash().clone(), credential);
        Ok(if replaced {
            IngressCredentialIssue::Replaced
        } else {
            IngressCredentialIssue::Issued
        })
    }

    pub fn revoke_ingress_credential(
        &mut self,
        credential_hash: &CredentialHash,
        at: SystemTime,
    ) -> IngressCredentialRevocation {
        self.ingress_credentials
            .get_mut(credential_hash)
            .map_or(IngressCredentialRevocation::Unknown, |credential| {
                credential.revoke(at)
            })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetAccessFactsError {
    UnknownEnrollmentAgent,
    UnknownIngressAgent,
    DuplicateEnrollmentHash,
    DuplicateIngressHash,
    MultipleActiveIngressCredentials,
    InvalidIngressReplacement,
    InvalidIngressAuthentication,
}
