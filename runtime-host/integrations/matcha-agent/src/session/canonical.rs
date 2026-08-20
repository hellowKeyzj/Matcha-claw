use std::fmt;

use crate::lifecycle::secret::Secret;

use super::{
    client::{AppServerClient, AppServerClientError, AppServerEndpoint, EventRecoveryCursor},
    facts::NativeSessionFacts,
    history::HistoryResult,
    hydration::{
        self, HydrationIncomplete, HydrationSnapshot, HydrationWindow, HydrationWindowRequest,
    },
    model::{RunId, RunRecord, SessionId, SessionRecord, UsageSummary, WorkerRuntimeState},
    projection::{NativeSessionProjection, ProjectionGap, SnapshotAssembler, SnapshotAssembly},
    request::SessionLoadParams,
};

/// Native facts read from one app-server session.
///
/// `NativeSessionFacts` is the sole owner of the snapshot, bounded transcript,
/// and replay integrity facts. This alias preserves the canonical read seam
/// name without introducing a second facts wrapper.
pub type CanonicalSessionFacts = NativeSessionFacts;

pub type CanonicalSessionReadResult = HistoryResult<NativeSessionFacts>;

/// Status of a fact family exposed by the integration-local canonical seam.
///
/// A complete native read is not a complete Renderer session snapshot. The two
/// statuses are therefore exposed separately by [`CanonicalSessionView`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalFactStatus {
    Complete,
    Incomplete,
    Unavailable,
    Unknown,
}

/// A missing guarantee that the Host conversion layer must preserve.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalGap {
    /// Matcha app-server has no source epoch field.
    SourceEpochUnknown,
    /// The transcript read is a bounded window rather than the full transcript.
    BoundedTranscript,
    /// The native snapshot did not provide usage facts.
    UsageUnavailable,
    /// A Renderer field still has no native producer or assembler.
    Renderer(ProjectionGap),
}

/// Conversion-ready, source-backed view over one validated native read.
///
/// This view borrows the sole [`NativeSessionFacts`] owner. It does not own a
/// transcript, event store, snapshot, or Host DTO, and it never synthesizes a
/// Host epoch or sequence.
#[derive(Clone, Copy)]
pub struct CanonicalSessionView<'facts> {
    projection: NativeSessionProjection<'facts>,
}

impl<'facts> CanonicalSessionView<'facts> {
    pub fn from_facts(facts: &'facts CanonicalSessionFacts) -> Self {
        Self {
            projection: NativeSessionProjection::from_facts(facts),
        }
    }

    pub fn session_binding(&self) -> &'facts SessionId {
        self.projection.session_id()
    }

    pub fn session_id(&self) -> &'facts SessionId {
        self.projection.session_id()
    }

    pub fn session(&self) -> &'facts SessionRecord {
        self.projection.session()
    }

    pub fn snapshot_version(&self) -> u64 {
        self.projection.snapshot_version()
    }

    pub fn snapshot_updated_at(&self) -> &'facts str {
        self.projection.snapshot_updated_at()
    }

    pub fn transcript(&self) -> &'facts HydrationSnapshot {
        self.projection.transcript()
    }

    pub fn transcript_messages(&self) -> &'facts [super::hydration::HydratedMessage] {
        self.projection.transcript_messages()
    }

    pub fn transcript_window(&self) -> HydrationWindow {
        self.projection.transcript_window()
    }

    pub fn ordered_facts(&self) -> super::projection::NativeOrderedFacts<'facts> {
        self.projection.ordered_facts()
    }

    pub fn runs(&self) -> &'facts [RunRecord] {
        self.projection.runs()
    }

    pub fn pending_approvals(&self) -> &'facts [super::approval::ApprovalRecord] {
        self.projection.pending_approvals()
    }

    pub fn usage(&self) -> Option<UsageSummary> {
        self.projection.usage()
    }

    pub fn native_worker_state(&self) -> &'facts WorkerRuntimeState {
        self.projection.native_worker_state()
    }

    pub fn native_active_run_id(&self) -> Option<&'facts RunId> {
        self.projection.native_active_run_id()
    }

    pub fn snapshot_events(&self) -> &'facts [super::facts::NativeEventFact] {
        self.projection.snapshot_events()
    }

    pub fn replay_events(&self) -> &'facts [super::facts::NativeEventFact] {
        self.projection.replay_events()
    }

    pub fn replay_event_count(&self) -> usize {
        self.projection.replay_event_count()
    }

    pub fn replay_cursor(&self) -> &'facts EventRecoveryCursor {
        self.projection.replay_cursor()
    }

    /// The native app-server event sequence. This is a source cursor, not the
    /// Host's local `seq` or lifecycle `epoch`.
    pub fn source_cursor(&self) -> u64 {
        self.projection.replay_cursor().sequence().get()
    }

    pub fn source_recovery_cursor(&self) -> &'facts EventRecoveryCursor {
        self.projection.replay_cursor()
    }

    /// Matcha app-server does not expose a source epoch in its protocol.
    pub const fn source_epoch(&self) -> Option<u64> {
        None
    }

    pub const fn native_facts_status(&self) -> CanonicalFactStatus {
        CanonicalFactStatus::Complete
    }

    /// Native facts do not produce the public Renderer session snapshot.
    pub const fn renderer_snapshot_status(&self) -> CanonicalFactStatus {
        CanonicalFactStatus::Incomplete
    }

    pub const fn can_build_renderer_snapshot(&self) -> bool {
        false
    }

    pub fn native_replay_reached_snapshot(&self) -> bool {
        self.projection.native_replay_reached_snapshot()
    }

    /// Returns only gaps that are true for this read plus the declared
    /// Renderer projection gaps. No missing value is represented as empty data.
    pub fn gaps(&self) -> Vec<CanonicalGap> {
        let mut gaps = Vec::with_capacity(NativeSessionProjection::projection_gaps().len() + 3);
        gaps.push(CanonicalGap::SourceEpochUnknown);
        gaps.push(CanonicalGap::BoundedTranscript);
        if self.usage().is_none() {
            gaps.push(CanonicalGap::UsageUnavailable);
        }
        gaps.extend(
            NativeSessionProjection::projection_gaps()
                .iter()
                .copied()
                .map(CanonicalGap::Renderer),
        );
        gaps
    }

    pub fn projection(&self) -> NativeSessionProjection<'facts> {
        self.projection
    }
}

impl fmt::Debug for CanonicalSessionView<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CanonicalSessionView")
            .field("native_facts_status", &self.native_facts_status())
            .field("renderer_snapshot_status", &self.renderer_snapshot_status())
            .field("source_cursor", &self.source_cursor())
            .field("source_epoch", &self.source_epoch())
            .field("gap_count", &self.gaps().len())
            .finish()
    }
}

/// Stable integration-local assembler. It only borrows native facts and leaves
/// Host identity, epoch, sequence, and DTO conversion to the Host.
#[derive(Clone, Copy, Debug, Default)]
pub struct CanonicalSessionAssembler;

impl CanonicalSessionAssembler {
    pub fn project<'facts>(facts: &'facts CanonicalSessionFacts) -> CanonicalSessionView<'facts> {
        CanonicalSessionView::from_facts(facts)
    }

    pub fn assemble<'facts>(facts: &'facts CanonicalSessionFacts) -> CanonicalSessionView<'facts> {
        Self::project(facts)
    }

    /// Exposes the existing native snapshot attempt without upgrading it to a
    /// complete Renderer snapshot.
    pub fn renderer_snapshot<'facts>(
        facts: &'facts CanonicalSessionFacts,
    ) -> SnapshotAssembly<'facts> {
        SnapshotAssembler::assemble(facts)
    }
}

/// Alias for callers that need the existing sealed incomplete assembly result.
pub type CanonicalSnapshotAssembly<'facts> = SnapshotAssembly<'facts>;

/// Reads native session, bounded transcript, snapshot, and replay facts.
///
/// A successful result is only returned when the replay cursor reaches the
/// snapshot's native `lastSeq`. Close failure always overrides a provisional
/// success so callers cannot mistake an unconfirmed read for complete facts.
pub async fn read(
    endpoint: AppServerEndpoint,
    secret: &Secret,
    session_id: SessionId,
    request: HydrationWindowRequest,
) -> CanonicalSessionReadResult {
    let (client, _) = match AppServerClient::connect_and_initialize_raw_only(endpoint, secret).await
    {
        Ok(connection) => connection,
        Err(error) => return from_connect_error(error),
    };

    let result = read_connected(&client, session_id, request).await;
    close_outcome(result, client.close().await)
}

async fn read_connected(
    client: &AppServerClient,
    session_id: SessionId,
    request: HydrationWindowRequest,
) -> CanonicalSessionReadResult {
    let session = match client
        .load_session(SessionLoadParams::new(session_id.clone()))
        .await
    {
        Ok(session) if session.session_id == session_id => session,
        Ok(_) => return HistoryResult::Incomplete(HydrationIncomplete::ProtocolRejected),
        Err(AppServerClientError::SessionNotFound) => return HistoryResult::NotFound,
        Err(error) => return from_read_error(error),
    };

    let native_facts =
        match hydration::hydrate_connected_for_canonical(client, session, request).await {
            Ok(result) => result,
            Err(reason) => return from_hydration_incomplete(reason),
        };
    HistoryResult::Complete(native_facts)
}

fn from_connect_error(error: AppServerClientError) -> CanonicalSessionReadResult {
    match error {
        AppServerClientError::PeerRejected
        | AppServerClientError::Protocol
        | AppServerClientError::InitializeFailed => {
            HistoryResult::Incomplete(HydrationIncomplete::ProtocolRejected)
        }
        AppServerClientError::SessionNotFound => HistoryResult::NotFound,
        _ => HistoryResult::Unavailable,
    }
}

fn from_read_error(error: AppServerClientError) -> CanonicalSessionReadResult {
    match error {
        AppServerClientError::SessionNotFound => HistoryResult::NotFound,
        AppServerClientError::EventRecoveryRequired => {
            HistoryResult::Incomplete(HydrationIncomplete::ReplayRecoveryRequired)
        }
        AppServerClientError::PeerRejected => {
            HistoryResult::Incomplete(HydrationIncomplete::SourceRejected)
        }
        AppServerClientError::Protocol
        | AppServerClientError::InitializeFailed
        | AppServerClientError::InvalidEndpoint
        | AppServerClientError::HealthFailed
        | AppServerClientError::UpgradeFailed
        | AppServerClientError::HealthDeadline
        | AppServerClientError::UpgradeDeadline => {
            HistoryResult::Incomplete(HydrationIncomplete::ProtocolRejected)
        }
        AppServerClientError::ConnectionClosed
        | AppServerClientError::RequestDeadline
        | AppServerClientError::UnknownResponse
        | AppServerClientError::Transport => HistoryResult::Unknown,
        AppServerClientError::CloseFailed => {
            HistoryResult::Incomplete(HydrationIncomplete::ConnectionCloseFailed)
        }
    }
}

fn from_hydration_incomplete(reason: HydrationIncomplete) -> CanonicalSessionReadResult {
    match reason {
        HydrationIncomplete::ConnectionInterrupted => HistoryResult::Unknown,
        HydrationIncomplete::SourceUnavailable => HistoryResult::Unavailable,
        reason => HistoryResult::Incomplete(reason),
    }
}

fn close_outcome(
    result: CanonicalSessionReadResult,
    close: Result<(), AppServerClientError>,
) -> CanonicalSessionReadResult {
    match close {
        Ok(()) => result,
        Err(_) => HistoryResult::Incomplete(HydrationIncomplete::ConnectionCloseFailed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::model::{Sequence, SessionRecord, SessionSnapshot};

    #[test]
    fn canonical_result_preserves_history_distinctions_and_close_failure() {
        assert_eq!(
            from_connect_error(AppServerClientError::HealthFailed),
            HistoryResult::Unavailable
        );
        assert_eq!(
            from_read_error(AppServerClientError::RequestDeadline),
            HistoryResult::Unknown
        );
        assert_eq!(
            from_read_error(AppServerClientError::SessionNotFound),
            HistoryResult::NotFound
        );
        assert_eq!(
            from_read_error(AppServerClientError::EventRecoveryRequired),
            HistoryResult::Incomplete(HydrationIncomplete::ReplayRecoveryRequired)
        );
        assert_eq!(
            close_outcome(
                HistoryResult::Complete(test_facts()),
                Err(AppServerClientError::CloseFailed),
            ),
            HistoryResult::Incomplete(HydrationIncomplete::ConnectionCloseFailed)
        );
    }

    #[test]
    fn canonical_view_preserves_native_binding_cursor_and_unknown_epoch() {
        let facts = test_facts();
        let view = CanonicalSessionAssembler::project(&facts);

        assert_eq!(view.native_facts_status(), CanonicalFactStatus::Complete);
        assert_eq!(
            view.renderer_snapshot_status(),
            CanonicalFactStatus::Incomplete
        );
        assert!(!view.can_build_renderer_snapshot());
        assert_eq!(view.session_binding().as_str(), "canonical-session");
        assert_eq!(view.source_cursor(), 1);
        assert_eq!(
            view.source_recovery_cursor().session_id().as_str(),
            "canonical-session"
        );
        assert_eq!(view.source_epoch(), None);
        assert!(view.gaps().contains(&CanonicalGap::SourceEpochUnknown));
        assert!(view.gaps().contains(&CanonicalGap::BoundedTranscript));
        assert!(view.gaps().contains(&CanonicalGap::UsageUnavailable));
        assert!(!view.gaps().is_empty());
    }

    #[test]
    fn canonical_assembler_keeps_renderer_snapshot_sealed_incomplete() {
        let facts = test_facts();
        let assembly = CanonicalSessionAssembler::renderer_snapshot(&facts);
        let view = CanonicalSessionAssembler::project(&facts);

        assert!(assembly.is_incomplete());
        assert_eq!(
            assembly.available().session_id().as_str(),
            "canonical-session"
        );
        assert_eq!(assembly.available().replay_cursor().sequence().get(), 1);
        assert_eq!(view.ordered_facts().replay_cursor().sequence().get(), 1);
        assert_eq!(view.ordered_facts().source_epoch(), None);
        assert!(!view.can_build_renderer_snapshot());
    }

    fn test_facts() -> CanonicalSessionFacts {
        let session_id = SessionId::try_new("canonical-session").unwrap();
        let session = SessionRecord {
            session_id: session_id.clone(),
            created_at: "created".into(),
            updated_at: "updated".into(),
            title: None,
            runtime: super::super::model::RuntimeKind::MatchaAgent,
            transcript_ref: None,
            has_conversation: None,
            last_seq: Sequence::try_new(1).unwrap(),
            last_snapshot_version: 1,
            model: None,
            permission_mode: None,
            worker_state: super::super::model::WorkerRuntimeState::Unloaded {
                reason: super::super::model::UnloadedReason::NotStarted,
            },
        };
        let hydration = hydration::hydrate_lines(
            &[String::from(
                r#"{"message":{"role":"user","content":"visible"}}"#,
            )],
            HydrationWindowRequest::latest(),
        )
        .unwrap();
        let snapshot = SessionSnapshot {
            session: session.clone(),
            version: 1,
            updated_at: "updated".into(),
            runs: Vec::new(),
            messages: Vec::new(),
            pending_approvals: Vec::new(),
            usage: None,
        };
        let native_facts = NativeSessionFacts::from_native(
            session,
            snapshot,
            hydration,
            super::super::client::EventReplayPayload::new(
                super::super::client::EventReplay::new(1, Sequence::try_new(1).unwrap()),
                Vec::new(),
            ),
        )
        .unwrap();
        native_facts
    }
}
