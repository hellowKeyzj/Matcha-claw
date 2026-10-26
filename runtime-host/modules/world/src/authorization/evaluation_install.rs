use serde::{Deserialize, Serialize};
use world_protocol::{
    api::ApiFailure,
    authorization::{AccessScope, AuthorizationFailure},
    expression::Effect,
    failure::{FailureStage, Recovery},
    ids::*,
    time::Timestamp,
};

use super::{AuthorityRoot, GrantRequest, InitialEvaluation, InitialPolicy, InitialRetention, PrincipalRecord, actor_id, actor_kind, encode};
use crate::{definitions::canonical_digest, owner::Error, store::{WorldSnapshot, WorldTransaction}};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum EvaluationRecipient {
    Execution,
    Oracle,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationGrant {
    pub id: GrantId,
    pub recipient: EvaluationRecipient,
    pub access: Vec<AccessScope>,
    pub labels: Vec<String>,
    pub effects: Vec<Effect>,
    pub expires_at: Option<Timestamp>,
}

/// Explicit trusted installation material, never a public World command or credential.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallEvaluation {
    pub world: WorldRef,
    pub commit_id: CommitId,
    pub evaluation: InitialEvaluation,
    pub principals: Vec<PrincipalRecord>,
    pub grants: Vec<EvaluationGrant>,
    pub policies: Vec<InitialPolicy>,
    pub retention_policies: Vec<InitialRetention>,
}

pub(crate) struct InstalledEvaluation {
    pub configuration: InitialEvaluation,
    pub commit_id: CommitId,
}

pub(crate) fn installation_digest(
    world: &WorldRef,
    evaluation: &InitialEvaluation,
    principals: &[PrincipalRecord],
    grants: &[impl Serialize],
    policies: &[InitialPolicy],
    retention: &[InitialRetention],
) -> Result<Digest, Error> {
    Ok(canonical_digest(&("world.evaluation.install.v1", world, evaluation, principals, grants, policies, retention))?)
}

pub(crate) async fn read_evaluation(snapshot: &WorldSnapshot<'_>) -> Result<Option<InstalledEvaluation>, Error> {
    let world = snapshot.world();
    let row = snapshot.query_opt(
        "SELECT configuration,installed_commit_id FROM world_auth_evaluation WHERE tenant_id=$1 AND world_id=$2",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?;
    row.map(|row| Ok(InstalledEvaluation {
        configuration: super::decode(row.get("configuration"))?,
        commit_id: CommitId::try_new(row.get::<_, String>("installed_commit_id"))
            .map_err(|_| AuthorizationFailure::InternalFault)?,
    })).transpose()
}

/// Called only inside the original provision or the root-bound installation transaction.
pub(crate) async fn reserve_evaluation(
    tx: &WorldTransaction<'_>,
    configuration: &InitialEvaluation,
    digest: &Digest,
) -> Result<bool, Error> {
    tx.require_domain(&WriterDomain::try_new("authorization").expect("fixed domain"))?;
    super::authority::lock(tx).await?;
    let world = tx.world();
    let inserted = tx.execute(
        "INSERT INTO world_auth_evaluation(tenant_id,world_id,installation_digest,configuration,installed_commit_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &digest.as_str(), &encode(configuration)?, &tx.commit_id().as_str()],
    ).await?;
    if inserted == 1 { return Ok(true); }
    let row = tx.query_opt(
        "SELECT installation_digest,configuration FROM world_auth_evaluation WHERE tenant_id=$1 AND world_id=$2 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?.ok_or(AuthorizationFailure::InternalFault)?;
    if row.get::<_, String>("installation_digest") != digest.as_str()
        || row.get::<_, serde_json::Value>("configuration") != encode(configuration)? {
        return Err(conflict());
    }
    Ok(false)
}

pub(crate) async fn backfill_evaluation(
    tx: &WorldTransaction<'_>,
    configuration: &InitialEvaluation,
    digest: &Digest,
) -> Result<(), Error> {
    super::authority::lock(tx).await?;
    let world = tx.world();
    if tx.query_opt("SELECT 1 FROM world_auth_evaluation WHERE tenant_id=$1 AND world_id=$2 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await?.is_some() { return Ok(()); }
    reserve_evaluation(tx, configuration, digest).await?;
    Ok(())
}

pub(crate) async fn install_evaluation(
    tx: &WorldTransaction<'_>,
    root: &AuthorityRoot,
    input: &InstallEvaluation,
    digest: &Digest,
    now: &Timestamp,
) -> Result<(), Error> {
    if tx.world() != &input.world || tx.commit_id() != &input.commit_id {
        return Err(AuthorizationFailure::RequestDigestMismatch.into());
    }
    if !reserve_evaluation(tx, &input.evaluation, digest).await? { return Ok(()); }
    super::evaluation::validate_config(&input.evaluation).map_err(|error| Error::from(error)
        .with_authorization_context("world.evaluation.configuration_rejected", "评测身份配置无效，请核对两个不同的身份引用。"))?;
    if input.principals.len() > 2 || input.policies.len() > 1 || input.retention_policies.len() > 1 {
        return Err(Error::from(AuthorizationFailure::InsufficientScope)
            .with_authorization_context("world.evaluation.configuration_rejected", "评测安装仅允许所选身份和引用的 case 策略。"));
    }
    for (index, record) in input.principals.iter().enumerate() {
        if ![&input.evaluation.execution, &input.evaluation.oracle].iter()
            .any(|principal| principal.issuer == record.issuer && principal.subject == record.subject)
            || input.principals[..index].iter().any(|previous| previous.issuer == record.issuer && previous.subject == record.subject) {
            return Err(Error::from(AuthorizationFailure::InvalidPrincipal)
                .with_authorization_context("world.evaluation.principal_seed_rejected", "评测身份 seed 必须属于所选角色且不重复。"));
        }
        let (code, message) = if record.issuer == input.evaluation.execution.issuer && record.subject == input.evaluation.execution.subject {
            ("world.evaluation.execution_principal_rejected", "执行身份不可用，请核对原身份绑定、撤销及过期状态。")
        } else {
            ("world.evaluation.oracle_principal_rejected", "Oracle 身份不可用，请核对原身份绑定、撤销及过期状态。")
        };
        register_principal(tx, root, record, now).await.map_err(|error| error.with_authorization_context(code, message))?;
    }
    let mut until = now.clone();
    let execution = super::ingress::principal(tx, &input.evaluation.execution.issuer, &input.evaluation.execution.subject, now, &mut until).await
        .map_err(|error| Error::from(error).with_authorization_context("world.evaluation.execution_principal_rejected", "执行身份不可用，请核对原身份绑定、撤销及过期状态。"))?;
    let oracle = super::ingress::principal(tx, &input.evaluation.oracle.issuer, &input.evaluation.oracle.subject, now, &mut until).await
        .map_err(|error| Error::from(error).with_authorization_context("world.evaluation.oracle_principal_rejected", "Oracle 身份不可用，请核对原身份绑定、撤销及过期状态。"))?;
    if actor_id(&execution) == actor_id(&oracle) {
        return Err(Error::from(AuthorizationFailure::InvalidPrincipal)
            .with_authorization_context("world.evaluation.principal_isolation_rejected", "执行身份与 Oracle 必须绑定不同 actor。"));
    }
    for grant in &input.grants {
        let (actor, code, message) = match grant.recipient {
            EvaluationRecipient::Execution => (&execution, "world.evaluation.execution_grant_rejected", "执行授权未被接受，请核对显式 grant、scope 和有效期。"),
            EvaluationRecipient::Oracle => (&oracle, "world.evaluation.oracle_grant_rejected", "Oracle 授权未被接受，请核对显式 grant、scope 和有效期。"),
        };
        super::grant_access(tx, root, &GrantRequest {
            world: input.world.clone(), commit_id: input.commit_id.clone(), id: grant.id.clone(), actor: actor.clone(),
            access: grant.access.clone(), labels: grant.labels.clone(), effects: grant.effects.clone(), expires_at: grant.expires_at.clone(),
        }, now).await.map_err(|error| error.with_authorization_context(code, message))?;
    }
    for policy in &input.policies {
        async {
            if policy.rule.reference.policy_id != input.evaluation.case_access.policy_id
                || policy.rule.reference.revision != input.evaluation.case_access.revision {
                return Err(AuthorizationFailure::InsufficientScope.into());
            }
            register_policy(tx, policy).await
        }.await.map_err(|error: Error| error.with_authorization_context("world.evaluation.policy_seed_rejected", "Case 访问策略 seed 未被接受，请核对引用、scope 和当前策略。"))?;
    }
    for retention in &input.retention_policies {
        async {
            if retention.policy != input.evaluation.case_retention { return Err(AuthorizationFailure::InsufficientScope.into()); }
            let world = tx.world();
            let exists = tx.query_opt(
                "SELECT 1 FROM world_auth_retention_policy WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3 AND revision=$4 FOR SHARE",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &retention.policy.policy_id.as_str(), &i64::try_from(retention.policy.revision.0).map_err(|_| AuthorizationFailure::InsufficientScope)?],
            ).await?.is_some();
            if !exists && retention.policy.revision != Revision(1) { return Err(AuthorizationFailure::InsufficientScope.into()); }
            super::policies::register_retention(tx, retention).await.map_err(Error::from)
        }.await.map_err(|error: Error| error.with_authorization_context("world.evaluation.retention_seed_rejected", "Case 保留策略 seed 未被接受，请核对原引用、修订和 scope。"))?;
    }
    super::evaluation::require_finite_grant(tx, &execution, now).await.map_err(|error| Error::from(error)
        .with_authorization_context("world.evaluation.execution_finite_grant_rejected", "执行身份缺少当前有效且 modes/resources 非空的有限授权。"))?;
    super::evaluation::require_finite_grant(tx, &oracle, now).await.map_err(|error| Error::from(error)
        .with_authorization_context("world.evaluation.oracle_finite_grant_rejected", "Oracle 身份缺少当前有效且 modes/resources 非空的有限授权。"))?;
    super::policies::case_policy(tx, &input.evaluation.case_access, &input.evaluation.case_retention).await
        .map_err(|error| Error::from(error).with_authorization_context("world.evaluation.case_policy_rejected", "Case 策略复核失败，请核对访问策略、修订、标签、scope 和保留策略。"))?;
    Ok(())
}

async fn register_principal(tx: &WorldTransaction<'_>, root: &AuthorityRoot, record: &PrincipalRecord, now: &Timestamp) -> Result<(), Error> {
    if record.expires_at.as_ref().is_some_and(|expires| expires <= now) {
        return Err(AuthorizationFailure::DeadlineExpired.into());
    }
    let world = tx.world();
    let current = tx.query_opt(
        "SELECT actor_id,actor_kind,active,expires_at IS NOT DISTINCT FROM $5::text::timestamptz AS same_expiry FROM world_auth_principal WHERE tenant_id=$1 AND world_id=$2 AND issuer=$3 AND subject=$4 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &record.issuer, &record.subject, &record.expires_at.as_ref().map(Timestamp::as_str)],
    ).await?;
    if let Some(current) = current {
        if current.get::<_, String>("actor_id") != actor_id(&record.actor).as_str()
            || current.get::<_, String>("actor_kind") != actor_kind(&record.actor)
            || !current.get::<_, bool>("same_expiry") { return Err(conflict()); }
        if !current.get::<_, bool>("active") { return Err(AuthorizationFailure::Revoked.into()); }
        return Ok(());
    }
    root.principal(tx, record).await?;
    Ok(())
}

async fn register_policy(tx: &WorldTransaction<'_>, input: &InitialPolicy) -> Result<(), Error> {
    super::policies::require_scope(tx, &input.scope).await?;
    let world = tx.world();
    let current = tx.query_opt(
        "SELECT revision,policy,scope_id,mandatory,active,available FROM world_auth_policy WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &input.rule.reference.policy_id.as_str()],
    ).await?;
    if let Some(current) = current {
        if current.get::<_, serde_json::Value>("policy") != encode(&input.rule)?
            || current.get::<_, i64>("revision") != i64::try_from(input.rule.reference.revision.0).map_err(|_| AuthorizationFailure::InsufficientScope)?
            || current.get::<_, String>("scope_id") != input.scope.as_str()
            || current.get::<_, bool>("mandatory") != input.mandatory
            || current.get::<_, bool>("available") != input.available { return Err(conflict()); }
        if !current.get::<_, bool>("active") { return Err(AuthorizationFailure::Revoked.into()); }
        return Ok(());
    }
    if input.rule.reference.revision != Revision(1) { return Err(AuthorizationFailure::InsufficientScope.into()); }
    super::authority::write_policy(tx, &input.rule, &input.scope, input.mandatory, input.available).await?;
    Ok(())
}

fn conflict() -> Error {
    Error::new("world.evaluation_configuration_conflict", FailureStage::Commit,
        "独立评测配置或引用的授权事实已存在且内容不同。", ApiFailure::RevisionConflict, Recovery::Refresh)
}
