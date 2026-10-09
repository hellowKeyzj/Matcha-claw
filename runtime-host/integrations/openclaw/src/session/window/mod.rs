mod history;
mod model;

pub(crate) use history::{decode_complete_text, decode_event_message, decode_total_messages, decode_transcript_event_message, decode_session_message};
pub use history::{HistoryError, decode_window, direction};
pub use model::{
    ActivityPosition, DisplayPosition, StreamFallback, StreamFallbackSource,
    Direction, HistoryKind, InFlightRun, InputReceipt, LargeTextFacts, Message, MessageContent, MessageRole,
    MessageToolDeliveryMedia, OmittedContentKind, PageMetadata, PageRequest, PendingInput,
    PendingInputState, RunState, SessionState, SessionWindow, WindowRange, window_range,
};

#[cfg(test)]
mod tests;
