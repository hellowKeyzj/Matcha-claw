use super::*;

impl Reader<'_> {
    pub(super) fn audit_entry(
        &mut self,
        with_relations: bool,
    ) -> Result<FleetAuditEntry, StoreFault> {
        let sequence = self.u64()?;
        let event_name = self.string()?;
        let occurred_at = self.system_time()?;
        let message = self.optional_string()?;
        let relations = self.audit_relations(with_relations)?;
        let metadata = self.audit_fields(0)?;
        let event = FleetAuditEvent::new(FleetAuditEventInput {
            event_name,
            occurred_at,
            message,
            metadata,
            relations,
        })
        .map_err(|_| StoreFault::CorruptRecord)?;
        FleetAuditEntry::try_new(sequence, event).map_err(|_| StoreFault::CorruptRecord)
    }

    pub(super) fn audit_relations(
        &mut self,
        present: bool,
    ) -> Result<crate::audit::FleetAuditRelations, StoreFault> {
        if !present {
            return Ok(crate::audit::FleetAuditRelations::default());
        }
        crate::audit::FleetAuditRelations::new(
            self.optional_string()?,
            self.optional_string()?,
            self.optional_string()?,
            self.optional_string()?,
            self.optional_string()?,
            self.optional_string()?,
            self.optional_string()?,
            self.optional_string()?,
            self.optional_string()?,
        )
        .ok_or(StoreFault::CorruptRecord)
    }

    pub(super) fn audit_fields(
        &mut self,
        depth: usize,
    ) -> Result<std::collections::BTreeMap<String, FleetAuditValue>, StoreFault> {
        if depth > MAX_AUDIT_DEPTH {
            return Err(StoreFault::CorruptRecord);
        }
        let count = self.count()?;
        let mut fields = std::collections::BTreeMap::new();
        for _ in 0..count {
            let key = self.string()?;
            if fields.insert(key, self.audit_value(depth)?).is_some() {
                return Err(StoreFault::CorruptRecord);
            }
        }
        Ok(fields)
    }

    pub(super) fn audit_value(&mut self, depth: usize) -> Result<FleetAuditValue, StoreFault> {
        if depth > MAX_AUDIT_DEPTH {
            return Err(StoreFault::CorruptRecord);
        }
        match self.byte()? {
            0 => Ok(FleetAuditValue::Text(self.string()?)),
            1 => Ok(FleetAuditValue::Integer(self.i64()?)),
            2 => match self.byte()? {
                0 => Ok(FleetAuditValue::Boolean(false)),
                1 => Ok(FleetAuditValue::Boolean(true)),
                _ => Err(StoreFault::CorruptRecord),
            },
            3 => {
                let count = self.count()?;
                let mut values = Vec::with_capacity(count);
                for _ in 0..count {
                    values.push(self.audit_value(depth + 1)?);
                }
                Ok(FleetAuditValue::List(values))
            }
            4 => Ok(FleetAuditValue::Fields(self.audit_fields(depth + 1)?)),
            _ => Err(StoreFault::CorruptRecord),
        }
    }
}
