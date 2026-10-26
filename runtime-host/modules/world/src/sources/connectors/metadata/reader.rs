use tokio_postgres::{Row, types::ToSql};
use world_protocol::{
    authorization::ActualImpact,
    bindings::ImplementationRef,
    facts::SourceAuthority,
    ids::*,
    package::RequestedAccess,
    releases::{BranchRef, Release, WorldBranch},
    sources::AuthorityRef,
    time::Timestamp,
};

use super::super::SourceError;
use crate::{
    authorization::{self, Admission},
    extensions::package,
    store::{WorldSnapshot, WorldTransaction},
};

pub(super) enum Reader<'a, 'b> {
    Snapshot(&'a WorldSnapshot<'b>),
    Transaction(&'a WorldTransaction<'b>),
}
impl Reader<'_, '_> {
    pub(super) fn world(&self) -> &WorldRef {
        match self {
            Self::Snapshot(snapshot) => snapshot.world(),
            Self::Transaction(tx) => tx.world(),
        }
    }
    pub(super) async fn now(&self) -> Result<Timestamp, SourceError> {
        Ok(match self {
            Self::Snapshot(snapshot) => snapshot.now().await?,
            Self::Transaction(tx) => tx.now().await?,
        })
    }
    pub(super) async fn query_opt(
        &self,
        sql: &'static str,
        locked: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, SourceError> {
        Ok(match self {
            Self::Snapshot(snapshot) => snapshot.query_opt(sql, parameters).await?,
            Self::Transaction(tx) => tx.query_opt(locked, parameters).await?,
        })
    }
    pub(super) async fn recheck(
        &self,
        admission: &Admission,
        now: &Timestamp,
    ) -> Result<(), SourceError> {
        match self {
            Self::Snapshot(snapshot) => {
                authorization::recheck_read(snapshot, admission, now).await?;
            }
            Self::Transaction(tx) => {
                authorization::recheck(tx, admission, now).await?;
            }
        }
        Ok(())
    }
    pub(super) async fn active_model(&self) -> Result<Option<Release>, SourceError> {
        match self {
            Self::Snapshot(snapshot) => {
                let Some(id) = crate::releases::read_active_release_snapshot(snapshot).await?
                else {
                    return Ok(None);
                };
                crate::releases::read_release_snapshot(snapshot, &id)
                    .await?
                    .ok_or_else(|| {
                        SourceError::new(
                            world_protocol::sources::SourceFailure::Release {
                                failure: Box::new(
                                    world_protocol::releases::ReleaseFailure::ReleaseMissing {
                                        release_id: id,
                                    },
                                ),
                            },
                            world_protocol::failure::FailureStage::Read,
                        )
                    })
                    .map(Some)
            }
            Self::Transaction(tx) => Ok(crate::releases::read_active_model(tx).await?),
        }
    }
    pub(super) async fn branch(
        &self,
        reference: &BranchRef,
    ) -> Result<Option<WorldBranch>, SourceError> {
        Ok(match self {
            Self::Snapshot(snapshot) => {
                crate::releases::read_branch_revision_snapshot(snapshot, reference).await?
            }
            Self::Transaction(tx) => crate::releases::read_branch_revision(tx, reference).await?,
        })
    }
    pub(super) async fn current_branch(
        &self,
        reference: &BranchRef,
    ) -> Result<Option<WorldBranch>, SourceError> {
        Ok(match self {
            Self::Snapshot(snapshot) => {
                crate::releases::read_branch_snapshot(snapshot, &reference.id).await?
            }
            Self::Transaction(tx) => crate::releases::read_branch(tx, &reference.id).await?,
        })
    }
    pub(super) async fn authority(
        &self,
        branch: Option<&BranchRef>,
        binding: &DefinitionRef,
        authority: &AuthorityRef,
    ) -> Result<Option<SourceAuthority>, SourceError> {
        Ok(match (self, branch) {
            (Self::Snapshot(snapshot), Some(branch)) => {
                crate::sources::mapping::read_branch_authority_snapshot(
                    snapshot, branch, binding, authority,
                )
                .await?
            }
            (Self::Snapshot(snapshot), None) => {
                crate::sources::mapping::read_authority_snapshot(snapshot, binding, authority)
                    .await?
            }
            (Self::Transaction(tx), Some(branch)) => {
                crate::sources::mapping::read_branch_authority(tx, branch, binding, authority)
                    .await?
            }
            (Self::Transaction(tx), None) => {
                crate::sources::mapping::read_authority(tx, binding, authority).await?
            }
        })
    }
    pub(super) async fn grants(
        &self,
        implementation: &ImplementationRef,
        required: &[RequestedAccess],
    ) -> Result<(), SourceError> {
        match self {
            Self::Snapshot(snapshot) => {
                package::require_grants_read(snapshot, implementation, required).await?
            }
            Self::Transaction(tx) => package::require_grants(tx, implementation, required).await?,
        }
        Ok(())
    }
    pub(super) async fn output(
        &self,
        admission: &Admission,
        impact: &ActualImpact,
        delivered: u64,
        now: &Timestamp,
    ) -> Result<(), SourceError> {
        match self {
            Self::Snapshot(snapshot) => {
                authorization::check_admitted_output_read(
                    snapshot, admission, impact, delivered, now,
                )
                .await?;
            }
            Self::Transaction(tx) => {
                authorization::check_admitted_output(tx, admission, impact, delivered, now).await?;
            }
        }
        Ok(())
    }
}
