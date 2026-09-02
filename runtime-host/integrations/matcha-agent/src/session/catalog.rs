use std::fmt;

use super::model::{RuntimeKind, Sequence, SessionId, SessionRecord, WorkerRuntimeState};

/// A Renderer catalog field that the native Matcha session protocol does not
/// provide. The gap is explicit so a caller cannot replace it with a route,
/// run, or local default.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatalogGap {
    SessionKey,
    AgentId,
    ProtocolId,
    RuntimeEndpointId,
    EndpointSessionId,
    SessionIdentity,
    Kind,
    Preferred,
    Status,
    Label,
    TitleSource,
    DisplayName,
    ContextTokens,
    UpdatedAtMillis,
}

/// One typed native catalog read.
///
/// `Available` means the native source supplied the value, `Unavailable`
/// means the native optional value is absent, and `Gap` means no native source
/// exists for the requested Renderer field.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SessionCatalogFact<T> {
    Available(T),
    Unavailable,
    Gap(CatalogGap),
}

impl<T> fmt::Debug for SessionCatalogFact<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Available(_) => formatter.write_str("Available(..)"),
            Self::Unavailable => formatter.write_str("Unavailable"),
            Self::Gap(gap) => formatter.debug_tuple("Gap").field(gap).finish(),
        }
    }
}

/// Borrowed catalog facts from one native `SessionRecord`.
///
/// This is a view over the native record, not another session store. It keeps
/// the protocol-owned metadata available to snapshot assembly while exposing
/// Renderer-only fields as typed gaps instead of synthetic values.
#[derive(Clone, Copy)]
pub struct SessionCatalogFacts<'native> {
    session: &'native SessionRecord,
}

impl<'native> SessionCatalogFacts<'native> {
    pub fn from_native(session: &'native SessionRecord) -> Self {
        Self { session }
    }

    pub fn session_id(&self) -> &'native SessionId {
        &self.session.session_id
    }

    pub fn created_at(&self) -> &'native str {
        &self.session.created_at
    }

    pub fn updated_at(&self) -> &'native str {
        &self.session.updated_at
    }

    pub fn title(&self) -> Option<&'native str> {
        self.session.title.as_deref()
    }

    pub fn runtime(&self) -> RuntimeKind {
        self.session.runtime
    }

    pub fn transcript_ref(&self) -> Option<&'native str> {
        self.session.transcript_ref.as_deref()
    }

    pub fn has_conversation(&self) -> Option<bool> {
        self.session.has_conversation
    }

    pub fn last_seq(&self) -> Sequence {
        self.session.last_seq
    }

    pub fn last_snapshot_version(&self) -> u64 {
        self.session.last_snapshot_version
    }

    pub fn model(&self) -> Option<&'native str> {
        self.session.model.as_deref()
    }

    pub fn permission_mode(&self) -> Option<&'native str> {
        self.session.permission_mode.as_deref()
    }

    pub fn worker_state(&self) -> &'native WorkerRuntimeState {
        &self.session.worker_state
    }

    pub fn session_key(&self) -> SessionCatalogFact<&'native str> {
        SessionCatalogFact::Gap(CatalogGap::SessionKey)
    }

    pub fn agent_id(&self) -> SessionCatalogFact<&'native str> {
        SessionCatalogFact::Gap(CatalogGap::AgentId)
    }

    pub fn protocol_id(&self) -> SessionCatalogFact<&'native str> {
        SessionCatalogFact::Gap(CatalogGap::ProtocolId)
    }

    pub fn runtime_endpoint_id(&self) -> SessionCatalogFact<&'native str> {
        SessionCatalogFact::Gap(CatalogGap::RuntimeEndpointId)
    }

    pub fn endpoint_session_id(&self) -> SessionCatalogFact<&'native SessionId> {
        SessionCatalogFact::Available(self.session_id())
    }

    pub fn session_identity(&self) -> SessionCatalogFact<()> {
        SessionCatalogFact::Gap(CatalogGap::SessionIdentity)
    }

    pub fn kind(&self) -> SessionCatalogFact<()> {
        SessionCatalogFact::Gap(CatalogGap::Kind)
    }

    pub fn preferred(&self) -> SessionCatalogFact<bool> {
        SessionCatalogFact::Gap(CatalogGap::Preferred)
    }

    pub fn status(&self) -> SessionCatalogFact<()> {
        SessionCatalogFact::Gap(CatalogGap::Status)
    }

    pub fn label(&self) -> SessionCatalogFact<&'native str> {
        SessionCatalogFact::Gap(CatalogGap::Label)
    }

    pub fn title_source(&self) -> SessionCatalogFact<()> {
        SessionCatalogFact::Gap(CatalogGap::TitleSource)
    }

    pub fn display_name(&self) -> SessionCatalogFact<&'native str> {
        SessionCatalogFact::Gap(CatalogGap::DisplayName)
    }

    pub fn context_tokens(&self) -> SessionCatalogFact<()> {
        SessionCatalogFact::Gap(CatalogGap::ContextTokens)
    }

    pub fn updated_at_millis(&self) -> SessionCatalogFact<u64> {
        SessionCatalogFact::Gap(CatalogGap::UpdatedAtMillis)
    }

    pub const fn renderer_gaps() -> &'static [CatalogGap] {
        RENDERER_CATALOG_GAPS
    }
}

impl fmt::Debug for SessionCatalogFacts<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionCatalogFacts")
            .field("has_session_id", &true)
            .field("has_created_at", &true)
            .field("has_updated_at", &true)
            .field("has_title", &self.title().is_some())
            .field("runtime", &self.runtime())
            .field("has_transcript_ref", &self.transcript_ref().is_some())
            .field("has_conversation", &self.has_conversation())
            .field("last_seq", &self.last_seq())
            .field("last_snapshot_version", &self.last_snapshot_version())
            .field("has_model", &self.model().is_some())
            .field("has_permission_mode", &self.permission_mode().is_some())
            .field("renderer_gap_count", &RENDERER_CATALOG_GAPS.len())
            .finish()
    }
}

const RENDERER_CATALOG_GAPS: &[CatalogGap] = &[
    CatalogGap::SessionKey,
    CatalogGap::AgentId,
    CatalogGap::ProtocolId,
    CatalogGap::RuntimeEndpointId,
    CatalogGap::SessionIdentity,
    CatalogGap::Kind,
    CatalogGap::Preferred,
    CatalogGap::Status,
    CatalogGap::Label,
    CatalogGap::TitleSource,
    CatalogGap::DisplayName,
    CatalogGap::ContextTokens,
    CatalogGap::UpdatedAtMillis,
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::model::{UnloadedReason, WorkerRuntimeState};

    fn session() -> SessionRecord {
        SessionRecord {
            session_id: SessionId::try_new("native-session").unwrap(),
            created_at: "created-at".into(),
            updated_at: "updated-at".into(),
            title: Some("native-title".into()),
            runtime: RuntimeKind::MatchaAgent,
            transcript_ref: Some("native-transcript".into()),
            has_conversation: Some(true),
            last_seq: Sequence::try_new(7).unwrap(),
            last_snapshot_version: 3,
            model: Some("native-model".into()),
            model_selection_id: Some("native-model-selection".into()),
            provider_fingerprint: Some("native-provider-fingerprint".into()),
            permission_mode: Some("native-permission".into()),
            worker_state: WorkerRuntimeState::Unloaded {
                reason: UnloadedReason::NotStarted,
            },
        }
    }

    #[test]
    fn exposes_native_catalog_metadata_without_copying_or_guessing_renderer_identity() {
        let session = session();
        let facts = SessionCatalogFacts::from_native(&session);

        assert_eq!(facts.session_id().as_str(), "native-session");
        assert_eq!(facts.created_at(), "created-at");
        assert_eq!(facts.updated_at(), "updated-at");
        assert_eq!(facts.title(), Some("native-title"));
        assert_eq!(facts.runtime(), RuntimeKind::MatchaAgent);
        assert_eq!(facts.transcript_ref(), Some("native-transcript"));
        assert_eq!(facts.has_conversation(), Some(true));
        assert_eq!(facts.last_seq().get(), 7);
        assert_eq!(facts.last_snapshot_version(), 3);
        assert_eq!(facts.model(), Some("native-model"));
        assert_eq!(facts.permission_mode(), Some("native-permission"));
        assert!(matches!(
            facts.agent_id(),
            SessionCatalogFact::Gap(CatalogGap::AgentId)
        ));
        assert!(matches!(
            facts.endpoint_session_id(),
            SessionCatalogFact::Available(session_id)
                if session_id.as_str() == "native-session"
        ));
        assert!(matches!(
            facts.updated_at_millis(),
            SessionCatalogFact::Gap(CatalogGap::UpdatedAtMillis)
        ));
    }

    #[test]
    fn optional_native_metadata_preserves_absence_as_available_none() {
        let mut session = session();
        session.title = None;
        session.model = None;
        session.transcript_ref = None;
        session.has_conversation = None;
        let facts = SessionCatalogFacts::from_native(&session);

        assert_eq!(facts.title(), None);
        assert_eq!(facts.model(), None);
        assert_eq!(facts.transcript_ref(), None);
        assert_eq!(facts.has_conversation(), None);
        assert!(!format!("{facts:?}").contains("native-session"));
        assert!(!format!("{facts:?}").contains("native-title"));
    }

    #[test]
    fn renderer_gap_inventory_is_explicit_and_stable() {
        for gap in [
            CatalogGap::SessionKey,
            CatalogGap::AgentId,
            CatalogGap::ProtocolId,
            CatalogGap::RuntimeEndpointId,
            CatalogGap::SessionIdentity,
            CatalogGap::Kind,
            CatalogGap::Preferred,
            CatalogGap::Status,
            CatalogGap::Label,
            CatalogGap::TitleSource,
            CatalogGap::DisplayName,
            CatalogGap::ContextTokens,
            CatalogGap::UpdatedAtMillis,
        ] {
            assert!(SessionCatalogFacts::renderer_gaps().contains(&gap));
        }
    }
}
