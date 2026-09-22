use crate::ports::{
    SealedResourceRead, SealedSkillCatalog, SealedSkillCatalogEntry, SealedSkillError,
};

pub trait SealedCatalogProjection {
    type Entry: SealedEntryProjection;

    fn entries(&self) -> &[Self::Entry];
}

pub trait SealedEntryProjection {
    fn skill_key(&self) -> &str;
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn runtime_target(&self) -> &'static str;
}

pub trait SealedReadProjection {
    fn content(&self) -> &[u8];
    fn metering_binding(&self) -> Option<&str>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SealedErrorKind {
    AlreadyExists,
    NotFound,
    Rejected,
    Unknown,
}

pub trait SealedErrorProjection {
    fn sealed_error_kind(&self) -> SealedErrorKind;
}

pub fn project_catalog<C>(catalog: C) -> SealedSkillCatalog
where
    C: SealedCatalogProjection,
{
    SealedSkillCatalog::new(catalog.entries().iter().map(project_entry_ref).collect())
}

pub fn project_entry<E>(entry: E) -> SealedSkillCatalogEntry
where
    E: SealedEntryProjection,
{
    project_entry_ref(&entry)
}

pub fn project_read<R>(read: R) -> SealedResourceRead
where
    R: SealedReadProjection,
{
    SealedResourceRead::new(
        read.content().to_vec(),
        read.metering_binding().map(str::to_owned),
    )
}

pub fn project_error<E>(error: E) -> SealedSkillError
where
    E: SealedErrorProjection,
{
    project_error_kind(error.sealed_error_kind())
}

pub const fn rejected_error() -> SealedSkillError {
    SealedSkillError::Rejected
}

fn project_entry_ref<E>(entry: &E) -> SealedSkillCatalogEntry
where
    E: SealedEntryProjection + ?Sized,
{
    SealedSkillCatalogEntry::new(
        entry.skill_key().to_owned(),
        entry.name().to_owned(),
        entry.description().to_owned(),
        entry.runtime_target(),
    )
}

const fn project_error_kind(kind: SealedErrorKind) -> SealedSkillError {
    match kind {
        SealedErrorKind::AlreadyExists => SealedSkillError::AlreadyExists,
        SealedErrorKind::NotFound => SealedSkillError::NotFound,
        SealedErrorKind::Rejected => SealedSkillError::Rejected,
        SealedErrorKind::Unknown => SealedSkillError::Unknown,
    }
}
