use std::time::Duration;

pub(super) const fn cleanup_timeout() -> Duration {
    Duration::from_secs(5)
}
