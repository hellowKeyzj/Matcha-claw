use super::*;
use crate::run::task_board::{MailboxKind, RunnerStatus, TaskId, TaskRestoreInput, TaskStatus};

#[derive(Serialize, Deserialize)]
struct TaskRow {
    ordinal: u64,
    team: String,
    run: String,
    id: String,
    title: Body,
    instruction: Body,
    dependencies: Vec<String>,
    status: TaskStatus,
    owner: Option<String>,
    session: Option<String>,
    claimed_at: Option<u64>,
    lease_until: Option<u64>,
    attempt: u32,
    summary: Option<Body>,
    error: Option<Body>,
    created_at: u64,
    updated_at: u64,
    fingerprint: String,
}
#[derive(Serialize, Deserialize)]
enum Status {
    Active,
    Paused,
    Closed,
}
#[derive(Serialize, Deserialize)]
struct RunnerRow {
    ordinal: u64,
    team: String,
    run: String,
    id: String,
    session: String,
    status: Status,
    updated_at: u64,
}
#[derive(Serialize, Deserialize)]
enum Kind {
    Question,
    Proposal,
    Decision,
    Report,
}
#[derive(Serialize, Deserialize)]
struct MailboxRow {
    ordinal: u64,
    team: String,
    run: String,
    id: String,
    from: String,
    to: String,
    task: Option<String>,
    reply: Option<String>,
    kind: Kind,
    content: Body,
    created_at: u64,
}

fn check_scope(team: &str, run: &str, bodies: &Bodies<'_>) -> Result<(), StoreFault> {
    if team != bodies.team.as_str() || run != bodies.run.as_str() {
        return Err(StoreFault::CorruptRecord);
    }
    Ok(())
}
pub(super) fn encode_task(
    ordinal: u64,
    value: &TaskRecord,
    bodies: &Bodies<'_>,
) -> Result<Vec<u8>, StoreFault> {
    check_scope(value.team_id().as_str(), value.run_id().as_str(), bodies)?;
    serialize(&TaskRow {
        ordinal,
        team: value.team_id().as_str().to_owned(),
        run: value.run_id().as_str().to_owned(),
        id: value.task_id().as_str().to_owned(),
        title: bodies.put(value.title())?,
        instruction: bodies.put(value.instruction())?,
        dependencies: value
            .depends_on()
            .iter()
            .map(|id| id.as_str().to_owned())
            .collect(),
        status: value.status(),
        owner: value.owner_agent_id().map(ToOwned::to_owned),
        session: value.claim_session().map(ToOwned::to_owned),
        claimed_at: value.claimed_at(),
        lease_until: value.lease_until(),
        attempt: value.attempt(),
        summary: bodies.optional(value.result_summary())?,
        error: bodies.optional(value.error())?,
        created_at: value.created_at(),
        updated_at: value.updated_at(),
        fingerprint: value.command_fingerprint().to_owned(),
    })
}
pub(super) fn decode_task(
    bytes: &[u8],
    bodies: &Bodies<'_>,
) -> Result<(u64, TaskRecord), StoreFault> {
    let row: TaskRow = deserialize(bytes)?;
    check_scope(&row.team, &row.run, bodies)?;
    let record = valid(TaskRecord::restore(TaskRestoreInput {
        team_id: valid(TeamId::try_new(row.team))?,
        run_id: GraphRunId::new(row.run),
        task_id: valid(TaskId::try_new(row.id))?,
        title: bodies.read(row.title)?,
        instruction: bodies.read(row.instruction)?,
        depends_on: row
            .dependencies
            .into_iter()
            .map(|id| valid(TaskId::try_new(id)))
            .collect::<Result<_, _>>()?,
        status: row.status,
        owner_agent_id: row.owner,
        claim_session: row.session,
        claimed_at: row.claimed_at,
        lease_until: row.lease_until,
        attempt: row.attempt,
        result_summary: bodies.read_optional(row.summary)?,
        error: bodies.read_optional(row.error)?,
        created_at: row.created_at,
        updated_at: row.updated_at,
        command_fingerprint: row.fingerprint,
    }))?;
    Ok((row.ordinal, record))
}
pub(super) fn encode_runner(
    ordinal: u64,
    value: &AutoRunnerFacts,
    bodies: &Bodies<'_>,
) -> Result<Vec<u8>, StoreFault> {
    check_scope(value.team_id().as_str(), value.run_id().as_str(), bodies)?;
    serialize(&RunnerRow {
        ordinal,
        team: value.team_id().as_str().to_owned(),
        run: value.run_id().as_str().to_owned(),
        id: value.runner_id().to_owned(),
        session: value.session().to_owned(),
        status: match value.status() {
            RunnerStatus::Active => Status::Active,
            RunnerStatus::Paused => Status::Paused,
            RunnerStatus::Closed => Status::Closed,
        },
        updated_at: value.updated_at(),
    })
}
pub(super) fn decode_runner(
    bytes: &[u8],
    bodies: &Bodies<'_>,
) -> Result<(u64, AutoRunnerFacts), StoreFault> {
    let row: RunnerRow = deserialize(bytes)?;
    check_scope(&row.team, &row.run, bodies)?;
    let mut record = valid(AutoRunnerFacts::new(
        valid(TeamId::try_new(row.team))?,
        GraphRunId::new(row.run),
        row.id,
        row.session,
        row.updated_at,
    ))?;
    record.set_status(
        match row.status {
            Status::Active => RunnerStatus::Active,
            Status::Paused => RunnerStatus::Paused,
            Status::Closed => RunnerStatus::Closed,
        },
        row.updated_at,
    );
    Ok((row.ordinal, record))
}
pub(super) fn encode_mailbox(
    ordinal: u64,
    value: &MailboxMessage,
    bodies: &Bodies<'_>,
) -> Result<Vec<u8>, StoreFault> {
    check_scope(value.team_id().as_str(), value.run_id().as_str(), bodies)?;
    serialize(&MailboxRow {
        ordinal,
        team: value.team_id().as_str().to_owned(),
        run: value.run_id().as_str().to_owned(),
        id: value.msg_id().to_owned(),
        from: value.from_agent_id().to_owned(),
        to: value.to().to_owned(),
        task: value.related_task_id().map(|id| id.as_str().to_owned()),
        reply: value.reply_to_msg_id().map(ToOwned::to_owned),
        kind: match value.kind() {
            MailboxKind::Question => Kind::Question,
            MailboxKind::Proposal => Kind::Proposal,
            MailboxKind::Decision => Kind::Decision,
            MailboxKind::Report => Kind::Report,
        },
        content: bodies.put(value.content())?,
        created_at: value.created_at(),
    })
}
pub(super) fn decode_mailbox(
    bytes: &[u8],
    bodies: &Bodies<'_>,
) -> Result<(u64, MailboxMessage), StoreFault> {
    let row: MailboxRow = deserialize(bytes)?;
    check_scope(&row.team, &row.run, bodies)?;
    let record = valid(MailboxMessage::new(
        valid(TeamId::try_new(row.team))?,
        GraphRunId::new(row.run),
        row.id,
        row.from,
        row.to,
        row.task.map(|id| valid(TaskId::try_new(id))).transpose()?,
        row.reply,
        match row.kind {
            Kind::Question => MailboxKind::Question,
            Kind::Proposal => MailboxKind::Proposal,
            Kind::Decision => MailboxKind::Decision,
            Kind::Report => MailboxKind::Report,
        },
        bodies.read(row.content)?,
        row.created_at,
    ))?;
    Ok((row.ordinal, record))
}
