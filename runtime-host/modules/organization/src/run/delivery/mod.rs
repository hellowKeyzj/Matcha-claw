mod ledger;
mod model;
mod restore;
mod transition;

pub use ledger::{DeliveryLedger, DeliveryLedgerSnapshot, RegisterOutcome, RestoreLedgerError};
pub use model::{
    AuthorizedGraphOutcome, AuthorizedGraphResolution, AuthorizedGraphResolutionReceipt,
    DELIVERY_MAX_ATTEMPTS, DELIVERY_RETRY_DELAY_MS, Delivery, DeliveryClaim, DeliveryFailure,
    DeliveryId, DeliveryIdError, DeliveryPhase, DeliveryReceipt, DeliveryRequest,
    DeliveryRequestError, InvalidAuthorizedGraphResolution,
    InvalidAuthorizedGraphResolutionReceipt, InvalidNativeRunReceiptReference,
    NativeDeliveryCorrelation, NativeRunReceiptReference, NativeTerminalStatus, TeamNodeOutput,
    TeamNodeOutputError, TerminalObservation, TerminalObservationResolution, delivery_retry_at,
};
pub use restore::{
    DeliveryClaimSnapshot, DeliveryPhaseSnapshot, DeliverySnapshot, RestoreDeliveryError,
    TerminalObservationSnapshot, TerminalObservationSnapshotInput,
};
pub use transition::{
    AuthorizedGraphResolutionError, AuthorizedGraphResolutionOutcome, DeliveryDispatch,
    DeliveryReceiptError, DeliveryRecovery, DeliveryResolution, DeliveryStart,
    NativeRunOutputResolutionError, RegisterDeliveryError, TerminalObservationError,
    TerminalObservationOutcome, begin_delivery, dispatch_delivery, recover_interrupted_delivery,
    register_delivery, settle_delivery,
};

pub(crate) use transition::{
    observe_native_terminal, resolve_authorized_graph_outcome, resolve_native_run_output,
};

#[cfg(test)]
mod tests;
