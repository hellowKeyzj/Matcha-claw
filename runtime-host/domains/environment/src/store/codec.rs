use std::io::{Read, Write};

use crate::definition::{
    BrowserMode, ChannelAccountId, ChannelDirectMessagePolicy, ChannelOperationalDesired,
    ChannelReference, ConnectorReference, CredentialReference, DesiredConfiguration,
    DesiredDefinition, EnvironmentId, EnvironmentRevision, ExtensionReference, PolicyReference,
    ProviderReference, SecurityPreset, ToolchainReference,
};

use super::{AppliedEvidence, DecodeFault, EnvironmentFacts, StoreFault, UpgradeFault};

pub(super) const CURRENT_SCHEMA_VERSION: u8 = 3;
pub(super) const LOG_MAGIC: [u8; 8] = *b"MENVDUR1";
pub(super) const HEADER_LEN: usize = LOG_MAGIC.len() + 1 + 8;
const FRAME_MARKER: u8 = 0xA1;
const FRAME_METADATA_LEN: usize = 16;
pub(super) const MAX_FACTS_BYTES: usize = 1024 * 1024;
pub(super) const MAX_LOG_BYTES: u64 = 16 * 1024 * 1024;
const MAX_COLLECTION_ENTRIES: usize = 16_384;
const MAX_REFERENCE_BYTES: usize = 16 * 1024;

pub(super) struct RecoveredFacts {
    pub(super) facts: Vec<EnvironmentFacts>,
    pub(super) epoch: u64,
    pub(super) committed_len: u64,
    pub(super) truncated_tail: bool,
}

pub(super) fn initialize_log(mut output: impl Write) -> Result<(), StoreFault> {
    output
        .write_all(&LOG_MAGIC)
        .and_then(|()| output.write_all(&[CURRENT_SCHEMA_VERSION]))
        .and_then(|()| output.write_all(&0_u64.to_le_bytes()))
        .map_err(|error| StoreFault::Commit(error.kind()))
}

pub(super) fn recover_log(mut input: impl Read) -> Result<RecoveredFacts, StoreFault> {
    let mut content = Vec::new();
    input
        .by_ref()
        .take(MAX_LOG_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|error| StoreFault::Read(error.kind()))?;
    if content.len() > MAX_LOG_BYTES as usize {
        return Err(StoreFault::LogFull);
    }
    if content.len() < HEADER_LEN || content[..LOG_MAGIC.len()] != LOG_MAGIC {
        return Err(DecodeFault::CorruptRecord.into());
    }
    let schema = content[LOG_MAGIC.len()];
    if schema != CURRENT_SCHEMA_VERSION {
        return Err(UpgradeFault::UnsupportedSchemaVersion(schema).into());
    }
    let mut expected_epoch = u64::from_le_bytes(
        content[LOG_MAGIC.len() + 1..HEADER_LEN]
            .try_into()
            .map_err(|_| DecodeFault::CorruptRecord)?,
    );
    let mut facts = Vec::new();
    let mut offset = HEADER_LEN;
    let mut committed_len = HEADER_LEN;
    let mut truncated_tail = false;

    while offset < content.len() {
        let frame_start = offset;
        if content[offset] != FRAME_MARKER {
            return Err(DecodeFault::CorruptRecord.into());
        }
        offset += 1;
        let metadata_end = offset
            .checked_add(FRAME_METADATA_LEN)
            .ok_or(DecodeFault::CorruptRecord)?;
        if metadata_end > content.len() {
            truncated_tail = true;
            break;
        }
        let metadata = &content[offset..metadata_end];
        offset = metadata_end;
        let frame_epoch = u64::from_le_bytes(
            metadata[..8]
                .try_into()
                .map_err(|_| DecodeFault::CorruptRecord)?,
        );
        let payload_len = usize::try_from(u32::from_le_bytes(
            metadata[8..12]
                .try_into()
                .map_err(|_| DecodeFault::CorruptRecord)?,
        ))
        .map_err(|_| DecodeFault::CorruptRecord)?;
        if payload_len > MAX_FACTS_BYTES {
            return Err(DecodeFault::CorruptRecord.into());
        }
        let expected_checksum = u32::from_le_bytes(
            metadata[12..]
                .try_into()
                .map_err(|_| DecodeFault::CorruptRecord)?,
        );
        let payload_end = offset
            .checked_add(payload_len)
            .ok_or(DecodeFault::CorruptRecord)?;
        if payload_end > content.len() {
            truncated_tail = true;
            break;
        }
        let payload = &content[offset..payload_end];
        offset = payload_end;
        if checksum(payload) != expected_checksum {
            return Err(DecodeFault::CorruptRecord.into());
        }
        let next_epoch = expected_epoch
            .checked_add(1)
            .ok_or(StoreFault::EpochOverflow)?;
        if frame_epoch != next_epoch {
            return Err(DecodeFault::CorruptRecord.into());
        }
        let next_facts = decode_facts(payload)?;
        validate_facts_transition(&facts, &next_facts)?;
        facts = next_facts;
        expected_epoch = frame_epoch;
        committed_len = offset;
        debug_assert!(committed_len > frame_start);
    }

    Ok(RecoveredFacts {
        facts,
        epoch: expected_epoch,
        committed_len: u64::try_from(committed_len).map_err(|_| StoreFault::LogFull)?,
        truncated_tail,
    })
}

pub(super) fn encode_frame(epoch: u64, facts: &[EnvironmentFacts]) -> Result<Vec<u8>, StoreFault> {
    let payload = encode_facts(facts)?;
    if payload.len() > MAX_FACTS_BYTES {
        return Err(StoreFault::RecordTooLarge);
    }
    let checksum = checksum(&payload);
    let payload_len = u32::try_from(payload.len()).map_err(|_| StoreFault::RecordTooLarge)?;
    let mut frame = Vec::with_capacity(1 + FRAME_METADATA_LEN + payload.len());
    frame.push(FRAME_MARKER);
    frame.extend_from_slice(&epoch.to_le_bytes());
    frame.extend_from_slice(&payload_len.to_le_bytes());
    frame.extend_from_slice(&checksum.to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

fn encode_facts(facts: &[EnvironmentFacts]) -> Result<Vec<u8>, StoreFault> {
    let mut output = Vec::new();
    push_count(&mut output, facts.len())?;
    for facts in facts {
        output.push(u8::from(facts.is_tombstone()));
        encode_desired(&mut output, facts.desired())?;
        match facts.applied() {
            Some(evidence) => {
                output.push(1);
                output.extend_from_slice(&evidence.revision().get().to_le_bytes());
            }
            None => output.push(0),
        }
    }
    Ok(output)
}

fn decode_facts(content: &[u8]) -> Result<Vec<EnvironmentFacts>, StoreFault> {
    let mut reader = Reader::new(content);
    let count = reader.count()?;
    let mut facts = Vec::with_capacity(count);
    for _ in 0..count {
        let tombstone = match reader.byte()? {
            0 => false,
            1 => true,
            _ => return Err(DecodeFault::CorruptRecord.into()),
        };
        let desired = reader.desired()?;
        let applied = match reader.byte()? {
            0 => None,
            1 if !tombstone => Some(AppliedEvidence::new(reader.revision()?)),
            _ => return Err(DecodeFault::CorruptRecord.into()),
        };
        if applied.is_some_and(|evidence| evidence.revision() > desired.revision()) {
            return Err(DecodeFault::InvalidFacts.into());
        }
        facts.push(if tombstone {
            EnvironmentFacts::tombstone(desired)
        } else {
            EnvironmentFacts::new(desired, applied)
        });
    }
    reader.finish()?;
    ensure_unique_environments(&facts)?;
    Ok(facts)
}

fn ensure_unique_environments(facts: &[EnvironmentFacts]) -> Result<(), StoreFault> {
    for (index, current) in facts.iter().enumerate() {
        if facts[..index]
            .iter()
            .any(|prior| prior.environment_id() == current.environment_id())
        {
            return Err(DecodeFault::InvalidFacts.into());
        }
    }
    Ok(())
}

fn validate_facts_transition(
    current_facts: &[EnvironmentFacts],
    next_facts: &[EnvironmentFacts],
) -> Result<(), StoreFault> {
    for current in current_facts {
        if !next_facts
            .iter()
            .any(|next| next.environment_id() == current.environment_id())
        {
            return Err(DecodeFault::InvalidFacts.into());
        }
    }

    for next in next_facts {
        let Some(current) = current_facts
            .iter()
            .find(|current| current.environment_id() == next.environment_id())
        else {
            if next.desired_revision().get() != 1 || next.is_tombstone() || next.applied().is_some()
            {
                return Err(DecodeFault::InvalidFacts.into());
            }
            continue;
        };

        let valid_tombstone = next.is_tombstone()
            && next.desired_revision() == current.desired_revision()
            && (current.is_tombstone() || next.applied().is_none());
        let valid_active = !next.is_tombstone()
            && !current.is_tombstone()
            && next.desired_revision() == current.desired_revision()
            && next.desired() == current.desired()
            && !applied_evidence_recedes(current, next);
        let valid_recreate = !next.is_tombstone()
            && current.is_tombstone()
            && current.desired_revision().next().ok() == Some(next.desired_revision())
            && next.applied().is_none();
        let valid_replace = !next.is_tombstone()
            && !current.is_tombstone()
            && current.desired_revision().next().ok() == Some(next.desired_revision())
            && !applied_evidence_recedes(current, next);
        if !(valid_tombstone || valid_active || valid_recreate || valid_replace) {
            return Err(DecodeFault::InvalidFacts.into());
        }
    }
    Ok(())
}

fn applied_evidence_recedes(current: &EnvironmentFacts, next: &EnvironmentFacts) -> bool {
    match (current.applied(), next.applied()) {
        (Some(_), None) => true,
        (Some(current), Some(next)) => next.revision() < current.revision(),
        (None, _) => false,
    }
}

fn encode_desired(output: &mut Vec<u8>, desired: &DesiredDefinition) -> Result<(), StoreFault> {
    push_string(output, desired.environment_id().as_str())?;
    output.extend_from_slice(&desired.revision().get().to_le_bytes());
    push_string(output, desired.provider().as_str())?;
    push_references(output, desired.connectors())?;
    push_references(output, desired.extensions())?;
    push_references(output, desired.channels())?;
    push_references(output, desired.credential_references())?;
    push_references(output, desired.policies())?;
    push_references(output, desired.toolchains())?;
    output.push(desired.security_preset().encode());
    output.push(desired.browser_mode().encode());
    push_count(output, desired.operational_channels().len())?;
    for channel in desired.operational_channels() {
        push_string(output, channel.channel().as_str())?;
        push_string(output, channel.account().as_str())?;
        output.push(u8::from(channel.enabled()));
        output.push(channel.direct_message_policy().encode());
    }
    Ok(())
}

fn push_references<T: Reference>(output: &mut Vec<u8>, references: &[T]) -> Result<(), StoreFault> {
    push_count(output, references.len())?;
    for reference in references {
        push_string(output, reference.as_str())?;
    }
    Ok(())
}

fn push_count(output: &mut Vec<u8>, count: usize) -> Result<(), StoreFault> {
    if count > MAX_COLLECTION_ENTRIES {
        return Err(StoreFault::RecordTooLarge);
    }
    let count = u32::try_from(count).map_err(|_| StoreFault::RecordTooLarge)?;
    output.extend_from_slice(&count.to_le_bytes());
    Ok(())
}

fn push_string(output: &mut Vec<u8>, value: &str) -> Result<(), StoreFault> {
    if value.len() > MAX_REFERENCE_BYTES {
        return Err(StoreFault::RecordTooLarge);
    }
    let length = u32::try_from(value.len()).map_err(|_| StoreFault::RecordTooLarge)?;
    output.extend_from_slice(&length.to_le_bytes());
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn checksum(content: &[u8]) -> u32 {
    let mut value = 0x811C_9DC5_u32;
    for byte in content {
        value ^= u32::from(*byte);
        value = value.wrapping_mul(0x0100_0193);
    }
    value
}

trait Reference {
    fn as_str(&self) -> &str;
}

macro_rules! reference {
    ($($type:ty),+ $(,)?) => {
        $(
            impl Reference for $type {
                fn as_str(&self) -> &str {
                    self.as_str()
                }
            }
        )+
    };
}

reference!(
    ConnectorReference,
    ExtensionReference,
    ChannelReference,
    CredentialReference,
    PolicyReference,
    ToolchainReference,
);

struct Reader<'a> {
    remaining: &'a [u8],
}

impl<'a> Reader<'a> {
    const fn new(content: &'a [u8]) -> Self {
        Self { remaining: content }
    }

    fn finish(self) -> Result<(), StoreFault> {
        if self.remaining.is_empty() {
            Ok(())
        } else {
            Err(DecodeFault::CorruptRecord.into())
        }
    }

    fn byte(&mut self) -> Result<u8, StoreFault> {
        Ok(*self
            .take(1)?
            .first()
            .expect("one requested byte must exist"))
    }

    fn count(&mut self) -> Result<usize, StoreFault> {
        let count = usize::try_from(self.u32()?).map_err(|_| DecodeFault::CorruptRecord)?;
        if count > MAX_COLLECTION_ENTRIES {
            return Err(DecodeFault::CorruptRecord.into());
        }
        Ok(count)
    }

    fn revision(&mut self) -> Result<EnvironmentRevision, StoreFault> {
        let bytes: [u8; 8] = self
            .take(8)?
            .try_into()
            .map_err(|_| DecodeFault::CorruptRecord)?;
        EnvironmentRevision::try_new(u64::from_le_bytes(bytes))
            .map_err(|_| DecodeFault::InvalidFacts.into())
    }

    fn desired(&mut self) -> Result<DesiredDefinition, StoreFault> {
        let environment_id =
            EnvironmentId::try_new(self.string()?).map_err(|_| DecodeFault::InvalidFacts)?;
        let revision = self.revision()?;
        let provider =
            ProviderReference::try_new(self.string()?).map_err(|_| DecodeFault::InvalidFacts)?;
        let connectors = self.references(ConnectorReference::try_new)?;
        let extensions = self.references(ExtensionReference::try_new)?;
        let channels = self.references(ChannelReference::try_new)?;
        let credential_references = self.references(CredentialReference::try_new)?;
        let policies = self.references(PolicyReference::try_new)?;
        let toolchains = self.references(ToolchainReference::try_new)?;
        let security_preset =
            SecurityPreset::decode(self.byte()?).ok_or(DecodeFault::InvalidFacts)?;
        let browser_mode = BrowserMode::decode(self.byte()?).ok_or(DecodeFault::InvalidFacts)?;
        let operational_channels = self.operational_channels()?;
        let configuration = DesiredConfiguration::try_new(
            connectors,
            extensions,
            channels,
            credential_references,
            policies,
            toolchains,
            security_preset,
            browser_mode,
            operational_channels,
        )
        .map_err(|_| DecodeFault::InvalidFacts)?;
        Ok(DesiredDefinition::new(
            environment_id,
            revision,
            provider,
            configuration,
        ))
    }

    fn operational_channels(&mut self) -> Result<Vec<ChannelOperationalDesired>, StoreFault> {
        let count = self.count()?;
        let mut channels = Vec::with_capacity(count);
        for _ in 0..count {
            let channel =
                ChannelReference::try_new(self.string()?).map_err(|_| DecodeFault::InvalidFacts)?;
            let account =
                ChannelAccountId::try_new(self.string()?).map_err(|_| DecodeFault::InvalidFacts)?;
            let enabled = match self.byte()? {
                0 => false,
                1 => true,
                _ => return Err(DecodeFault::InvalidFacts.into()),
            };
            let direct_message_policy = ChannelDirectMessagePolicy::decode(self.byte()?)
                .ok_or(DecodeFault::InvalidFacts)?;
            channels.push(ChannelOperationalDesired::new(
                channel,
                account,
                enabled,
                direct_message_policy,
            ));
        }
        Ok(channels)
    }

    fn references<T, E>(
        &mut self,
        parse: impl Fn(String) -> Result<T, E>,
    ) -> Result<Vec<T>, StoreFault> {
        let count = self.count()?;
        let mut references = Vec::with_capacity(count);
        for _ in 0..count {
            references.push(parse(self.string()?).map_err(|_| DecodeFault::InvalidFacts)?);
        }
        Ok(references)
    }

    fn string(&mut self) -> Result<String, StoreFault> {
        let length = self.count()?;
        if length > MAX_REFERENCE_BYTES {
            return Err(DecodeFault::CorruptRecord.into());
        }
        let value = self.take(length)?;
        std::str::from_utf8(value)
            .map(str::to_owned)
            .map_err(|_| DecodeFault::CorruptRecord.into())
    }

    fn u32(&mut self) -> Result<u32, StoreFault> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| DecodeFault::CorruptRecord)?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], StoreFault> {
        if self.remaining.len() < count {
            return Err(DecodeFault::CorruptRecord.into());
        }
        let (value, remaining) = self.remaining.split_at(count);
        self.remaining = remaining;
        Ok(value)
    }
}
