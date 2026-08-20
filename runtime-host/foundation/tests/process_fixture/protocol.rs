use std::{
    collections::{HashSet, hash_map::RandomState},
    fmt, fs,
    hash::{BuildHasher, Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const RECORDS_FILE: &str = "protocol.records";
static NONCE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

macro_rules! text_enum {
    (
        pub(crate) enum $name:ident {
            $($(#[$configuration:meta])* $variant:ident => $text:literal),+ $(,)?
        }
    ) => {
        #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
        pub(crate) enum $name {
            $($(#[$configuration])* $variant),+
        }

        impl $name {
            pub(crate) fn parse(value: &str) -> Result<Self, ProtocolError> {
                match value {
                    $($(#[$configuration])* $text => Ok(Self::$variant)),+,
                    _ => Err(ProtocolError::MalformedRecord),
                }
            }

            pub(crate) const fn as_str(self) -> &'static str {
                match self {
                    $($(#[$configuration])* Self::$variant => $text),+
                }
            }
        }
    };
}

text_enum! {
    pub(crate) enum Scenario {
        #[cfg(windows)] WindowsHostKilled => "windows-host-killed",
        #[cfg(unix)] PosixHostEof => "posix-host-eof",
        #[cfg(unix)] PosixGuardianKilled => "posix-guardian-killed",
    }
}

text_enum! {
    pub(crate) enum Role {
        Driver => "driver",
        SupervisorHost => "supervisor-host",
        Verifier => "verifier",
    }
}

text_enum! {
    pub(crate) enum Phase {
        Spawned => "spawned",
        Armed => "armed",
        Ready => "ready",
        Terminal => "terminal",
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct Nonce(String);

impl Nonce {
    pub(crate) fn generate() -> Self {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = NONCE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let process_id = std::process::id();
        let first = nonce_word(time, sequence, process_id, 0);
        let second = nonce_word(time, sequence, process_id, 1);
        Self(format!("{first:016x}{second:016x}"))
    }

    pub(crate) fn parse(value: &str) -> Result<Self, ProtocolError> {
        let is_lowercase_hex = value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if value.len() != 32 || !is_lowercase_hex {
            return Err(ProtocolError::MalformedRecord);
        }
        Ok(Self(value.to_owned()))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

fn nonce_word(time: u128, sequence: u64, process_id: u32, domain: u8) -> u64 {
    let mut hasher = RandomState::new().build_hasher();
    time.hash(&mut hasher);
    sequence.hash(&mut hasher);
    process_id.hash(&mut hasher);
    domain.hash(&mut hasher);
    hasher.finish()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProcessIdentity {
    pid: u32,
    creation_marker: u128,
}

impl ProcessIdentity {
    pub(crate) const fn new(pid: u32, creation_marker: u128) -> Self {
        Self {
            pid,
            creation_marker,
        }
    }

    pub(crate) const fn pid(self) -> u32 {
        self.pid
    }

    pub(crate) const fn creation_marker(self) -> u128 {
        self.creation_marker
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Record {
    nonce: Nonce,
    scenario: Scenario,
    role: Role,
    phase: Phase,
    identity: ProcessIdentity,
}

impl Record {
    pub(crate) fn new(
        nonce: Nonce,
        scenario: Scenario,
        role: Role,
        phase: Phase,
        identity: ProcessIdentity,
    ) -> Self {
        Self {
            nonce,
            scenario,
            role,
            phase,
            identity,
        }
    }

    pub(crate) fn parse(line: &str) -> Result<Self, ProtocolError> {
        let mut fields = line.split('\t');
        let nonce = Nonce::parse(next_field(&mut fields)?)?;
        let scenario = Scenario::parse(next_field(&mut fields)?)?;
        let role = Role::parse(next_field(&mut fields)?)?;
        let phase = Phase::parse(next_field(&mut fields)?)?;
        let pid = parse_decimal(next_field(&mut fields)?)?;
        let creation_marker = parse_decimal(next_field(&mut fields)?)?;
        if fields.next().is_some() {
            return Err(ProtocolError::MalformedRecord);
        }
        Ok(Self::new(
            nonce,
            scenario,
            role,
            phase,
            ProcessIdentity::new(pid, creation_marker),
        ))
    }

    pub(crate) fn encode(&self) -> String {
        format!(
            "{}\t{}\t{}\t{}\t{}\t{}",
            self.nonce.as_str(),
            self.scenario.as_str(),
            self.role.as_str(),
            self.phase.as_str(),
            self.identity.pid(),
            self.identity.creation_marker(),
        )
    }

    pub(crate) fn append_to(&self, directory: &FixtureDirectory) -> Result<(), ProtocolError> {
        let mut line = self.encode();
        line.push('\n');
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.path.join(RECORDS_FILE))
            .map_err(|_| ProtocolError::RecordAppendFailed)?;
        file.write_all(line.as_bytes())
            .map_err(|_| ProtocolError::RecordAppendFailed)
    }

    pub(crate) fn nonce(&self) -> &Nonce {
        &self.nonce
    }

    pub(crate) const fn scenario(&self) -> Scenario {
        self.scenario
    }

    pub(crate) const fn role(&self) -> Role {
        self.role
    }

    pub(crate) const fn phase(&self) -> Phase {
        self.phase
    }

    pub(crate) const fn identity(&self) -> ProcessIdentity {
        self.identity
    }
}

fn next_field<'a>(fields: &mut impl Iterator<Item = &'a str>) -> Result<&'a str, ProtocolError> {
    let value = fields.next().ok_or(ProtocolError::MalformedRecord)?;
    if value.is_empty() {
        return Err(ProtocolError::MalformedRecord);
    }
    Ok(value)
}

fn parse_decimal<T: std::str::FromStr>(value: &str) -> Result<T, ProtocolError> {
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ProtocolError::MalformedRecord);
    }
    value.parse().map_err(|_| ProtocolError::MalformedRecord)
}

pub(crate) struct FixtureDirectory {
    path: PathBuf,
    owned: bool,
}

impl FixtureDirectory {
    pub(crate) fn create(nonce: &Nonce) -> Result<Self, ProtocolError> {
        let path =
            std::env::temp_dir().join(format!("foundation-process-fixture-{}", nonce.as_str()));
        fs::create_dir(&path).map_err(|_| ProtocolError::DirectoryCreateFailed)?;
        Ok(Self { path, owned: true })
    }

    pub(crate) const fn from_existing(path: PathBuf) -> Self {
        Self { path, owned: false }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for FixtureDirectory {
    fn drop(&mut self) {
        if self.owned {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

pub(crate) fn read_verified_records(
    directory: &FixtureDirectory,
    expected_nonce: &Nonce,
) -> Result<Vec<Record>, ProtocolError> {
    let bytes =
        fs::read(directory.path.join(RECORDS_FILE)).map_err(|_| ProtocolError::RecordReadFailed)?;
    let contents = std::str::from_utf8(&bytes).map_err(|_| ProtocolError::MalformedRecord)?;
    if contents.is_empty() {
        return Ok(Vec::new());
    }

    let body = contents.strip_suffix('\n').unwrap_or(contents);
    let mut keys = HashSet::new();
    let mut records = Vec::new();
    for line in body.split('\n') {
        let record = Record::parse(line)?;
        if record.nonce() != expected_nonce {
            return Err(ProtocolError::NonceMismatch);
        }
        if !keys.insert((record.role(), record.phase())) {
            return Err(ProtocolError::DuplicateRecord);
        }
        records.push(record);
    }
    Ok(records)
}

pub(crate) fn unique_record(
    records: &[Record],
    role: Role,
    phase: Phase,
) -> Result<&Record, ProtocolError> {
    let mut matches = records
        .iter()
        .filter(|record| record.role() == role && record.phase() == phase);
    let record = matches.next().ok_or(ProtocolError::RecordNotFound)?;
    if matches.next().is_some() {
        return Err(ProtocolError::DuplicateRecord);
    }
    Ok(record)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProtocolError {
    DirectoryCreateFailed,
    RecordAppendFailed,
    RecordReadFailed,
    MalformedRecord,
    NonceMismatch,
    DuplicateRecord,
    RecordNotFound,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::DirectoryCreateFailed => "fixture directory creation failed",
            Self::RecordAppendFailed => "fixture record append failed",
            Self::RecordReadFailed => "fixture records could not be read",
            Self::MalformedRecord => "fixture record is malformed",
            Self::NonceMismatch => "fixture record nonce does not match",
            Self::DuplicateRecord => "fixture record role and phase are duplicated",
            Self::RecordNotFound => "fixture record was not found",
        })
    }
}

impl std::error::Error for ProtocolError {}

#[cfg(all(test, any(unix, windows)))]
mod tests {
    use super::*;

    #[cfg(windows)]
    const SCENARIO: Scenario = Scenario::WindowsHostKilled;
    #[cfg(unix)]
    const SCENARIO: Scenario = Scenario::PosixHostEof;

    fn record(nonce: Nonce, role: Role, phase: Phase) -> Record {
        Record::new(nonce, SCENARIO, role, phase, ProcessIdentity::new(41, 73))
    }

    #[test]
    fn enums_and_nonce_use_stable_strict_text() {
        assert_eq!(Scenario::parse(SCENARIO.as_str()).unwrap(), SCENARIO);
        assert_eq!(
            Role::parse("supervisor-host").unwrap(),
            Role::SupervisorHost
        );
        assert_eq!(Phase::parse("terminal").unwrap(), Phase::Terminal);
        assert!(matches!(
            Role::parse("SupervisorHost"),
            Err(ProtocolError::MalformedRecord)
        ));
        assert!(Nonce::parse("0123456789abcdef0123456789abcdef").is_ok());
        assert!(Nonce::parse("0123456789ABCDEF0123456789ABCDEF").is_err());
        assert!(Nonce::parse("g123456789abcdef0123456789abcdef").is_err());
    }

    #[test]
    fn record_requires_exactly_six_non_empty_columns_and_decimal_identity() {
        let nonce = Nonce::generate();
        let encoded = record(nonce, Role::Driver, Phase::Spawned).encode();
        assert_eq!(encoded.split('\t').count(), 6);
        assert!(Record::parse(&encoded).is_ok());

        let fields: Vec<_> = encoded.split('\t').collect();
        assert!(Record::parse(&fields[..5].join("\t")).is_err());
        assert!(Record::parse(&format!("{encoded}\textra")).is_err());
        for index in 0..6 {
            let mut empty = fields.clone();
            empty[index] = "";
            assert!(Record::parse(&empty.join("\t")).is_err());
        }
        assert!(
            Record::parse(&format!(
                "{}\t{}\tdriver\tspawned\t0x29\t73",
                fields[0], fields[1]
            ))
            .is_err()
        );
    }

    #[test]
    fn verifier_rejects_wrong_nonce() {
        let expected = Nonce::generate();
        let directory = FixtureDirectory::create(&expected).unwrap();
        record(Nonce::generate(), Role::Driver, Phase::Spawned)
            .append_to(&directory)
            .unwrap();

        assert_eq!(
            read_verified_records(&directory, &expected).unwrap_err(),
            ProtocolError::NonceMismatch
        );
    }

    #[test]
    fn verifier_rejects_an_extra_column_anywhere_in_the_file() {
        let nonce = Nonce::generate();
        let directory = FixtureDirectory::create(&nonce).unwrap();
        fs::write(
            directory.path().join(RECORDS_FILE),
            format!(
                "{}\textra\n",
                record(nonce.clone(), Role::Driver, Phase::Spawned).encode()
            ),
        )
        .unwrap();

        assert_eq!(
            read_verified_records(&directory, &nonce).unwrap_err(),
            ProtocolError::MalformedRecord
        );
    }

    #[test]
    fn verifier_rejects_duplicate_role_and_phase() {
        let nonce = Nonce::generate();
        let directory = FixtureDirectory::create(&nonce).unwrap();
        record(nonce.clone(), Role::Verifier, Phase::Terminal)
            .append_to(&directory)
            .unwrap();
        record(nonce.clone(), Role::Verifier, Phase::Terminal)
            .append_to(&directory)
            .unwrap();

        assert_eq!(
            read_verified_records(&directory, &nonce).unwrap_err(),
            ProtocolError::DuplicateRecord
        );
    }

    #[test]
    fn unique_record_queries_the_verified_role_and_phase() {
        let nonce = Nonce::generate();
        let directory = FixtureDirectory::create(&nonce).unwrap();
        record(nonce.clone(), Role::Driver, Phase::Ready)
            .append_to(&directory)
            .unwrap();
        let records = read_verified_records(&directory, &nonce).unwrap();

        let ready = unique_record(&records, Role::Driver, Phase::Ready).unwrap();
        assert_eq!(ready.scenario(), SCENARIO);
        assert_eq!(ready.identity(), ProcessIdentity::new(41, 73));
        assert_eq!(
            unique_record(&records, Role::Verifier, Phase::Ready).unwrap_err(),
            ProtocolError::RecordNotFound
        );
    }

    #[test]
    fn fixture_directory_removes_only_its_owned_directory() {
        let nonce = Nonce::generate();
        let owned = FixtureDirectory::create(&nonce).unwrap();
        let path = owned.path().to_owned();
        assert!(matches!(
            FixtureDirectory::create(&nonce),
            Err(ProtocolError::DirectoryCreateFailed)
        ));

        let existing = FixtureDirectory::from_existing(path.clone());
        drop(existing);
        assert!(path.is_dir());
        drop(owned);
        assert!(!path.exists());
    }
}
