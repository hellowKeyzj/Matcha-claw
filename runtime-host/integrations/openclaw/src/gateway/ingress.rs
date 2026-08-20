use std::{fmt, num::NonZeroUsize, sync::Mutex};

use tokio::sync::mpsc;

use crate::session::protocol::SessionEventEnvelope;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct GatewayEpoch(u64);

impl GatewayEpoch {
    pub(crate) const fn as_u64(self) -> u64 {
        self.0
    }

    pub(crate) fn try_new(value: u64) -> Result<Self, EpochError> {
        if value == 0 {
            return Err(EpochError::Zero);
        }
        Ok(Self(value))
    }

    pub(crate) fn next(self) -> Result<Self, EpochError> {
        self.0
            .checked_add(1)
            .ok_or(EpochError::Exhausted)
            .and_then(Self::try_new)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum EpochError {
    Zero,
    Exhausted,
}

impl fmt::Display for EpochError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Zero => "gateway epoch must be non-zero",
            Self::Exhausted => "gateway epoch is exhausted",
        })
    }
}

impl std::error::Error for EpochError {}

pub(crate) struct Ingress {
    sender: mpsc::Sender<IngressEvent>,
    state: Mutex<State>,
}

impl Ingress {
    pub(crate) fn new(capacity: NonZeroUsize) -> (Self, mpsc::Receiver<IngressEvent>) {
        let (sender, receiver) = mpsc::channel(capacity.get());
        (
            Self {
                sender,
                state: Mutex::new(State::default()),
            },
            receiver,
        )
    }

    pub(crate) fn begin_epoch(&self, epoch: GatewayEpoch) -> Result<(), IngressError> {
        let mut state = self.lock_state();
        match state.epoch {
            None => state.epoch = Some(epoch),
            Some(current) if epoch > current => {
                state.epoch = Some(epoch);
                state.last_sequence = None;
            }
            Some(current) if epoch < current => return Err(IngressError::StaleEpoch),
            Some(_) => {}
        }
        Ok(())
    }

    pub(crate) fn active_epoch(&self) -> Option<GatewayEpoch> {
        self.lock_state().epoch
    }

    pub(crate) fn try_ingest(
        &self,
        epoch: GatewayEpoch,
        event: SessionEventEnvelope,
    ) -> Result<(), IngressError> {
        let sequence = event.gateway_sequence;
        let mut state = self.lock_state();
        match state.epoch {
            Some(current) if epoch == current => {}
            Some(current) if epoch < current => return Err(IngressError::StaleEpoch),
            _ => return Err(IngressError::EpochNotActive),
        }
        if let (Some(last_sequence), Some(sequence)) = (state.last_sequence, sequence)
            && sequence <= last_sequence
        {
            return Err(IngressError::NonMonotonicSequence);
        }
        self.sender
            .try_send(IngressEvent { epoch, event })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => IngressError::Backpressure,
                mpsc::error::TrySendError::Closed(_) => IngressError::Closed,
            })?;
        if let Some(sequence) = sequence {
            state.last_sequence = Some(sequence);
        }
        Ok(())
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Default)]
struct State {
    epoch: Option<GatewayEpoch>,
    last_sequence: Option<u64>,
}

pub(crate) struct IngressEvent {
    epoch: GatewayEpoch,
    event: SessionEventEnvelope,
}

impl IngressEvent {
    pub(crate) fn epoch(&self) -> GatewayEpoch {
        self.epoch
    }

    pub(crate) fn event(&self) -> &SessionEventEnvelope {
        &self.event
    }
}

impl fmt::Debug for IngressEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IngressEvent")
            .field("epoch", &self.epoch)
            .field("event", &self.event)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum IngressError {
    EpochNotActive,
    StaleEpoch,
    NonMonotonicSequence,
    Backpressure,
    Closed,
}

impl fmt::Display for IngressError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::EpochNotActive => "gateway epoch is not active",
            Self::StaleEpoch => "gateway epoch is stale",
            Self::NonMonotonicSequence => "gateway sequence is not monotonic",
            Self::Backpressure => "gateway ingress is full",
            Self::Closed => "gateway ingress is closed",
        })
    }
}

impl std::error::Error for IngressError {}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;

    use serde_json::json;

    use super::*;
    use crate::{gateway::wire::GatewayEvent, session::protocol::decode_session_event};

    fn epoch(value: u64) -> GatewayEpoch {
        GatewayEpoch::try_new(value).unwrap()
    }

    fn event(sequence: Option<u64>) -> SessionEventEnvelope {
        decode_session_event(GatewayEvent {
            name: "sessions.changed".into(),
            payload: Some(json!({ "sessionKey": "agent:main:main" })),
            sequence,
            state_version: None,
        })
        .unwrap()
        .unwrap()
    }

    #[test]
    fn rejects_zero_epoch() {
        assert_eq!(GatewayEpoch::try_new(0), Err(EpochError::Zero));
    }

    #[test]
    fn rejects_stale_epoch_without_resetting_the_current_cursor() {
        let (ingress, mut receiver) = Ingress::new(NonZeroUsize::new(2).unwrap());
        ingress.begin_epoch(epoch(2)).unwrap();
        ingress.try_ingest(epoch(2), event(Some(8))).unwrap();
        assert_eq!(ingress.begin_epoch(epoch(1)), Err(IngressError::StaleEpoch));
        assert_eq!(
            ingress.try_ingest(epoch(2), event(Some(8))),
            Err(IngressError::NonMonotonicSequence)
        );
        assert_eq!(receiver.try_recv().unwrap().epoch(), epoch(2));
    }

    #[test]
    fn new_epoch_accepts_a_new_socket_sequence_and_rejects_late_events() {
        let (ingress, mut receiver) = Ingress::new(NonZeroUsize::new(2).unwrap());
        ingress.begin_epoch(epoch(4)).unwrap();
        ingress.try_ingest(epoch(4), event(Some(90))).unwrap();
        ingress.begin_epoch(epoch(5)).unwrap();
        ingress.try_ingest(epoch(5), event(Some(1))).unwrap();
        assert_eq!(
            ingress.try_ingest(epoch(4), event(Some(91))),
            Err(IngressError::StaleEpoch)
        );

        assert_eq!(receiver.try_recv().unwrap().epoch(), epoch(4));
        assert_eq!(receiver.try_recv().unwrap().epoch(), epoch(5));
    }

    #[test]
    fn rejects_non_monotonic_gateway_sequence_without_queueing_it() {
        let (ingress, mut receiver) = Ingress::new(NonZeroUsize::new(2).unwrap());
        ingress.begin_epoch(epoch(1)).unwrap();
        ingress.try_ingest(epoch(1), event(Some(7))).unwrap();
        assert_eq!(
            ingress.try_ingest(epoch(1), event(Some(7))),
            Err(IngressError::NonMonotonicSequence)
        );
        assert_eq!(
            ingress.try_ingest(epoch(1), event(Some(6))),
            Err(IngressError::NonMonotonicSequence)
        );
        assert_eq!(
            receiver.try_recv().unwrap().event().gateway_sequence,
            Some(7)
        );
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn backpressure_does_not_advance_the_gateway_sequence() {
        let (ingress, mut receiver) = Ingress::new(NonZeroUsize::new(1).unwrap());
        ingress.begin_epoch(epoch(1)).unwrap();
        ingress.try_ingest(epoch(1), event(Some(11))).unwrap();
        assert_eq!(
            ingress.try_ingest(epoch(1), event(Some(12))),
            Err(IngressError::Backpressure)
        );
        assert_eq!(
            receiver.try_recv().unwrap().event().gateway_sequence,
            Some(11)
        );
        ingress.try_ingest(epoch(1), event(Some(12))).unwrap();
        assert_eq!(
            receiver.try_recv().unwrap().event().gateway_sequence,
            Some(12)
        );
    }

    #[test]
    fn unsequenced_events_keep_arrival_order() {
        let (ingress, mut receiver) = Ingress::new(NonZeroUsize::new(2).unwrap());
        ingress.begin_epoch(epoch(3)).unwrap();
        ingress.try_ingest(epoch(3), event(None)).unwrap();
        ingress.try_ingest(epoch(3), event(Some(4))).unwrap();

        assert_eq!(receiver.try_recv().unwrap().event().gateway_sequence, None);
        assert_eq!(
            receiver.try_recv().unwrap().event().gateway_sequence,
            Some(4)
        );
    }

    #[test]
    fn ingress_debug_projection_excludes_raw_gateway_payload() {
        let (ingress, mut receiver) = Ingress::new(NonZeroUsize::new(1).unwrap());
        ingress.begin_epoch(epoch(1)).unwrap();
        let event = decode_session_event(GatewayEvent {
            name: "sessions.changed".into(),
            payload: Some(json!({
                "sessionKey": "agent:main:main",
                "token": "gateway-token-canary",
                "path": "C:/private/session.jsonl",
                "transcript": "private transcript canary",
            })),
            sequence: Some(1),
            state_version: None,
        })
        .unwrap()
        .unwrap();
        ingress.try_ingest(epoch(1), event).unwrap();

        let debug = format!("{:?}", receiver.try_recv().unwrap());
        for secret in [
            "gateway-token-canary",
            "C:/private/session.jsonl",
            "private transcript canary",
        ] {
            assert!(!debug.contains(secret));
        }
    }
}
