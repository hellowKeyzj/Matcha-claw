use std::collections::HashMap;

use sessions_module::{command::SessionIngressEvent, ports::{RuntimeOperationFailure, SessionSync, SessionSyncCut}, state::{SessionEventBinding, SessionIdentity}};
use tokio::sync::mpsc;

use crate::{driver::projection::openclaw_session_event, gateway::{ingress::GatewayEpoch, observation::identity_key}};

use super::{
    projection::{CanonicalIngressResult, CanonicalRecoveryReason},
    protocol::{SessionApprovalEvent, SessionEventEnvelope, SessionKey},
    reducer::SessionReducerActor,
    window::{Direction, PageRequest, SessionWindow},
};

pub(crate) struct EventRouter {
    actors: HashMap<(String, u64), SessionReducerActor>,
    session_events: mpsc::Sender<SessionIngressEvent>,
}

impl EventRouter {
    pub(crate) fn new(session_events: mpsc::Sender<SessionIngressEvent>) -> Self {
        Self { actors: HashMap::new(), session_events }
    }

    fn actor(&mut self, identity: &SessionIdentity, generation: u64) -> &mut SessionReducerActor {
        self.actors.entry((identity_key(identity), generation)).or_insert_with(||
            SessionReducerActor::new(SessionKey::try_new(identity.session_key.clone()).expect("validated observation key")))
    }

    pub(crate) async fn route(&mut self, event: SessionEventEnvelope, epoch: GatewayEpoch, identity: SessionIdentity, generation: u64) {
        let cursor = event.gateway_sequence;
        let run_id = event.run_id.as_ref().map(|run| run.as_str().to_owned());
        let result = if super::trace::enabled() {
            let context = serde_json::json!({ "identity": sessions_module::trace::identity_shape(&identity),
                "generation": generation, "sourceEpoch": epoch.as_u64(), "nativeCursor": cursor,
                "inputKind": "live", "eventKind": format!("{:?}", event.kind),
                "runHash": run_id.as_deref().map(sessions_module::trace::fingerprint) });
            sessions_module::trace::with_context(context, || self.actor(&identity, generation).reduce(event, Some(epoch)))
        } else { self.actor(&identity, generation).reduce(event, Some(epoch)) };
        let binding = SessionEventBinding::observed(identity.clone(), generation, Some(epoch.as_u64()), false).expect("validated observation binding");
        if let Some(event) = result.as_ref().and_then(|result| openclaw_session_event(result, binding.clone())) {
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
            if cursor.is_some() {
                let sent = self.session_events.send(SessionIngressEvent::new(identity.clone(), sessions_module::command::SessionEvent { binding, run_id, cursor, changes: Vec::new() })).await;
                if super::trace::enabled() {
                    super::trace::log_unscoped("runtime.openclaw.router.delivery", serde_json::json!({
                        "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                        "sourceEpoch": epoch.as_u64(), "nativeCursor": cursor, "cursorOnly": true,
                        "queueAccepted": sent.is_ok(), "hostApplied": "not_observed" }));
                }
            }
        }
    }

    pub(crate) async fn recover(&mut self, identity: SessionIdentity, generation: u64, epoch: GatewayEpoch, reason: CanonicalRecoveryReason) {
        if super::trace::enabled() {
            super::trace::log_unscoped("runtime.openclaw.router.recover", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                "sourceEpoch": epoch.as_u64(), "nativeCursor": null, "inputKind": "recovery" }));
        }
        let result = self.actor(&identity, generation).recover(Some(epoch), reason);
        let binding = SessionEventBinding::observed(identity, generation, Some(epoch.as_u64()), false).expect("validated observation binding");
        self.send(Some(result), binding).await;
    }

    pub(crate) async fn goal(&mut self, identity: &SessionIdentity, generation: u64, session_id: &str, goal: sessions_module::goal::SessionGoalView, epoch: GatewayEpoch, cursor: Option<u64>) -> Result<(), RuntimeOperationFailure> {
        if self.actor(identity, generation).sync_goal(session_id, goal.clone())? {
            let binding = SessionEventBinding::observed(identity.clone(), generation, Some(epoch.as_u64()), false).ok_or(RuntimeOperationFailure::Unknown)?;
            self.session_events.send(SessionIngressEvent::new(identity.clone(), sessions_module::command::SessionEvent {
                binding, run_id: None, cursor, changes: vec![sessions_module::state::SessionChange::GoalChanged { goal }],
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
        Ok(Some(SessionSync { view, source_epoch: Some(epoch.as_u64()), source_branch: window.state().active_leaf_entry_id().map(str::to_owned), cut: SessionSyncCut::Snapshot, replay_baseline: None, terminal_runs: actor.terminal_runs(), retired_item_ids: actor.retired_item_ids() }))
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
        let removed = self.actors.remove(&(identity_key(identity), generation));
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
