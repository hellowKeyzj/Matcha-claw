mod history;
mod model;

pub(crate) use history::decode_transcript_event_message;
pub use history::{HistoryError, decode_window, direction};
pub use model::{
    Direction, InFlightRun, InputReceipt, Message, MessageContent, MessageRole,
    MessageToolDeliveryMedia, OmittedContentKind, PageMetadata, PageRequest, PendingInput,
    PendingInputState, RunState, SessionState, SessionWindow, WindowRange, window_range,
};

#[cfg(test)]
mod tests;
