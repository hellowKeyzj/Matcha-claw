use openclaw::lifecycle::logs::{
    LifecycleDiagnostic, LifecycleDiagnosticCategory, LifecycleLogBuffer, LifecycleLogClassifier,
    LogStream, MAX_LINE_BYTES, MAX_TAIL_ENTRY_BYTES, MAX_TAIL_LINES,
};

fn assert_diagnostic(
    diagnostic: &LifecycleDiagnostic,
    stream: LogStream,
    category: LifecycleDiagnosticCategory,
) {
    assert_eq!(diagnostic.stream(), stream);
    assert_eq!(diagnostic.category(), category);
}

fn assert_diagnostics(
    actual: &[LifecycleDiagnostic],
    expected: &[(LogStream, LifecycleDiagnosticCategory)],
) {
    assert_eq!(actual.len(), expected.len());
    for (diagnostic, &(stream, category)) in actual.iter().zip(expected) {
        assert_diagnostic(diagnostic, stream, category);
    }
}

#[test]
fn classifies_locked_openclaw_gateway_output_without_treating_it_as_state() {
    let mut stdout = LifecycleLogClassifier::new(LogStream::Stdout);
    let mut stderr = LifecycleLogClassifier::new(LogStream::Stderr);

    assert_diagnostics(
        &stdout
            .push(b"2026-05-20T12:00:00Z [gateway] listening on ws://127.0.0.1:18789 (PID 123)\n"),
        &[(
            LogStream::Stdout,
            LifecycleDiagnosticCategory::ListenerReported,
        )],
    );
    assert_diagnostics(
        &stderr.push(b"Gateway failed to start: another gateway instance is already listening on ws://127.0.0.1:18789\n"),
        &[(LogStream::Stderr, LifecycleDiagnosticCategory::PortConflict)],
    );
    assert_diagnostics(
        &stderr.push(b"Gateway start blocked: existing config is missing gateway.mode.\n"),
        &[(
            LogStream::Stderr,
            LifecycleDiagnosticCategory::ConfigurationRejected,
        )],
    );
    assert_diagnostics(
        &stderr.push(b"refusing to bind gateway to 0.0.0.0:18789 without auth\n"),
        &[(LogStream::Stderr, LifecycleDiagnosticCategory::BindRejected)],
    );
}

#[test]
fn handles_lf_crlf_and_patterns_split_across_chunks() {
    let mut classifier = LifecycleLogClassifier::new(LogStream::Stderr);

    assert!(classifier.push(b"Gateway failed to ").is_empty());
    assert_diagnostics(
        &classifier.push(
            b"start: startup dependency unavailable\r\nignored line\nGateway startup failed:",
        ),
        &[(
            LogStream::Stderr,
            LifecycleDiagnosticCategory::StartupFailed,
        )],
    );
    assert_diagnostics(
        &classifier.finish(),
        &[(
            LogStream::Stderr,
            LifecycleDiagnosticCategory::StartupFailed,
        )],
    );
}

#[test]
fn accepts_the_maximum_crlf_line_and_recovers_after_an_oversized_line() {
    let mut classifier = LifecycleLogClassifier::new(LogStream::Stderr);
    let mut maximum = vec![b'x'; MAX_LINE_BYTES];
    maximum.extend_from_slice(b"\r\n");
    assert!(classifier.push(&maximum).is_empty());

    let mut oversized = vec![b'x'; MAX_LINE_BYTES + 1];
    oversized.extend_from_slice(
        b"\nGateway failed to start: another gateway instance is already listening on ws://127.0.0.1:18789\n",
    );
    assert_diagnostics(
        &classifier.push(&oversized),
        &[
            (LogStream::Stderr, LifecycleDiagnosticCategory::LineTooLong),
            (LogStream::Stderr, LifecycleDiagnosticCategory::PortConflict),
        ],
    );
}

#[test]
fn reports_invalid_utf8_and_continues_with_the_next_line() {
    let mut classifier = LifecycleLogClassifier::new(LogStream::Stderr);

    assert_diagnostics(
        &classifier.push(
            b"Gateway failed to start: invalid byte \xff\nGateway start blocked: existing config is missing gateway.mode.\n",
        ),
        &[
            (LogStream::Stderr, LifecycleDiagnosticCategory::InvalidEncoding),
            (
                LogStream::Stderr,
                LifecycleDiagnosticCategory::ConfigurationRejected,
            ),
        ],
    );
}

#[test]
fn eof_flushes_one_partial_line_and_then_closes_the_classifier() {
    let mut classifier = LifecycleLogClassifier::new(LogStream::Stdout);

    assert!(
        classifier
            .push(b"[gateway] listening on ws://127.0.0.1:18789")
            .is_empty()
    );
    assert_diagnostics(
        &classifier.finish(),
        &[(
            LogStream::Stdout,
            LifecycleDiagnosticCategory::ListenerReported,
        )],
    );
    assert!(classifier.finish().is_empty());
    assert!(
        classifier
            .push(b"Gateway failed to start: ignored after EOF\n")
            .is_empty()
    );
}

#[test]
fn diagnostics_never_retain_or_echo_native_output() {
    const CANARIES: [&str; 5] = [
        "credential-canary-must-not-escape",
        "C:\\Users\\operator\\.openclaw\\openclaw.json",
        "config-value-canary-must-not-escape",
        "transcript-canary-must-not-escape",
        "raw-output-canary-must-not-escape",
    ];
    let mut classifier = LifecycleLogClassifier::new(LogStream::Stderr);
    let input = format!(
        "Gateway failed to start: {} {} {} {} {}\n",
        CANARIES[0], CANARIES[1], CANARIES[2], CANARIES[3], CANARIES[4],
    );
    let diagnostics = classifier.push(input.as_bytes());

    assert_diagnostics(
        &diagnostics,
        &[(
            LogStream::Stderr,
            LifecycleDiagnosticCategory::StartupFailed,
        )],
    );
    for rendered in [diagnostics[0].to_string(), format!("{:?}", diagnostics[0])] {
        for canary in CANARIES {
            assert!(!rendered.contains(canary));
        }
    }

    let mut oversized = LifecycleLogClassifier::new(LogStream::Stderr);
    let mut oversized_input = CANARIES[0].repeat(MAX_LINE_BYTES / CANARIES[0].len() + 2);
    oversized_input.push('\n');
    let diagnostic = oversized.push(oversized_input.as_bytes())[0];
    for rendered in [diagnostic.to_string(), format!("{diagnostic:?}")] {
        for canary in CANARIES {
            assert!(!rendered.contains(canary));
        }
    }
}

#[test]
fn retains_sanitized_bounded_tail_lines_with_stream_identity() {
    const SECRET: &str = "credential-canary-must-not-escape";
    let buffer = LifecycleLogBuffer::new();
    let mut classifier = LifecycleLogClassifier::with_buffer(LogStream::Stderr, buffer.clone());

    let input = format!(
        "Gateway start blocked: token={SECRET} config=C:\\Users\\operator\\.openclaw\\openclaw.json transcript-canary-must-not-escape\n"
    );
    classifier.push(input.as_bytes());

    let entries = buffer.snapshot();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].stream(), LogStream::Stderr);
    assert!(entries[0].line().contains("Gateway start blocked:"));
    assert!(!entries[0].line().contains(SECRET));
    assert!(!entries[0].line().contains("C:\\Users\\operator"));
    assert!(!entries[0].line().contains("transcript-canary"));
    assert!(entries[0].line().len() <= MAX_TAIL_ENTRY_BYTES);
}

#[test]
fn tail_buffer_evicts_oldest_lines_at_fixed_bound() {
    let buffer = LifecycleLogBuffer::new();
    let mut classifier = LifecycleLogClassifier::with_buffer(LogStream::Stdout, buffer.clone());
    for index in 0..(MAX_TAIL_LINES + 1) {
        classifier.push(format!("ordinary lifecycle line {index}\n").as_bytes());
    }

    let snapshot = buffer.snapshot_with_coverage();
    assert_eq!(snapshot.entries.len(), MAX_TAIL_LINES);
    assert!(snapshot.entries[0].line().contains("1"));
    assert!(snapshot.entries.last().unwrap().line().contains("128"));
    assert!(snapshot.tail_evicted);
}

#[test]
fn tail_buffer_coverage_is_false_before_eviction_and_stays_true_afterward() {
    let buffer = LifecycleLogBuffer::new();
    assert!(!buffer.snapshot_with_coverage().tail_evicted);

    let mut classifier = LifecycleLogClassifier::with_buffer(LogStream::Stdout, buffer.clone());
    for index in 0..MAX_TAIL_LINES {
        classifier.push(format!("ordinary lifecycle line {index}\n").as_bytes());
    }
    assert!(!buffer.snapshot_with_coverage().tail_evicted);

    classifier.push(b"ordinary lifecycle line 128\n");
    assert!(buffer.snapshot_with_coverage().tail_evicted);
}

#[test]
fn bounds_diagnostics_per_stream_with_a_single_terminal_category() {
    let mut classifier = LifecycleLogClassifier::new(LogStream::Stderr);
    let input = b"Gateway failed to start: unavailable\n".repeat(20);

    let diagnostics = classifier.push(&input);

    assert_eq!(diagnostics.len(), 16);
    assert!(
        diagnostics[..15]
            .iter()
            .all(|diagnostic| diagnostic.category() == LifecycleDiagnosticCategory::StartupFailed)
    );
    assert_diagnostic(
        &diagnostics[15],
        LogStream::Stderr,
        LifecycleDiagnosticCategory::DiagnosticLimitReached,
    );
    assert!(
        classifier
            .push(b"Gateway failed to start: ignored\n")
            .is_empty()
    );
    assert!(classifier.finish().is_empty());
}
