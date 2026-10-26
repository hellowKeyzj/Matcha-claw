use world_protocol::{
    api::{ApiFailure, ConfigurePolicy, ConfigureRetention},
    authorization::{AccessMode, AccessScope, AuthorizationFailure, PolicyRule, PolicyVerdict},
    failure::{FailureStage, Recovery},
    ids::{Revision, ScopeId, WriterDomain},
    time::Timestamp,
};

use super::{Admission, actual_impact, decode, recheck};
use crate::{owner::Error, store::WorldTransaction};

pub(crate) async fn configure_policy(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    request: &ConfigurePolicy,
    now: &Timestamp,
) -> Result<(), Error> {
    require_manage(tx, admission, &request.scope, now).await?;
    super::authority::lock(tx).await?;
    let world = tx.world();
    let current = tx.query_opt(
        "SELECT revision,policy,scope_id,mandatory,active FROM world_auth_policy WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &request.rule.reference.policy_id.as_str()],
    ).await?;
    require_revision(
        current.as_ref().map(|row| row.get("revision")),
        request.expected_revision,
        request.rule.reference.revision,
    )?;
    if let Some(current) = current {
        let previous: PolicyRule = decode(current.get("policy"))?;
        if !current.get::<_, bool>("active") {
            return Err(AuthorizationFailure::Revoked.into());
        }
        if current.get::<_, String>("scope_id") != request.scope.as_str()
            || (current.get::<_, bool>("mandatory") && !request.mandatory)
        {
            return Err(AuthorizationFailure::InsufficientScope.into());
        }
        // A normal allow cannot rewrite a mandatory/deny boundary or erase its obligations.
        if current.get::<_, bool>("mandatory") || previous.verdict != PolicyVerdict::Allow {
            let verdict_preserved = match previous.verdict {
                PolicyVerdict::Deny => request.rule.verdict == PolicyVerdict::Deny,
                PolicyVerdict::NeedsApproval => request.rule.verdict != PolicyVerdict::Allow,
                PolicyVerdict::Allow => true,
            };
            if !verdict_preserved
                || previous.access != request.rule.access
                || previous.labels != request.rule.labels
                || previous.effects != request.rule.effects
                || previous.reference.contract != request.rule.reference.contract
                || !previous
                    .reference
                    .obligations
                    .iter()
                    .all(|obligation| request.rule.reference.obligations.contains(obligation))
            {
                return Err(AuthorizationFailure::InsufficientScope.into());
            }
        }
    }
    super::authority::write_policy(
        tx,
        &request.rule,
        &request.scope,
        request.mandatory,
        request.available,
    )
    .await?;
    Ok(())
}

pub(crate) async fn configure_retention(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    request: &ConfigureRetention,
    now: &Timestamp,
) -> Result<(), Error> {
    require_manage(tx, admission, &request.scope, now).await?;
    super::authority::lock(tx).await?;
    let world = tx.world();
    let current = tx.query_opt(
        "SELECT revision,scope_id FROM world_auth_retention_policy WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3 ORDER BY revision DESC LIMIT 1 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &request.policy.policy_id.as_str()],
    ).await?;
    require_revision(
        current.as_ref().map(|row| row.get("revision")),
        request.expected_revision,
        request.policy.revision,
    )?;
    if current
        .as_ref()
        .is_some_and(|row| row.get::<_, String>("scope_id") != request.scope.as_str())
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    // This registers the actual reference only; there is no invented retention action DSL.
    super::policies::register_retention(
        tx,
        &super::InitialRetention {
            scope: request.scope.clone(),
            policy: request.policy.clone(),
        },
    )
    .await?;
    Ok(())
}

async fn require_manage(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    scope: &ScopeId,
    now: &Timestamp,
) -> Result<(), Error> {
    tx.require_domain(&WriterDomain::try_new("authorization").expect("fixed domain"))?;
    super::policies::require_scope(tx, scope).await?;
    let impact = actual_impact(
        vec![AccessScope {
            resources: Vec::new(),
            fields: Vec::new(),
            modes: vec![AccessMode::Manage],
            scope: scope.clone(),
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    recheck(tx, admission, now).await?;
    Ok(())
}

fn require_revision(
    current: Option<i64>,
    expected: Option<Revision>,
    target: Revision,
) -> Result<(), Error> {
    let valid = match (current, expected) {
        (None, None) => target == Revision(1),
        (Some(current), Some(expected)) => {
            current > 0
                && u64::try_from(current).ok() == Some(expected.0)
                && expected
                    .0
                    .checked_add(1)
                    .filter(|next| *next <= i64::MAX as u64)
                    == Some(target.0)
        }
        _ => false,
    };
    if !valid {
        return Err(Error::new(
            "world.policy_revision_conflict",
            FailureStage::Commit,
            "策略修订已变化，请刷新后重试。",
            ApiFailure::RevisionConflict,
            Recovery::Refresh,
        ));
    }
    Ok(())
}
