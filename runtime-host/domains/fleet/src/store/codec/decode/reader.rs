use super::*;

pub(super) struct Reader<'a> {
    remaining: &'a [u8],
}

impl<'a> Reader<'a> {
    pub(super) const fn new(content: &'a [u8]) -> Self {
        Self { remaining: content }
    }

    pub(super) fn finish(self) -> Result<(), StoreFault> {
        if self.remaining.is_empty() {
            Ok(())
        } else {
            Err(StoreFault::CorruptRecord)
        }
    }

    pub(super) fn optional_string(&mut self) -> Result<Option<String>, StoreFault> {
        match self.byte()? {
            0 => Ok(None),
            1 => self.string().map(Some),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn optional_system_time(
        &mut self,
    ) -> Result<Option<std::time::SystemTime>, StoreFault> {
        match self.byte()? {
            0 => Ok(None),
            1 => self.system_time().map(Some),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn system_time(&mut self) -> Result<std::time::SystemTime, StoreFault> {
        let seconds = self.u64()?;
        let nanoseconds = self.u32()?;
        if nanoseconds >= 1_000_000_000 {
            return Err(StoreFault::CorruptRecord);
        }
        std::time::SystemTime::UNIX_EPOCH
            .checked_add(std::time::Duration::new(seconds, nanoseconds))
            .ok_or(StoreFault::CorruptRecord)
    }

    pub(super) fn string(&mut self) -> Result<String, StoreFault> {
        let length = self.count()?;
        if length > MAX_STRING_BYTES {
            return Err(StoreFault::CorruptRecord);
        }
        let value = self.take(length)?;
        std::str::from_utf8(value)
            .map(str::to_owned)
            .map_err(|_| StoreFault::CorruptRecord)
    }

    pub(super) fn count(&mut self) -> Result<usize, StoreFault> {
        let count = usize::try_from(self.u32()?).map_err(|_| StoreFault::CorruptRecord)?;
        if count > MAX_COLLECTION_ENTRIES {
            return Err(StoreFault::CorruptRecord);
        }
        Ok(count)
    }

    pub(super) fn byte(&mut self) -> Result<u8, StoreFault> {
        Ok(*self
            .take(1)?
            .first()
            .expect("one requested byte must exist"))
    }

    pub(super) fn u16(&mut self) -> Result<u16, StoreFault> {
        Ok(u16::from_le_bytes(
            self.take(2)?
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
        ))
    }

    pub(super) fn u32(&mut self) -> Result<u32, StoreFault> {
        Ok(u32::from_le_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
        ))
    }

    pub(super) fn u64(&mut self) -> Result<u64, StoreFault> {
        Ok(u64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
        ))
    }

    pub(super) fn i64(&mut self) -> Result<i64, StoreFault> {
        Ok(i64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
        ))
    }

    pub(super) fn take(&mut self, count: usize) -> Result<&'a [u8], StoreFault> {
        if self.remaining.len() < count {
            return Err(StoreFault::CorruptRecord);
        }
        let (value, remaining) = self.remaining.split_at(count);
        self.remaining = remaining;
        Ok(value)
    }
}
