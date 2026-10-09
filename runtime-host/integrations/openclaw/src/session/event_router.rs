use std::{collections::{HashMap, HashSet, VecDeque}, sync::Arc};

use tokio::time::{Duration, Instant};

use sessions_module::{command::SessionIngressEvent, ports::{RuntimeOperationFailure, SessionSync, SessionSyncCut}, state::{SessionEventBinding, SessionIdentity}};
use tokio::sync::mpsc;

use crate::{driver::projection::openclaw_session_event, gateway::{ingress::GatewayEpoch, observation::identity_key}};

use super::{
    projection::{CanonicalIngressResult, CanonicalRecoveryReason},
    protocol::{SessionApprovalEvent, SessionEventEnvelope, SessionKey},
    reducer::SessionReducerActor,
    window::{Direction, PageRequest, SessionWindow},
};

const TERMINAL_HISTORY_DELAYS_MS: [u64; 4] = [100, 400, 1_500, 3_000];

type RecoveryClaim = (String, u64, u64, u64, String);

struct TerminalHistoryRecovery {
    identity: SessionIdentity,
    generation: u64,
    epoch: GatewayEpoch,
    run_id: String,
    lifecycle: u64,
    native_session_id: Option<String>,
    initial_replies: Vec<String>,
    observations: Arc<crate::gateway::observation::Observations>,
    read: Option<u64>,
    deadline: Option<Instant>,
    completed_reads: usize,
}

pub(crate) struct EventRouter {
    actors: HashMap<(String, u64), SessionReducerActor>,
    pending_messages: HashSet<(String, u64)>,
    recoveries: HashMap<(String, u64), TerminalHistoryRecovery>,
    recovery_claims: VecDeque<RecoveryClaim>,
    next_read: u64,
    session_events: mpsc::Sender<SessionIngressEvent>,
}

impl EventRouter {
    pub(crate) fn new(session_events: mpsc::Sender<SessionIngressEvent>) -> Self {
        Self { actors: HashMap::new(), pending_messages: HashSet::new(), recoveries: HashMap::new(), recovery_claims: VecDeque::new(), next_read: 0, session_events }
    }

    fn actor(&mut self, identity: &SessionIdentity, generation: u64) -> &mut SessionReducerActor {
        self.actors.entry((identity_key(identity), generation)).or_insert_with(||
            SessionReducerActor::new(SessionKey::try_new(identity.session_key.clone()).expect("validated observation key")))
    }

    pub(crate) async fn route(&mut self, event: SessionEventEnvelope, epoch: GatewayEpoch, identity: SessionIdentity, generation: u64, observations: &Arc<crate::gateway::observation::Observations>) {
        let cursor = event.gateway_sequence;
        let persisted = event.transcript_message.is_some();
        let key = (identity_key(&identity), generation);
        let live_run = self.actor(&identity, generation).live_run_id().map(str::to_owned);
        let has_live_run = live_run.is_some();
        let missing_final = event.chat.as_ref().filter(|chat|
            chat.state == super::protocol::ChatState::Final && chat.message_absent
                && chat.terminal_outcome() == Some(super::events::TerminalOutcome::Completed)
                && live_run.as_deref().is_none_or(|run| run == chat.run_id.as_str()))
            .map(|chat| chat.run_id.as_str().to_owned());
        let message_refresh = event.kind == super::protocol::SessionEventKind::Message
            && (!has_live_run || event.transcript_message.as_ref().is_some_and(|message|
            message.role() == super::window::MessageRole::User && message.has_active_run() == Some(true)));
        let changed_refresh = event.changed.as_ref().is_some_and(|changed| {
            use super::protocol::SessionChangedPhase;
            matches!(changed.reason.as_deref(), Some("reset" | "compact" | "send" | "agent.run.started" | "agent.input.settled"))
                || changed.phase == Some(SessionChangedPhase::Reset)
                || (changed.phase == Some(SessionChangedPhase::Message) && !changed.has_message_cursor)
        });
        let changed = event.changed.is_some();
        let truncated = event.transcript_message.as_ref().is_some_and(super::window::Message::truncated)
            || event.chat.as_ref().and_then(|chat| chat.final_message.as_ref()).is_some_and(super::window::Message::truncated);
        let terminal = event.chat.as_ref().is_some_and(|chat| matches!(chat.state, super::protocol::ChatState::Final | super::protocol::ChatState::Aborted | super::protocol::ChatState::Error));
        let run_id = event.run_id.as_ref().map(|run| run.as_str().to_owned());
        let result = if super::trace::enabled() {
            let context = serde_json::json!({ "identity": sessions_module::trace::identity_shape(&identity),
                "generation": generation, "sourceEpoch": epoch.as_u64(), "nativeCursor": cursor,
                "inputKind": "live", "eventKind": format!("{:?}", event.kind),
                "runHash": run_id.as_deref().map(sessions_module::trace::fingerprint) });
            sessions_module::trace::with_context(context, || self.actor(&identity, generation).reduce(event, Some(epoch)))
        } else { self.actor(&identity, generation).reduce(event, Some(epoch)) };
        let committed_terminal = result.as_ref().is_some_and(|result| matches!(result,
            CanonicalIngressResult::Produced(delta) if delta.changes().iter().any(|change| matches!(change, super::projection::CanonicalSessionChange::Terminal { .. }))));
        let terminal = terminal || committed_terminal;
        let accepted = result.as_ref().is_none_or(|result| matches!(result, CanonicalIngressResult::Produced(_)));
        if accepted && persisted && has_live_run { self.pending_messages.insert(key.clone()); }
        let owner_released = has_live_run && self.actor(&identity, generation).live_run_id().is_none();
        let changed_refresh = changed_refresh || (changed && owner_released);
        let recovery_refresh = missing_final.as_deref().is_some_and(|run|
            accepted && self.claim_terminal_history(&identity, generation, epoch, run, observations));
        let replay_pending = accepted && self.actor(&identity, generation).live_run_id().is_none()
            && self.pending_messages.remove(&key);
        let history_refresh = accepted && (truncated || message_refresh || changed_refresh || replay_pending || recovery_refresh);
        if (message_refresh && !has_live_run) || recovery_refresh { self.pending_messages.remove(&key); }
        self.prune_recoveries();
        if super::trace::enabled() && (persisted || terminal || truncated) {
            super::trace::log_unscoped("runtime.openclaw.router.history_refresh", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                "sourceEpoch": epoch.as_u64(), "nativeCursor": cursor,
                "accepted": accepted, "resultKind": match &result { None => "none", Some(CanonicalIngressResult::Produced(_)) => "produced", Some(CanonicalIngressResult::Unknown { .. }) => "unknown" },
                "persisted": persisted, "terminal": terminal, "truncated": truncated,
                "historyRefresh": history_refresh
            }));
        }
        let binding = SessionEventBinding::observed(identity.clone(), generation, Some(epoch.as_u64()), false).expect("validated observation binding");
        if let Some(event) = result.as_ref().and_then(|result| openclaw_session_event(result, binding.clone())) {
            let (event_identity, mut change) = event.into_parts();
            change.history_refresh = history_refresh;
            let event = SessionIngressEvent::new(event_identity, change);
            if super::trace::enabled() {
                super::trace::log_unscoped("runtime.openclaw.router.forward", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                    "sourceEpoch": epoch.as_u64(), "nativeCursor": cursor,
                    "changes": result.as_ref().and_then(|result| match result {
                        CanonicalIngressResult::Produced(delta) => Some(sessions_module::trace::changes_shape(&crate::driver::projection::openclaw_canonical_changes(delta.changes()))),
                        CanonicalIngressResult::Unknown { .. } => None,
                    }) }));
            }
            let sent = self.session_events.send(event).await;
            if super::trace::enabled() {
                super::trace::log_unscoped("runtime.openclaw.router.delivery", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                    "sourceEpoch": epoch.as_u64(), "nativeCursor": cursor, "queueAccepted": sent.is_ok(), "hostApplied": "not_observed" }));
            }
        } else {
            if super::trace::enabled() {
                super::trace::log_unscoped("runtime.openclaw.router.no_display_changes", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                    "sourceEpoch": epoch.as_u64(), "nativeCursor": cursor, "hasReducerResult": result.is_some(),
                    "cursorOnly": cursor.is_some() }));
            }
            if cursor.is_some() || history_refresh {
                let sent = self.session_events.send(SessionIngressEvent::new(identity.clone(), sessions_module::command::SessionEvent { binding, run_id, cursor, history_refresh, changes: Vec::new() })).await;
                if super::trace::enabled() {
                    super::trace::log_unscoped("runtime.openclaw.router.delivery", serde_json::json!({
                        "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                        "sourceEpoch": epoch.as_u64(), "nativeCursor": cursor, "cursorOnly": true,
                        "queueAccepted": sent.is_ok(), "hostApplied": "not_observed" }));
                }
            }
        }
    }

    fn claim_terminal_history(&mut self, identity: &SessionIdentity, generation: u64, epoch: GatewayEpoch, run: &str, observations: &Arc<crate::gateway::observation::Observations>) -> bool {
        let actor = self.actor(identity, generation);
        if !actor.is_run_completed(run) { return false; }
        let lifecycle = actor.run_lifecycle_generation();
        let native_session_id = actor.native_session_id().map(str::to_owned);
        let (accepted_final, initial_replies) = actor.terminal_reply_recovery(run);
        let claim = (identity_key(identity), generation, epoch.as_u64(), lifecycle, run.to_owned());
        if self.recovery_claims.contains(&claim) { return false; }
        if self.recovery_claims.len() == 64 { self.recovery_claims.pop_front(); }
        self.recovery_claims.push_back(claim);
        self.pending_messages.remove(&(identity_key(identity), generation));
        if accepted_final { return false; }
        self.recoveries.insert((identity_key(identity), generation), TerminalHistoryRecovery {
            identity: identity.clone(), generation, epoch, run_id: run.to_owned(), lifecycle,
            native_session_id, initial_replies, observations: Arc::clone(observations),
            read: None, deadline: None, completed_reads: 0,
        });
        true
    }

    fn prune_recoveries(&mut self) {
        self.recoveries.retain(|key, recovery| {
            let Some(actor) = self.actors.get(key) else { return false; };
            if !recovery.observations.is_active(&recovery.identity, recovery.generation, recovery.epoch.as_u64())
                || actor.run_lifecycle_generation() != recovery.lifecycle
                || actor.native_session_id() != recovery.native_session_id.as_deref()
                || actor.live_run_id().is_some_and(|run| run != recovery.run_id)
            { return false; }
            let (accepted_final, replies) = actor.terminal_reply_recovery(&recovery.run_id);
            !accepted_final && !replies.iter().any(|reply| !recovery.initial_replies.contains(reply))
        });
    }

    pub(crate) fn history_started(&mut self, identity: &SessionIdentity, generation: u64, page: PageRequest) -> u64 {
        self.next_read = self.next_read.checked_add(1).expect("history read sequence exhausted");
        self.prune_recoveries();
        if matches!(page.direction(), Direction::Latest)
            && let Some(recovery) = self.recoveries.get_mut(&(identity_key(identity), generation))
            && recovery.deadline.is_none() && recovery.read.is_none()
        { recovery.read = Some(self.next_read); }
        self.next_read
    }

    pub(crate) fn history_finished(&mut self, identity: &SessionIdentity, generation: u64, read: u64) -> bool {
        self.prune_recoveries();
        let key = (identity_key(identity), generation);
        if let Some(recovery) = self.recoveries.get_mut(&key) && recovery.read == Some(read) {
            recovery.read = None;
            let delay = TERMINAL_HISTORY_DELAYS_MS.get(recovery.completed_reads).copied();
            recovery.completed_reads += 1;
            if let Some(delay) = delay {
                recovery.deadline = Some(Instant::now() + Duration::from_millis(delay));
                return true;
            }
            self.recoveries.remove(&key);
        }
        false
    }

    pub(crate) fn recovery_deadline(&mut self) -> Option<Instant> {
        self.prune_recoveries();
        self.recoveries.values().filter_map(|recovery| recovery.deadline).min()
    }

    pub(crate) async fn refresh_terminal_history(&mut self) {
        self.prune_recoveries();
        let now = Instant::now();
        for recovery in self.recoveries.values_mut().filter(|recovery| recovery.deadline.is_some_and(|deadline| deadline <= now)) {
            recovery.deadline = None;
            let binding = SessionEventBinding::observed(recovery.identity.clone(), recovery.generation, Some(recovery.epoch.as_u64()), false).expect("validated observation binding");
            let _ = self.session_events.send(SessionIngressEvent::new(recovery.identity.clone(), sessions_module::command::SessionEvent {
                binding, run_id: Some(recovery.run_id.clone()), cursor: None, history_refresh: true, changes: Vec::new(),
            })).await;
        }
    }

    pub(crate) async fn recover(&mut self, identity: SessionIdentity, generation: u64, epoch: GatewayEpoch, reason: CanonicalRecoveryReason) {
        if super::trace::enabled() {
            super::trace::log_unscoped("runtime.openclaw.router.recover", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                "sourceEpoch": epoch.as_u64(), "nativeCursor": null, "inputKind": "recovery" }));
        }
        self.recoveries.remove(&(identity_key(&identity), generation));
        let result = self.actor(&identity, generation).recover(Some(epoch), reason);
        let binding = SessionEventBinding::observed(identity, generation, Some(epoch.as_u64()), false).expect("validated observation binding");
        self.send(Some(result), binding).await;
    }

    pub(crate) async fn goal(&mut self, identity: &SessionIdentity, generation: u64, session_id: &str, goal: sessions_module::goal::SessionGoalView, epoch: GatewayEpoch, cursor: Option<u64>) -> Result<(), RuntimeOperationFailure> {
        if self.actor(identity, generation).sync_goal(session_id, goal.clone())? {
            let binding = SessionEventBinding::observed(identity.clone(), generation, Some(epoch.as_u64()), false).ok_or(RuntimeOperationFailure::Unknown)?;
            self.session_events.send(SessionIngressEvent::new(identity.clone(), sessions_module::command::SessionEvent {
                binding, run_id: None, cursor, history_refresh: false, changes: vec![sessions_module::state::SessionChange::GoalChanged { goal }],
            })).await.map_err(|_| RuntimeOperationFailure::Unavailable)?;
        }
        Ok(())
    }

    pub(crate) fn approvals(&mut self, identity: &SessionIdentity, generation: u64, approvals: Vec<SessionApprovalEvent>, epoch: GatewayEpoch) -> Result<(), RuntimeOperationFailure> {
        self.actor(identity, generation).sync_approvals(&approvals, epoch)
    }

    pub(crate) fn history(&mut self, identity: SessionIdentity, generation: u64, window: SessionWindow, page: PageRequest, epoch: GatewayEpoch, host_epoch: u64) -> Result<Option<SessionSync>, RuntimeOperationFailure> {
        let mut page_actor;
        let actor = if matches!(page.direction(), Direction::Latest) {
            self.actor(&identity, generation)
        } else {
            page_actor = self.actor(&identity, generation).page_actor();
            &mut page_actor
        };
        let result = if super::trace::enabled() {
            let context = serde_json::json!({ "identity": sessions_module::trace::identity_shape(&identity),
                "generation": generation, "sourceEpoch": epoch.as_u64(), "nativeCursor": null,
                "inputKind": "history", "historyKind": format!("{:?}", window.state().kind()),
                "cursorPresent": window.state().delta_cursor().is_some(),
                "cursorHash": window.state().delta_cursor().map(sessions_module::trace::fingerprint),
                "direction": format!("{:?}", page.direction()) });
            sessions_module::trace::with_context(context, || actor.sync_history(&window, page, epoch))
        } else { actor.sync_history(&window, page, epoch) };
        if result?.is_none() { return Ok(None); }
        let mut view = actor.snapshot(host_epoch)?;
        view.identity = identity.clone();
        if super::trace::enabled() {
            let retired = actor.retired_item_ids();
            super::trace::log_unscoped("runtime.openclaw.router.history_snapshot", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                "sourceEpoch": epoch.as_u64(), "hostEpoch": host_epoch, "items": sessions_module::trace::view_shape(&view),
                "retiredItemCount": retired.len(), "retiredItemsTruncated": retired.len() > 200,
                "retiredItemHashes": retired.iter().take(200).map(|id| sessions_module::trace::fingerprint(id)).collect::<Vec<_>>() }));
        }
        view.session_key = identity.session_key;
        Ok(Some(SessionSync { view, source_epoch: Some(epoch.as_u64()), source_branch: window.state().active_leaf_entry_id().map(str::to_owned), cut: SessionSyncCut::Snapshot, replay_baseline: None, terminal_runs: actor.terminal_runs(), retired_item_ids: actor.retired_item_ids(), retired_tool_ids: actor.retired_tool_ids(), retired_approval_ids: actor.retired_approval_ids() }))
    }

    pub(crate) fn restart(&mut self, identity: &SessionIdentity, generation: u64, next_generation: u64) -> Result<(), RuntimeOperationFailure> {
        let key = identity_key(identity);
        if self.actors.contains_key(&(key.clone(), next_generation)) {
            if super::trace::enabled() {
                super::trace::log_unscoped("runtime.openclaw.router.restart_rejected", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(identity), "generation": generation,
                    "nextGeneration": next_generation, "reason": "target_actor_exists" }));
            }
            return Err(RuntimeOperationFailure::Unknown);
        }
        if super::trace::enabled() {
            super::trace::log_unscoped("runtime.openclaw.router.restart_move", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(identity), "generation": generation,
                "nextGeneration": next_generation, "sourceEpoch": null,
                "originalActorPresent": self.actors.contains_key(&(key.clone(), generation)),
                "originalBodyPresent": self.actors.contains_key(&(key.clone(), generation)),
                "decision": if self.actors.contains_key(&(key.clone(), generation)) { "move_existing_actor" } else { "create_first_actor" } }));
        }
        self.pending_messages.remove(&(key.clone(), generation));
        self.recoveries.remove(&(key.clone(), generation));
        self.recovery_claims.retain(|claim| claim.0 != key || claim.1 != generation);
        let mut actor = self.actors.remove(&(key.clone(), generation)).unwrap_or_else(||
            SessionReducerActor::new(SessionKey::try_new(identity.session_key.clone()).expect("validated observation key")));
        let _ = actor.recover(None, CanonicalRecoveryReason::NativeUnknown);
        self.actors.insert((key, next_generation), actor);
        if super::trace::enabled() {
            super::trace::log_unscoped("runtime.openclaw.router.restart_moved", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(identity), "generation": generation,
                "nextGeneration": next_generation, "sourceEpoch": null }));
        }
        Ok(())
    }

    pub(crate) fn close(&mut self, identity: &SessionIdentity, generation: u64) {
        let key = (identity_key(identity), generation);
        self.pending_messages.remove(&key);
        self.recoveries.remove(&key);
        self.recovery_claims.retain(|claim| claim.0 != key.0 || claim.1 != generation);
        let removed = self.actors.remove(&key);
        if super::trace::enabled() {
            super::trace::log_unscoped("runtime.openclaw.router.close", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(identity), "generation": generation,
                "actorRemoved": removed.is_some(), "bodyDestroyed": removed.is_some() }));
        }
    }

    async fn send(&self, result: Option<CanonicalIngressResult>, binding: SessionEventBinding) {
        if let Some(result) = result && let Some(event) = openclaw_session_event(&result, binding) {
            let _ = self.session_events.send(event).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use tokio::sync::mpsc;

    use super::*;
    use crate::session::protocol::{ChatEvent, ChatState, RunId, SessionEventKind};
    use sessions_module::state::SessionChange;

    fn session_key(value: &str) -> SessionKey {
        SessionKey::try_new(value).unwrap()
    }

    fn run_id(value: &str) -> RunId {
        RunId::try_new(value).unwrap()
    }

    fn gateway_epoch(value: u64) -> GatewayEpoch {
        GatewayEpoch::try_new(value).unwrap()
    }

    fn chat_delta(session: &str, run: &str, sequence: u64, text: &str) -> SessionEventEnvelope {
        let session_key = session_key(session);
        let run_id = run_id(run);
        SessionEventEnvelope {
            gateway_sequence: Some(sequence),
            kind: SessionEventKind::Chat,
            session_key: session_key.clone(),
            run_id: Some(run_id.clone()),
            message_id: None,
            embedded_message_id: None,
            chat: Some(ChatEvent {
                run_id,
                session_key,
                sequence,
                state: ChatState::Delta,
                status_phase: None,
                status_retry: None,
                delta_text: Some(text.to_owned()),
                replace: false,
                message_text: None,
                message_thinking: None,
                final_message: None,
                yielded: false,
                message_absent: true,
                error_kind: None,
                error_message: None,
                stop_reason: None,
                error_detail: None,
            }),
            activity: None,
            approval: None,
            changed: None,
        }
    }

    #[tokio::test]
    async fn routes_sessions_independently_and_sends_session_events() {
        let (session_events, mut received_events) = mpsc::channel(4);
        let mut router = EventRouter::new(session_events);

        router
            .route(
                chat_delta("agent:main:session-1", "run-1", 1, "one"),
                gateway_epoch(1),
                Some("renderer-route:1".to_owned()),
            )
            .await;
        router
            .route(
                chat_delta("agent:main:session-2", "run-2", 1, "two"),
                gateway_epoch(1),
                Some("renderer-route:2".to_owned()),
            )
            .await;
        assert_eq!(router.actors.len(), 2);

        let (identity, first) = received_events.recv().await.unwrap().into_parts();
        assert_eq!(identity.session_key, "agent:main:session-1");
        assert_eq!(first.binding.route_key(), Some("renderer-route:1"));
        assert!(matches!(
            first.changes.as_slice(),
            [SessionChange::MessageDelta { run_id: Some(run_id), text, .. }]
                if run_id == "run-1" && text == "one"
        ));

        let (identity, second) = received_events.recv().await.unwrap().into_parts();
        assert_eq!(identity.session_key, "agent:main:session-2");
        assert_eq!(second.binding.route_key(), Some("renderer-route:2"));
        assert!(matches!(
            second.changes.as_slice(),
            [SessionChange::MessageDelta { run_id: Some(run_id), text, .. }]
                if run_id == "run-2" && text == "two"
        ));
        assert!(received_events.try_recv().is_err());
    }
}
