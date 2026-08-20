pub mod canonical;

/// Cross-runtime outcome for a native mutation after it crosses an invocation boundary.
///
/// It records what the caller can know about the target effect; it is not a
/// Domain fact store, retry queue, or final native history owner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InvocationOutcome<O, E> {
    /// The target reports that the mutation completed and returned `O`.
    Succeeded(O),
    /// The target rejected the mutation before accepting ownership of the effect.
    TargetRejected(E),
    /// The caller cancelled the invocation before a terminal target outcome was known.
    Cancelled,
    /// The mutation may have reached the target. Callers must not retry it automatically.
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcomes_keep_success_rejection_cancellation_and_uncertainty_distinct() {
        let succeeded: InvocationOutcome<&str, &str> = InvocationOutcome::Succeeded("output");
        let rejected: InvocationOutcome<&str, &str> = InvocationOutcome::TargetRejected("reason");
        let cancelled: InvocationOutcome<&str, &str> = InvocationOutcome::Cancelled;
        let unknown: InvocationOutcome<&str, &str> = InvocationOutcome::Unknown;

        assert_eq!(succeeded, InvocationOutcome::Succeeded("output"));
        assert_eq!(rejected, InvocationOutcome::TargetRejected("reason"));
        assert_eq!(cancelled, InvocationOutcome::Cancelled);
        assert_eq!(unknown, InvocationOutcome::Unknown);
    }
}
