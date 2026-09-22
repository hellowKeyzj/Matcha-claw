use super::*;

impl Reader<'_> {
    pub(super) fn secret_references(&mut self) -> Result<Vec<FleetSecretRef>, StoreFault> {
        let count = self.count()?;
        (0..count)
            .map(|_| {
                FleetSecretRef::from_serialized(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)
            })
            .collect()
    }

    pub(super) fn audit_entries(
        &mut self,
        with_relations: bool,
    ) -> Result<Vec<FleetAuditEntry>, StoreFault> {
        let count = self.count()?;
        (0..count)
            .map(|_| self.audit_entry(with_relations))
            .collect()
    }

    pub(super) fn enrollments(&mut self) -> Result<Vec<EnrollmentRecord>, StoreFault> {
        (0..self.count()?)
            .map(|_| {
                EnrollmentRecord::restore(
                    self.native_agent_id()?,
                    CredentialHash::try_new(self.string()?)
                        .map_err(|_| StoreFault::CorruptRecord)?,
                    self.system_time()?,
                    self.system_time()?,
                    self.optional_system_time()?,
                )
                .map_err(|_| StoreFault::CorruptRecord)
            })
            .collect()
    }

    pub(super) fn ingress_credentials(
        &mut self,
    ) -> Result<Vec<IngressCredentialRecord>, StoreFault> {
        (0..self.count()?)
            .map(|_| {
                IngressCredentialRecord::restore(
                    self.native_agent_id()?,
                    CredentialHash::try_new(self.string()?)
                        .map_err(|_| StoreFault::CorruptRecord)?,
                    self.system_time()?,
                    self.optional_system_time()?,
                )
                .map_err(|_| StoreFault::CorruptRecord)
            })
            .collect()
    }
}
