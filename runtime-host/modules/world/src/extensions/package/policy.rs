use std::collections::BTreeSet;

use world_protocol::{
    authorization::{AccessMode, AccessScope},
    ids::*,
    package::{PackageFailure, TrustPolicy},
};

use super::{
    error::PackageError,
    inventory::{Inventory, encode},
};
use crate::{
    authorization::{self, Admission, AuthorityRoot},
    owner,
    store::{OutboxEvent, WorldTransaction},
};

impl Inventory {
    /// Internal preparation reads current durable authority, never the installation evidence.
    pub(crate) async fn trust_policy(&self, world: &WorldRef) -> Result<TrustPolicy, PackageError> {
        self.require_world(world)?;
        self.store.snapshot(world.clone(), |snapshot| Box::pin(async move {
            let row = snapshot.query_opt(
                "SELECT revision,body FROM world_package_trust_policy WHERE tenant_id=$1 AND world_id=$2",
                &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str()],
            ).await?.ok_or_else(|| PackageError::new(PackageFailure::PublisherUntrusted))?;
            checked(row.get("revision"), row.get("body"))
        })).await
    }
}

pub(crate) async fn read_trust_policy_in(
    tx: &WorldTransaction<'_>,
) -> Result<TrustPolicy, PackageError> {
    let row = tx.query_opt(
        "SELECT revision,body FROM world_package_trust_policy WHERE tenant_id=$1 AND world_id=$2 FOR SHARE",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str()],
    ).await?.ok_or_else(|| PackageError::new(PackageFailure::PublisherUntrusted))?;
    checked(row.get("revision"), row.get("body"))
}

pub(crate) async fn initialize_trust_policy(
    tx: &WorldTransaction<'_>,
    _root: &AuthorityRoot,
    policy: &TrustPolicy,
) -> Result<(), PackageError> {
    tx.require_provision()?;
    validate(policy)?;
    if policy.revision != Revision(1) {
        return Err(PackageError::new(PackageFailure::InstallConflict));
    }
    tx.execute(
        "INSERT INTO world_package_trust_policy(tenant_id,world_id,revision,body) VALUES($1,$2,1,$3)",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &encode(policy)?],
    ).await?;
    Ok(())
}

/// The caller owns operation completion in this same transaction. No second ledger is created.
pub(crate) async fn replace_trust_policy(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    expected: Revision,
    replacement: &TrustPolicy,
) -> Result<(), owner::Error> {
    tx.require_domain(&WriterDomain::try_new("packages").expect("fixed domain"))?;
    let scope = owner::management_scope(tx).await?;
    if admission.invocation().world != *tx.world() {
        return Err(world_protocol::authorization::AuthorizationFailure::InsufficientScope.into());
    }
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: Vec::new(),
            fields: Vec::new(),
            modes: vec![AccessMode::Manage],
            scope,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    let at = tx.now().await?;
    authorization::recheck(tx, admission, &at).await?;
    validate(replacement)?;
    let next = expected
        .0
        .checked_add(1)
        .filter(|next| *next <= i64::MAX as u64)
        .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
    if expected.0 == 0 || replacement.revision != Revision(next) {
        return Err(PackageError::new(PackageFailure::InstallConflict).into());
    }
    let changed = tx.execute(
        "UPDATE world_package_trust_policy SET revision=$4,body=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND revision=$3",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &(expected.0 as i64), &(next as i64), &encode(replacement)?],
    ).await?;
    if changed != 1 {
        return Err(PackageError::new(PackageFailure::InstallConflict).into());
    }
    tx.emit(OutboxEvent {
        event_id: EventId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
        aggregate_kind: "package_trust_policy".into(),
        aggregate_id: tx.world().world_id.to_string(),
        aggregate_revision: next,
        event_kind: "world.package.trust_policy_changed".into(),
        payload: encode(&replacement.revision)?,
        causation_id: None,
        origin: "world.package".into(),
    })
    .await?;
    Ok(())
}

fn checked(revision: i64, body: serde_json::Value) -> Result<TrustPolicy, PackageError> {
    let policy: TrustPolicy = serde_json::from_value(body)
        .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?;
    validate(&policy)?;
    if i64::try_from(policy.revision.0).ok() != Some(revision) {
        return Err(PackageError::new(PackageFailure::InternalFault));
    }
    Ok(policy)
}

fn validate(policy: &TrustPolicy) -> Result<(), PackageError> {
    let invalid = || PackageError::new(PackageFailure::PublisherUntrusted);
    if policy.revision.0 == 0
        || policy.revision.0 > i64::MAX as u64
        || policy.trusted_publishers.len() > 4096
        || policy.trusted_process_digests.len() > 4096
        || policy.trusted_native_digests.len() > 4096
    {
        return Err(invalid());
    }
    let mut keys = BTreeSet::new();
    for key in &policy.trusted_publishers {
        if key.key_id.is_empty()
            || key.key_id.len() > 256
            || key.key_id.chars().any(char::is_control)
            || !keys.insert((&key.publisher, &key.key_id))
        {
            return Err(invalid());
        }
        let bytes: [u8; 32] = key
            .public_key
            .as_slice()
            .try_into()
            .map_err(|_| invalid())?;
        ed25519_dalek::VerifyingKey::from_bytes(&bytes).map_err(|_| invalid())?;
    }
    if policy
        .trusted_process_digests
        .iter()
        .collect::<BTreeSet<_>>()
        .len()
        != policy.trusted_process_digests.len()
        || policy
            .trusted_native_digests
            .iter()
            .collect::<BTreeSet<_>>()
            .len()
            != policy.trusted_native_digests.len()
    {
        return Err(invalid());
    }
    Ok(())
}
