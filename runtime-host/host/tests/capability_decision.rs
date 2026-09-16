use runtime_host::transport::common::authorization::{
    CapabilityDecisionError, CapabilityDecisionVerifier,
};

const VERIFICATION_KEY: &str = "MCowBQYDK2VwAyEAhI7FT5ZzRIPEHVkZavhKl2CqMou1WrMW7b9vB7BHXoE";
const DECISION: &str = "capability-decision.v1.eyJ2ZXJzaW9uIjoxLCJwcmluY2lwYWwiOiJkZXNrdG9wLXNlc3Npb246Zml4dHVyZSIsImVuZHBvaW50IjoiL2FwaS9zZXNzaW9ucyIsInNjb3BlIjoic2Vzc2lvbnM6cmVhZCIsImNhcGFiaWxpdHkiOiJzZXNzaW9ucy5saXN0Iiwic3ViamVjdCI6InNlc3Npb24tY2F0YWxvZyIsImV4cGlyZXNBdCI6MjAwMCwiY29ycmVsYXRpb24iOiJjb3JyOmZpeHR1cmUiLCJyZXZpc2lvbiI6InJldmlzaW9uOmZpeHR1cmUifQ.q4gXKSK69UmOOSjvoEiJciu3W_9NPnZjzXywGt9nib5w8pctdiDZ4WRKJggNvPmpEmQayJRe__scPqFH6wLzCg";

#[test]
fn verifies_main_signed_fixed_capability_decisions_once() {
    let mut verifier = CapabilityDecisionVerifier::try_new(VERIFICATION_KEY).unwrap();

    let decision = verifier
        .verify(
            DECISION,
            1_999,
            "/api/sessions",
            "sessions:read",
            "sessions.list",
            "session-catalog",
        )
        .unwrap();

    assert_eq!(decision.principal(), "desktop-session:fixture");
    assert_eq!(decision.correlation(), "corr:fixture");
    assert_eq!(decision.revision(), "revision:fixture");
    assert_eq!(
        verifier.verify(
            DECISION,
            1_999,
            "/api/sessions",
            "sessions:read",
            "sessions.list",
            "session-catalog",
        ),
        Err(CapabilityDecisionError::Rejected)
    );
}

#[test]
fn rejects_expired_tampered_and_unfixed_decisions_without_echoing_them() {
    let mut verifier = CapabilityDecisionVerifier::try_new(VERIFICATION_KEY).unwrap();

    assert_eq!(
        verifier.verify(
            DECISION,
            2_000,
            "/api/sessions",
            "sessions:read",
            "sessions.list",
            "session-catalog",
        ),
        Err(CapabilityDecisionError::Rejected)
    );
    assert_eq!(
        verifier.verify(
            &format!("{DECISION}x"),
            1_999,
            "/api/sessions",
            "sessions:read",
            "sessions.list",
            "session-catalog",
        ),
        Err(CapabilityDecisionError::Rejected)
    );
    assert_eq!(
        verifier.verify(
            DECISION,
            1_999,
            "/api/diagnostics",
            "sessions:read",
            "sessions.list",
            "session-catalog",
        ),
        Err(CapabilityDecisionError::Rejected)
    );
    assert!(!format!("{verifier:?}").contains(DECISION));
}
