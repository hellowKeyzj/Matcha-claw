#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionStatus {
    Opening,
    Connected,
    Closing,
    Closed,
    Failed,
    Expired,
}
