use std::fmt;

/// The outcome of a mutation whose request may have reached the peer.
///
/// A failed mutation is never replayed by this layer. Callers must decide how
/// to reconcile `MayHaveReached` with the native runtime.
pub(crate) enum MutationDelivery {
    Response(super::wire::GatewayResponse),
    NotWritten(DispatcherError),
    MayHaveReached(DispatcherError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DispatcherError {
    Deadline,
    ConnectionClosed,
    Transport,
    Protocol,
    EventBackpressure,
    Saturated,
}

impl fmt::Display for DispatcherError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Deadline => "gateway request deadline elapsed",
            Self::ConnectionClosed => "gateway connection closed",
            Self::Transport => "gateway transport failed",
            Self::Protocol => "gateway protocol failed",
            Self::EventBackpressure => "gateway event channel is full",
            Self::Saturated => "gateway dispatcher is saturated",
        })
    }
}

impl std::error::Error for DispatcherError {}
