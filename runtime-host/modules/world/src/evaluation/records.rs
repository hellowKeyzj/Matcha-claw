use serde::{Serialize, de::DeserializeOwned};
use std::collections::BTreeSet;
use world_protocol::{
    authorization::{AccessMode, AccessScope, Actor},
    commit::CommittedRevision,
    evaluation::{FrozenSuite, TestRevision},
    ids::{CaseId, ResourceRef, Revision, ScopeId, SuiteId, TaskId},
    learning::{Case, CaseOrigin, CaseOriginKind, DatasetSplit, TaskContract, TestCase},
    time::Timestamp,
};

use super::{
    ConstraintFailure, Error, invalid, validate_case, validate_suite, validate_task, validate_test,
};
use crate::{
    authorization::{Admission, actual_impact, recheck},
    content::{ContentOwner, ContentReference, retain},
    store::WorldTransaction,
};

pub(super) fn encode(value: &impl Serialize) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value)
        .map_err(|_| world_protocol::evaluation::EvaluationFailure::InternalFault.into())
}
pub(super) fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, Error> {
    serde_json::from_value(value)
        .map_err(|_| world_protocol::evaluation::EvaluationFailure::InternalFault.into())
}
pub(super) fn digest(value: &impl Serialize) -> Result<world_protocol::ids::Digest, Error> {
    crate::definitions::canonical_digest(value)
        .map_err(|failure| ConstraintFailure::Definition { failure }.into())
}
pub(super) fn revision(value: Revision) -> Result<i64, Error> {
    i64::try_from(value.0).map_err(|_| invalid("revision").into())
}

pub(super) async fn lock(tx: &WorldTransaction<'_>, kind: &str, id: &str) -> Result<(), Error> {
    let key = serde_json::to_string(&(tx.world(), "evaluation", kind, id))
        .map_err(|_| world_protocol::evaluation::EvaluationFailure::InternalFault)?;
    tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        &[&key],
    )
    .await?;
    Ok(())
}

pub(super) async fn authorize(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    scope: &ScopeId,
    resources: Vec<ResourceRef>,
    mode: AccessMode,
    labels: Vec<String>,
    now: &Timestamp,
) -> Result<(), Error> {
    if &admission.invocation().world != tx.world() {
        return Err(ConstraintFailure::CrossWorld.into());
    }
    let impact = actual_impact(
        vec![AccessScope {
            resources,
            fields: Vec::new(),
            modes: vec![mode],
            scope: scope.clone(),
            valid_time: None,
        }],
        Vec::new(),
        labels,
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    recheck(tx, admission, now).await?;
    Ok(())
}

pub(crate) async fn record_task(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    task: &TaskContract,
    now: &Timestamp,
) -> Result<TaskContract, Error> {
    validate_task(task)?;
    if tx.world() != &task.world {
        return Err(ConstraintFailure::CrossWorld.into());
    }
    authorize(
        tx,
        admission,
        &task.scope,
        vec![ResourceRef::Task {
            id: task.id.clone(),
        }],
        AccessMode::Manage,
        Vec::new(),
        now,
    )
    .await?;
    lock(tx, "task", task.id.as_str()).await?;
    let world = tx.world().clone();
    let latest = tx.query_opt(
        "SELECT body FROM world_task_revision WHERE tenant_id=$1 AND world_id=$2 AND task_id=$3 ORDER BY revision DESC LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &task.id.as_str()],
    ).await?.map(|row| decode::<TaskContract>(row.get("body"))).transpose()?;
    if latest.as_ref() == Some(task) {
        return Ok(task.clone());
    }
    if latest
        .as_ref()
        .map_or(Some(1), |previous| previous.revision.0.checked_add(1))
        != Some(task.revision.0)
    {
        return Err(ConstraintFailure::VersionMismatch.into());
    }
    tx.execute(
        "INSERT INTO world_task_revision(tenant_id,world_id,task_id,revision,content_digest,scope_id,body) VALUES($1,$2,$3,$4,$5,$6,$7)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &task.id.as_str(), &revision(task.revision)?, &digest(task)?.as_str(), &task.scope.as_str(), &encode(task)?],
    ).await?;
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::Task {
            id: task.id.clone(),
        },
        revision: task.revision,
    })?;
    Ok(task.clone())
}

#[derive(Clone, Copy)]
enum Reader<'a, 'b> {
    Transaction(&'a WorldTransaction<'b>),
    Snapshot(&'a crate::store::WorldSnapshot<'b>),
}
impl<'a, 'b> Reader<'a, 'b> {
    fn world(self) -> &'a world_protocol::ids::WorldRef {
        match self { Self::Transaction(tx) => tx.world(), Self::Snapshot(snapshot) => snapshot.world() }
    }
    async fn query_opt(self, sql: &'static str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) -> Result<Option<tokio_postgres::Row>, Error> {
        Ok(match self { Self::Transaction(tx) => tx.query_opt(sql, params).await?, Self::Snapshot(snapshot) => snapshot.query_opt(sql, params).await? })
    }
    async fn query(self, sql: &'static str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) -> Result<Vec<tokio_postgres::Row>, Error> {
        Ok(match self { Self::Transaction(tx) => tx.query(sql, params).await?, Self::Snapshot(snapshot) => snapshot.query(sql, params).await? })
    }
}

pub(crate) async fn task(tx: &WorldTransaction<'_>, id: &TaskId, version: Revision) -> Result<TaskContract, Error> {
    read_task(Reader::Transaction(tx), id, version).await
}
pub(super) async fn task_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, id: &TaskId, version: Revision) -> Result<TaskContract, Error> {
    read_task(Reader::Snapshot(snapshot), id, version).await
}
async fn read_task(reader: Reader<'_, '_>, id: &TaskId, version: Revision) -> Result<TaskContract, Error> {
    let world = reader.world();
    let row = reader.query_opt(
        "SELECT content_digest,body FROM world_task_revision WHERE tenant_id=$1 AND world_id=$2 AND task_id=$3 AND revision=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &revision(version)?],
    ).await?.ok_or(ConstraintFailure::TaskMismatch)?;
    let task: TaskContract = decode(row.get("body"))?;
    if task.world != *world
        || task.id != *id
        || task.revision != version
        || digest(&task)?.as_str() != row.get::<_, String>("content_digest")
    {
        return Err(ConstraintFailure::VersionMismatch.into());
    }
    Ok(task)
}

pub(crate) async fn record_case(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    case: &Case,
    protected: bool,
    counterexample: bool,
    now: &Timestamp,
) -> Result<Case, Error> {
    let task = task(tx, &case.task_id, case.task_revision).await?;
    validate_case(&task, case)?;
    authorize(
        tx,
        admission,
        &task.scope,
        vec![ResourceRef::Case {
            id: case.id.clone(),
        }],
        AccessMode::Write,
        case.access.labels.clone(),
        now,
    )
    .await?;
    crate::authorization::require_case_policies(
        tx,
        admission,
        &case.id,
        &task.scope,
        &case.access,
        &case.retention,
        now,
    )
    .await?;
    persist_case(tx, &task, case, protected, counterexample).await?;
    Ok(case.clone())
}

pub(super) async fn persist_case(
    tx: &mut WorldTransaction<'_>,
    task: &TaskContract,
    case: &Case,
    protected: bool,
    counterexample: bool,
) -> Result<(), Error> {
    validate_case(task, case)?;
    if tx.world() != &case.world {
        return Err(ConstraintFailure::CrossWorld.into());
    }
    lock(tx, "case", case.id.as_str()).await?;
    let world = tx.world().clone();
    if let Some(row) = tx.query_opt(
        "SELECT body,protected,counterexample FROM world_case_revision WHERE tenant_id=$1 AND world_id=$2 AND case_id=$3 AND revision=1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &case.id.as_str()],
    ).await? {
        if decode::<Case>(row.get("body"))? != *case || row.get::<_, bool>("protected") != protected || row.get::<_, bool>("counterexample") != counterexample {
            return Err(ConstraintFailure::VersionMismatch.into());
        }
        return Ok(());
    }
    if let CaseOrigin::Replay { parent_case_id, .. } = &case.origin {
        let parent = load_case(tx, parent_case_id).await?.ok_or_else(|| {
            ConstraintFailure::MissingParent {
                case_id: parent_case_id.clone(),
            }
        })?;
        if parent.task_id != case.task_id
            || parent.task_revision != case.task_revision
            || parent.origin_family != case.origin_family
        {
            return Err(ConstraintFailure::TaskMismatch.into());
        }
    }
    retain(
        tx,
        &ContentReference::new(
            ContentOwner::Case {
                id: case.id.clone(),
            },
            case.observable_trace.clone(),
        )?,
    )
    .await?;
    tx.execute(
        "INSERT INTO world_case_revision(tenant_id,world_id,case_id,revision,task_id,task_revision,content_digest,protected,counterexample,body) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &case.id.as_str(), &case.task_id.as_str(), &revision(case.task_revision)?, &digest(case)?.as_str(), &protected, &counterexample, &encode(case)?],
    ).await?;
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::Case {
            id: case.id.clone(),
        },
        revision: Revision(1),
    })?;
    Ok(())
}

pub(crate) async fn load_case(
    tx: &WorldTransaction<'_>,
    id: &CaseId,
) -> Result<Option<Case>, Error> {
    let world = tx.world();
    tx.query_opt(
        "SELECT content_digest,body FROM world_case_revision WHERE tenant_id=$1 AND world_id=$2 AND case_id=$3 AND revision=1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.map(|row| {
        let case: Case = decode(row.get("body"))?;
        if case.world != *world || case.id != *id || digest(&case)?.as_str() != row.get::<_, String>("content_digest") {
            return Err(ConstraintFailure::VersionMismatch.into());
        }
        Ok(case)
    }).transpose()
}

pub(super) async fn case_origin(
    tx: &WorldTransaction<'_>,
    case: &Case,
) -> Result<CaseOriginKind, Error> {
    let mut current =
        load_case(tx, &case.id)
            .await?
            .ok_or_else(|| ConstraintFailure::MissingParent {
                case_id: case.id.clone(),
            })?;
    if current != *case {
        return Err(ConstraintFailure::VersionMismatch.into());
    }
    let replayed = matches!(&case.origin, CaseOrigin::Replay { .. });
    let mut visited = BTreeSet::new();
    loop {
        if current.world != case.world
            || current.task_id != case.task_id
            || current.task_revision != case.task_revision
            || current.origin_family != case.origin_family
        {
            return Err(ConstraintFailure::TaskMismatch.into());
        }
        if !visited.insert(current.id.clone()) {
            return Err(invalid("case.origin.parentCaseId").into());
        }
        match &current.origin {
            CaseOrigin::Recorded => {
                return Ok(if replayed {
                    CaseOriginKind::Replay
                } else {
                    CaseOriginKind::Recorded
                });
            }
            CaseOrigin::Fixture => return Ok(CaseOriginKind::Fixture),
            CaseOrigin::Synthetic { .. } => return Ok(CaseOriginKind::Synthetic),
            CaseOrigin::Replay { parent_case_id, .. } => {
                current = load_case(tx, parent_case_id).await?.ok_or_else(|| {
                    ConstraintFailure::MissingParent {
                        case_id: parent_case_id.clone(),
                    }
                })?;
            }
        }
    }
}

/// Learning may read only non-reserved case families, with their real disclosure labels.
pub(crate) async fn training_case(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    id: &CaseId,
    now: &Timestamp,
) -> Result<Case, Error> {
    let case = load_case(tx, id)
        .await?
        .ok_or_else(|| ConstraintFailure::MissingParent {
            case_id: id.clone(),
        })?;
    let task = task(tx, &case.task_id, case.task_revision).await?;
    authorize(
        tx,
        admission,
        &task.scope,
        vec![ResourceRef::Case { id: id.clone() }],
        AccessMode::Read,
        case.access.labels.clone(),
        now,
    )
    .await?;
    let current = crate::authorization::case_read_impact(tx, &case).await?;
    admission.require_access(&current)?;
    crate::authorization::check_admitted_output(tx, admission, &current, 1, &tx.now().await?)
        .await?;
    let world = tx.world();
    let reserved = tx.query_opt(
        "SELECT test_case_id FROM world_test_case_revision WHERE tenant_id=$1 AND world_id=$2 AND (body->>'originFamily'=$3 OR case_id=$4) AND body->>'split' IN ('holdout','dev') LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &case.origin_family.as_str(), &id.as_str()],
    ).await?;
    if let Some(row) = reserved {
        let test_case_id =
            world_protocol::ids::TestCaseId::try_new(row.get::<_, String>("test_case_id"))
                .map_err(|_| world_protocol::evaluation::EvaluationFailure::InternalFault)?;
        return Err(ConstraintFailure::HoldoutLeak { test_case_id }.into());
    }
    Ok(case)
}

pub(crate) async fn record_test(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    authority: &crate::authorization::EvaluationAuthority,
    test: &TestCase,
    now: &Timestamp,
) -> Result<TestCase, Error> {
    authority.require_manager(tx, admission, now).await?;
    let task = task(tx, &test.task_id, test.task_revision).await?;
    validate_test(&task, test)?;
    authorize(
        tx,
        admission,
        &task.scope,
        vec![ResourceRef::TestCase {
            id: test.id.clone(),
        }],
        AccessMode::Manage,
        Vec::new(),
        now,
    )
    .await?;
    lock(tx, "test", test.id.as_str()).await?;
    let world = tx.world().clone();
    let latest = tx.query_opt(
        "SELECT body FROM world_test_case_revision WHERE tenant_id=$1 AND world_id=$2 AND test_case_id=$3 ORDER BY revision DESC LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &test.id.as_str()],
    ).await?.map(|row| decode::<TestCase>(row.get("body"))).transpose()?;
    if latest.as_ref() == Some(test) {
        return Ok(test.clone());
    }
    if latest
        .as_ref()
        .is_some_and(|old| old.protected || old.split == DatasetSplit::Holdout)
    {
        return Err(ConstraintFailure::ProtectedCounterexample {
            test_case_id: test.id.clone(),
        }
        .into());
    }
    if latest
        .as_ref()
        .map_or(Some(1), |old| old.revision.0.checked_add(1))
        != Some(test.revision.0)
    {
        return Err(ConstraintFailure::VersionMismatch.into());
    }
    if let Some(id) = &test.case_id {
        let case = load_case(tx, id)
            .await?
            .ok_or_else(|| ConstraintFailure::MissingParent {
                case_id: id.clone(),
            })?;
        if case.task_id != test.task_id
            || case.task_revision != test.task_revision
            || case.origin_family != test.origin_family
        {
            return Err(ConstraintFailure::TaskMismatch.into());
        }
    }
    for blob in [&test.fixture, &test.expected] {
        retain(
            tx,
            &ContentReference::new(
                ContentOwner::TestCase {
                    id: test.id.clone(),
                    revision: test.revision,
                },
                blob.clone(),
            )?,
        )
        .await?;
    }
    let case_id = test.case_id.as_ref().map(CaseId::as_str);
    let case_revision = test.case_id.as_ref().map(|_| 1i64);
    tx.execute(
        "INSERT INTO world_test_case_revision(tenant_id,world_id,test_case_id,revision,case_id,case_revision,content_digest,oracle_digest,protected,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &test.id.as_str(), &revision(test.revision)?, &case_id, &case_revision, &digest(test)?.as_str(), &digest(&test.oracle)?.as_str(), &test.protected, &encode(test)?],
    ).await?;
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::TestCase {
            id: test.id.clone(),
        },
        revision: test.revision,
    })?;
    Ok(test.clone())
}

pub(super) async fn tests(tx: &WorldTransaction<'_>, members: &[TestRevision]) -> Result<Vec<TestCase>, Error> {
    read_tests(Reader::Transaction(tx), members).await
}
pub(super) async fn tests_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, members: &[TestRevision]) -> Result<Vec<TestCase>, Error> {
    read_tests(Reader::Snapshot(snapshot), members).await
}
async fn read_tests(reader: Reader<'_, '_>, members: &[TestRevision]) -> Result<Vec<TestCase>, Error> {
    let world = reader.world();
    let mut tests = Vec::with_capacity(members.len());
    for member in members {
        let row = reader.query_opt(
            "SELECT content_digest,oracle_digest,protected,body FROM world_test_case_revision WHERE tenant_id=$1 AND world_id=$2 AND test_case_id=$3 AND revision=$4",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &member.id.as_str(), &revision(member.revision)?],
        ).await?.ok_or_else(|| world_protocol::evaluation::EvaluationFailure::BadCase { test_case_id: member.id.clone() })?;
        let test: TestCase = decode(row.get("body"))?;
        if test.world != *world
            || test.id != member.id
            || test.revision != member.revision
            || digest(&test)?.as_str() != row.get::<_, String>("content_digest")
            || digest(&test.oracle)?.as_str() != row.get::<_, String>("oracle_digest")
            || test.protected != row.get::<_, bool>("protected")
        {
            return Err(ConstraintFailure::VersionMismatch.into());
        }
        tests.push(test);
    }
    Ok(tests)
}

pub(crate) async fn suite(tx: &WorldTransaction<'_>, id: &SuiteId, version: Revision) -> Result<FrozenSuite, Error> {
    read_suite(Reader::Transaction(tx), id, version).await
}
pub(super) async fn suite_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, id: &SuiteId, version: Revision) -> Result<FrozenSuite, Error> {
    read_suite(Reader::Snapshot(snapshot), id, version).await
}
async fn read_suite(reader: Reader<'_, '_>, id: &SuiteId, version: Revision) -> Result<FrozenSuite, Error> {
    let world = reader.world();
    let row = reader.query_opt(
        "SELECT task_id,task_revision,content_digest,authority_actor_id,body FROM world_suite_revision WHERE tenant_id=$1 AND world_id=$2 AND suite_id=$3 AND revision=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &revision(version)?],
    ).await?.ok_or(ConstraintFailure::VersionMismatch)?;
    let suite: FrozenSuite = decode(row.get("body"))?;
    if suite.world != *world
        || suite.id != *id
        || suite.revision != version
        || suite.task_id.as_str() != row.get::<_, String>("task_id")
        || revision(suite.task_revision)? != row.get::<_, i64>("task_revision")
        || suite.frozen_by.as_str() != row.get::<_, String>("authority_actor_id")
        || digest(&suite)?.as_str() != row.get::<_, String>("content_digest")
    {
        return Err(ConstraintFailure::VersionMismatch.into());
    }
    let members = reader.query("SELECT test_case_id,test_case_revision FROM world_suite_member WHERE tenant_id=$1 AND world_id=$2 AND suite_id=$3 AND suite_revision=$4 ORDER BY ordinal",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &revision(version)?]).await?;
    if members.len() != suite.tests.len()
        || members.iter().zip(&suite.tests).any(|(row, test)| {
            row.get::<_, String>("test_case_id") != test.id.as_str()
                || u64::try_from(row.get::<_, i64>("test_case_revision")).ok()
                    != Some(test.revision.0)
        })
    {
        return Err(ConstraintFailure::VersionMismatch.into());
    }
    Ok(suite)
}

pub(crate) async fn freeze_suite(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    authority: &crate::authorization::EvaluationAuthority,
    frozen: &FrozenSuite,
    memories: &[super::SuiteMemory],
    now: &Timestamp,
) -> Result<FrozenSuite, Error> {
    authority.require_manager(tx, admission, now).await?;
    if frozen.conditions.policy_epoch != admission.decision().policy_epoch
        || frozen.conditions.grant_epoch != admission.decision().grant_epoch
    {
        return Err(ConstraintFailure::EpochChanged.into());
    }
    let task = task(tx, &frozen.task_id, frozen.task_revision).await?;
    if tx.world() != &frozen.world {
        return Err(ConstraintFailure::CrossWorld.into());
    }
    authorize(
        tx,
        admission,
        &task.scope,
        vec![ResourceRef::Suite {
            id: frozen.id.clone(),
        }],
        AccessMode::Manage,
        Vec::new(),
        now,
    )
    .await?;
    let actor = match &admission.invocation().actor {
        Actor::Human { id } | Actor::Service { id } => id,
    };
    if actor != &frozen.frozen_by || frozen.frozen_at > *now {
        return Err(invalid("suite.frozenBy").into());
    }
    super::frozen_plan::validate_sources(tx, admission, &task, &frozen.plans, memories).await?;
    lock(tx, "suite", frozen.id.as_str()).await?;
    let world = tx.world().clone();
    let old = tx.query_opt(
        "SELECT body FROM world_suite_revision WHERE tenant_id=$1 AND world_id=$2 AND suite_id=$3 ORDER BY revision DESC LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &frozen.id.as_str()],
    ).await?.map(|row| decode::<FrozenSuite>(row.get("body"))).transpose()?;
    if old.as_ref() == Some(frozen) {
        return Ok(frozen.clone());
    }
    let old_tests = match &old {
        Some(old) => tests(tx, &old.tests).await?,
        None => Vec::new(),
    };
    let members = tests(tx, &frozen.tests).await?;
    validate_suite(
        &task,
        frozen,
        &members,
        old.as_ref().map(|old| (old, old_tests.as_slice())),
    )?;
    tx.execute(
        "INSERT INTO world_suite_revision(tenant_id,world_id,suite_id,revision,task_id,task_revision,content_digest,authority_actor_id,frozen_at,holdout,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::text::timestamptz,true,$10)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &frozen.id.as_str(), &revision(frozen.revision)?, &frozen.task_id.as_str(), &revision(frozen.task_revision)?, &digest(frozen)?.as_str(), &actor.as_str(), &frozen.frozen_at.as_str(), &encode(frozen)?],
    ).await?;
    for (ordinal, test) in members.iter().enumerate() {
        let ordinal = i32::try_from(ordinal).map_err(|_| invalid("suite.tests"))?;
        tx.execute(
            "INSERT INTO world_suite_member(tenant_id,world_id,suite_id,suite_revision,test_case_id,test_case_revision,ordinal) VALUES($1,$2,$3,$4,$5,$6,$7)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &frozen.id.as_str(), &revision(frozen.revision)?, &test.id.as_str(), &revision(test.revision)?, &ordinal],
        ).await?;
        for blob in [&test.fixture, &test.expected] {
            retain(
                tx,
                &ContentReference::new(
                    ContentOwner::Suite {
                        id: frozen.id.clone(),
                        revision: frozen.revision,
                    },
                    blob.clone(),
                )?,
            )
            .await?;
        }
    }
    for memory in memories {
        retain(tx, &ContentReference::new(
            ContentOwner::Suite { id: frozen.id.clone(), revision: frozen.revision },
            memory.pin().reference().clone(),
        )?).await?;
    }
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::Suite {
            id: frozen.id.clone(),
        },
        revision: frozen.revision,
    })?;
    Ok(frozen.clone())
}
