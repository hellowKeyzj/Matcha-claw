use super::*;

record!(world_protocol::commit::CommittedRevision, CommittedRevision; resource, revision);
record!(world_protocol::commit::WriteFence, WriteFence; world, domain, epoch);
record!(world_protocol::commit::CommitReceipt, CommitReceipt; world, commit_id, committed_at, revisions, outbox_ids, fence);
