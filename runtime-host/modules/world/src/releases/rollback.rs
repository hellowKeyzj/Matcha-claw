use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    compiler::GeneratedArtifact,
    ids::{ContentId, Digest, Revision, ScopeId},
    materials::BlobRef,
    releases::{Release, ReleaseFailure, ReleaseHead, ReleaseHeadCas},
};

use super::{
    Error,
    publication::{authorize, cancelled, invalid, require_head},
};
use crate::{
    authorization::{self, Admission},
    content::{self, BlobPin, Content, ContentOwner, ContentReference, PinKind},
    definitions::canonical_digest,
    store::{Committed, WorldStore, WorldTransaction},
};

/// Durable SQL result only. No decoded content or availability assertion crosses this boundary.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RollbackPins {
    release: Release,
    head: ReleaseHeadCas,
    pins: Vec<(ContentId, BlobPin)>,
}

/// Only full, hash-checked reads of the committed pins can construct this proof.
pub(crate) struct PreparedRollback {
    pinned: Committed<RollbackPins>,
}

/// Run in a short transaction and confirm its original CommitId before reading any bytes.
pub(crate) async fn pin_rollback(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    head: &ReleaseHeadCas,
    cancellation: &CancellationToken,
) -> Result<RollbackPins, Error> {
    super::require_writer(tx)?;
    cancelled(cancellation)?;
    if &head.world != tx.world() || head.expected.is_none() {
        return Err(invalid("head"));
    }
    let release = super::read_release(tx, &head.next).await?.ok_or_else(|| {
        ReleaseFailure::ReleaseMissing {
            release_id: head.next.clone(),
        }
    })?;
    let scope = release_scope(tx, &release).await?;
    authorize(
        tx,
        admission,
        &scope,
        &release.definitions,
        &release.sources,
        head,
        None,
    )
    .await?;
    require_head(tx, head).await?;
    require_runtime(tx, &release).await?;
    let references = references(&release)?;
    let mut pins = Vec::with_capacity(references.len());
    for (index, reference) in references.iter().enumerate() {
        cancelled(cancellation)?;
        let digest = canonical_digest(&(
            tx.world(),
            "rollback.pin",
            tx.commit_id(),
            &release.artifact.digest,
            index,
        ))?;
        let id = ContentId::try_new(format!("rollback-{}", &digest.as_str()[7..]))
            .map_err(|_| invalid("pinId"))?;
        let pin = content::pin(tx, reference, id.clone(), PinKind::Read).await?;
        pins.push((id, pin));
    }
    authorization::recheck(tx, admission, &tx.now().await?).await?;
    Ok(RollbackPins {
        release,
        head: head.clone(),
        pins,
    })
}

/// No SQL transaction is held while artifact bytes are read, hashed, or decoded.
pub(crate) async fn validate_rollback(
    content: &Content,
    store: &WorldStore,
    pinned: &Committed<RollbackPins>,
    cancellation: &CancellationToken,
) -> Result<PreparedRollback, Error> {
    cancelled(cancellation)?;
    let release = &pinned.value.release;
    if content.world() != &release.world || pinned.receipt.world != release.world {
        return Err(invalid("world"));
    }
    let references = references(release)?;
    if references.len() != pinned.value.pins.len() {
        return Err(invalid("pins"));
    }
    let mut outputs = Vec::with_capacity(release.artifact.outputs.len());
    for (index, ((_, pin), reference)) in pinned.value.pins.iter().zip(&references).enumerate() {
        cancelled(cancellation)?;
        if pin.reference() != &reference.blob {
            return Err(invalid("pin"));
        }
        let committed = Committed {
            value: pin.clone(),
            receipt: pinned.receipt.clone(),
            replayed: pinned.replayed,
        };
        let bytes = content.read_pinned(store, &committed).await?;
        if let Some(output) = release.artifact.outputs.get(index) {
            outputs.push(GeneratedArtifact {
                kind: output.kind,
                definition: output.definition.clone(),
                contract: output.contract.clone(),
                schema_digest: output.schema_digest.clone(),
                relative_path: None,
                bytes,
                content_digest: output.content.digest.clone(),
            });
        } else {
            let decoded: world_protocol::compiler::ArtifactManifest =
                serde_json::from_slice(&bytes)?;
            if decoded != release.artifact {
                return Err(invalid("manifest"));
            }
        }
    }
    super::validate_manifest(&release.artifact)?;
    crate::compiler::validate_outputs(&outputs)?;
    cancelled(cancellation)?;
    Ok(PreparedRollback {
        pinned: Committed {
            value: pinned.value.clone(),
            receipt: pinned.receipt.clone(),
            replayed: pinned.replayed,
        },
    })
}

/// Switching an exact release reverses neither source effects nor historical authorization.
pub(crate) async fn rollback(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    prepared: &PreparedRollback,
    cancellation: &CancellationToken,
) -> Result<ReleaseHead, Error> {
    super::require_writer(tx)?;
    cancelled(cancellation)?;
    let pinned = &prepared.pinned.value;
    if &pinned.head.world != tx.world() || &prepared.pinned.receipt.world != tx.world() {
        return Err(invalid("world"));
    }
    let release = super::read_release(tx, &pinned.release.id)
        .await?
        .ok_or_else(|| ReleaseFailure::ReleaseMissing {
            release_id: pinned.release.id.clone(),
        })?;
    if release != pinned.release {
        return Err(invalid("release"));
    }
    let scope = release_scope(tx, &release).await?;
    authorize(
        tx,
        admission,
        &scope,
        &release.definitions,
        &release.sources,
        &pinned.head,
        None,
    )
    .await?;
    require_head(tx, &pinned.head).await?;
    require_runtime(tx, &release).await?;
    for ((_, pin), reference) in pinned.pins.iter().zip(references(&release)?) {
        if pin.reference() != &reference.blob {
            return Err(invalid("pin"));
        }
        content::validate_pin(tx, pin).await?;
    }
    cancelled(cancellation)?;
    authorization::recheck(tx, admission, &tx.now().await?).await?;
    super::persist::switch_head(tx, &pinned.head).await
}

/// A separate stable-CommitId cleanup, only after success or authoritative NotCommitted.
/// An indeterminate final transaction must first recover its original CommitId; never drop its pins.
pub(crate) async fn release_rollback_pins(
    tx: &WorldTransaction<'_>,
    pinned: &Committed<RollbackPins>,
) -> Result<(), Error> {
    super::require_writer(tx)?;
    if tx.world() != &pinned.receipt.world || tx.world() != &pinned.value.release.world {
        return Err(invalid("world"));
    }
    for (_, pin) in &pinned.value.pins {
        content::release_pin(tx, pin).await?;
    }
    Ok(())
}

impl RollbackPins {
    /// Checks only the original committed acquisition and final head, never current availability.
    pub(crate) fn validate_committed(&self, head: &ReleaseHead) -> Result<(), Error> {
        let expected = self.head.expected.as_ref().ok_or_else(|| invalid("head"))?;
        if self.release.world != self.head.world
            || self.release.artifact.world != self.head.world
            || self.release.id != self.head.next
            || self.release.artifact.release_id != self.release.id
            || expected.world != self.head.world
            || expected.channel != self.head.channel
            || head.world != self.head.world
            || head.channel != self.head.channel
            || head.release_id != self.head.next
            || expected.generation.0.checked_add(1) != Some(head.generation.0)
            || expected.revision.0.checked_add(1) != Some(head.revision.0)
        {
            return Err(invalid("head"));
        }
        super::validate_manifest(&self.release.artifact)?;
        let references = references(&self.release)?;
        if references.len() != self.pins.len()
            || self
                .pins
                .iter()
                .zip(&references)
                .any(|((_, pin), reference)| pin.reference() != &reference.blob)
        {
            return Err(invalid("pins"));
        }
        Ok(())
    }

    pub(crate) fn recovery_pins(&self) -> impl Iterator<Item = &BlobPin> {
        self.pins.iter().map(|(_, pin)| pin)
    }
}

impl PreparedRollback {
    pub(crate) fn head(&self) -> &ReleaseHeadCas {
        &self.pinned.value.head
    }

    pub(crate) fn pins(&self) -> &Committed<RollbackPins> {
        &self.pinned
    }
}

pub(crate) async fn release_scope(
    tx: &WorldTransaction<'_>,
    release: &Release,
) -> Result<ScopeId, Error> {
    match &release.source_branch {
        Some(source) => {
            let branch = super::read_branch_revision(tx, source)
                .await?
                .ok_or_else(|| invalid("sourceBranch"))?;
            Ok(
                crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision)
                    .await?
                    .scope,
            )
        }
        None if release.parent.is_none()
            && release.definitions.is_empty()
            && release.scopes.len() == 1 =>
        {
            Ok(release.scopes[0].id.clone())
        }
        None => Err(invalid("sourceBranch")),
    }
}

async fn require_runtime(tx: &WorldTransaction<'_>, release: &Release) -> Result<(), Error> {
    let bindings: Vec<_> = release
        .definitions
        .iter()
        .filter(|definition| {
            matches!(
                definition.body,
                world_protocol::definitions::DefinitionBody::SourceBinding(_)
            )
        })
        .map(|definition| definition.reference.clone())
        .collect();
    crate::sources::sync::require_bindings_ready(tx, &bindings).await?;
    let graph = crate::extensions::bindings::read_graph_in_transaction(
        tx,
        &release.artifact.activation_lock_id,
    )
    .await?;
    let packages: Vec<_> = graph
        .lock()
        .nodes
        .iter()
        .map(|node| node.implementation.package_digest.clone())
        .collect();
    crate::extensions::package::require_retained_packages(
        tx,
        crate::extensions::package::RetentionOwner::Release(&release.id),
        Revision(1),
        &packages,
    )
    .await?;
    Ok(())
}

fn references(release: &Release) -> Result<Vec<ContentReference>, Error> {
    let mut references = release
        .artifact
        .outputs
        .iter()
        .map(|output| {
            ContentReference::new(
                ContentOwner::Release {
                    id: release.id.clone(),
                },
                output.content.clone(),
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let bytes = serde_json::to_vec(&release.artifact)?;
    let digest = Digest::try_new(format!("sha256:{:x}", Sha256::digest(&bytes)))
        .map_err(|_| invalid("manifest"))?;
    references.push(ContentReference::new(
        ContentOwner::Artifact {
            id: release.artifact.id.clone(),
        },
        BlobRef {
            digest,
            byte_size: bytes.len() as u64,
        },
    )?);
    Ok(references)
}
