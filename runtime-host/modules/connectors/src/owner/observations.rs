use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use platform::{call::CallId, endpoint::runtime_address::RuntimeEndpoint};

use crate::{
    application::receipts::ConnectorObservationReceipt,
    delivery::{SessionConnectorStatus, SessionIdentity},
};

const CAPACITY: usize = 64;
const RETENTION: Duration = Duration::from_secs(5 * 60);

#[derive(Clone)]
pub(crate) enum ObservationResult {
    Status(Vec<(String, ConnectorObservationReceipt)>),
    Probe(String, ConnectorObservationReceipt),
    SessionStatus {
        session_identity: SessionIdentity,
        statuses: Vec<SessionConnectorStatus>,
    },
}

pub(crate) struct ObservationSubject {
    pub(crate) principal: String,
    pub(crate) endpoint: Option<RuntimeEndpoint>,
    pub(crate) session_identity: Option<SessionIdentity>,
}

struct ObservationSlot {
    session: ObservationSubject,
    state: ObservationState,
}

enum ObservationState {
    Pending,
    Complete {
        result: ObservationResult,
        expires: Instant,
    },
}

#[derive(Default)]
pub(crate) struct ObservationResults(Mutex<HashMap<CallId, ObservationSlot>>);

pub(crate) enum ObservationReadError {
    Pending,
    Missing,
}

impl ObservationResults {
    pub(crate) fn reserve(&self, call_id: &CallId, session: ObservationSubject) -> Result<(), ()> {
        let mut slots = self.0.lock().expect("connector observations lock");
        purge(&mut slots);
        if slots.len() >= CAPACITY {
            return Err(());
        }
        slots.insert(
            call_id.clone(),
            ObservationSlot {
                session,
                state: ObservationState::Pending,
            },
        );
        Ok(())
    }

    pub(crate) fn complete(&self, call_id: &CallId, result: ObservationResult) {
        let mut slots = self.0.lock().expect("connector observations lock");
        if let Some(slot) = slots.get_mut(call_id) {
            slot.state = ObservationState::Complete {
                result,
                expires: Instant::now() + RETENTION,
            };
        }
    }

    pub(crate) fn discard(&self, call_id: &CallId) {
        self.0
            .lock()
            .expect("connector observations lock")
            .remove(call_id);
    }

    pub(crate) fn read(
        &self,
        call_id: &CallId,
        principal: &str,
        endpoint: Option<&RuntimeEndpoint>,
        session_identity: Option<&SessionIdentity>,
    ) -> Result<ObservationResult, ObservationReadError> {
        let mut slots = self.0.lock().expect("connector observations lock");
        purge(&mut slots);
        let slot = slots.get(call_id).ok_or(ObservationReadError::Missing)?;
        if slot.session.principal != principal
            || slot.session.endpoint.as_ref() != endpoint
            || slot.session.session_identity.as_ref() != session_identity
        {
            return Err(ObservationReadError::Missing);
        }
        match &slot.state {
            ObservationState::Pending => Err(ObservationReadError::Pending),
            ObservationState::Complete { result, .. } => Ok(result.clone()),
        }
    }
}

fn purge(slots: &mut HashMap<CallId, ObservationSlot>) {
    let now = Instant::now();
    slots.retain(|_, slot| match &slot.state {
        ObservationState::Pending => true,
        ObservationState::Complete { expires, .. } => *expires > now,
    });
}
