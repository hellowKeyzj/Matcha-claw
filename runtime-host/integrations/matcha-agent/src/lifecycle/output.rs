const MAX_LINE_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StartupDiagnosticCategory {
    PortConflict,
    ConfigurationRejected,
    AppServerReportedError,
    UnclassifiedStderr,
    InvalidUtf8,
    LineTooLong,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StartupDiagnostic {
    stream: OutputStream,
    category: StartupDiagnosticCategory,
}

impl StartupDiagnostic {
    pub const fn stream(self) -> OutputStream {
        self.stream
    }

    pub const fn category(self) -> StartupDiagnosticCategory {
        self.category
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ClassifierState {
    Collecting,
    Discarding,
    Finished,
}

pub struct StartupOutputClassifier {
    stream: OutputStream,
    line: Vec<u8>,
    state: ClassifierState,
}

impl StartupOutputClassifier {
    pub fn new(stream: OutputStream) -> Self {
        let (line, state) = match stream {
            OutputStream::Stdout => (Vec::new(), ClassifierState::Finished),
            OutputStream::Stderr => (
                Vec::with_capacity(MAX_LINE_BYTES + 1),
                ClassifierState::Collecting,
            ),
        };
        Self {
            stream,
            line,
            state,
        }
    }

    pub fn push(&mut self, bytes: &[u8], mut emit: impl FnMut(StartupDiagnostic)) {
        if self.state == ClassifierState::Finished {
            return;
        }

        let mut remaining = bytes;
        while let Some(newline) = remaining.iter().position(|byte| *byte == b'\n') {
            self.consume(&remaining[..newline], true, &mut emit);
            remaining = &remaining[newline + 1..];
        }
        self.consume(remaining, false, &mut emit);
    }

    pub fn finish(&mut self) -> Option<StartupDiagnostic> {
        match self.state {
            ClassifierState::Collecting => {
                let diagnostic = self.classify_buffered_line();
                self.state = ClassifierState::Finished;
                diagnostic
            }
            ClassifierState::Discarding => {
                self.line.clear();
                self.state = ClassifierState::Finished;
                None
            }
            ClassifierState::Finished => None,
        }
    }

    fn consume(
        &mut self,
        bytes: &[u8],
        terminated: bool,
        emit: &mut impl FnMut(StartupDiagnostic),
    ) {
        if self.state == ClassifierState::Discarding {
            if terminated {
                self.state = ClassifierState::Collecting;
            }
            return;
        }

        if self.append(bytes).is_err() {
            emit(self.diagnostic(StartupDiagnosticCategory::LineTooLong));
            self.state = if terminated {
                ClassifierState::Collecting
            } else {
                ClassifierState::Discarding
            };
            return;
        }

        if terminated && let Some(diagnostic) = self.classify_buffered_line() {
            emit(diagnostic);
        }
    }

    fn append(&mut self, bytes: &[u8]) -> Result<(), ()> {
        let total = self.line.len().checked_add(bytes.len()).ok_or(())?;
        let trailing_carriage_return =
            bytes.last().copied().or_else(|| self.line.last().copied()) == Some(b'\r');
        let content_bytes = total.saturating_sub(usize::from(trailing_carriage_return));
        if content_bytes > MAX_LINE_BYTES {
            self.line.clear();
            return Err(());
        }

        self.line.extend_from_slice(bytes);
        Ok(())
    }

    fn classify_buffered_line(&mut self) -> Option<StartupDiagnostic> {
        let content_end = self.line.len() - usize::from(self.line.last() == Some(&b'\r'));
        let category = classify_line(self.stream, &self.line[..content_end]);
        self.line.clear();
        category.map(|category| self.diagnostic(category))
    }

    const fn diagnostic(&self, category: StartupDiagnosticCategory) -> StartupDiagnostic {
        StartupDiagnostic {
            stream: self.stream,
            category,
        }
    }
}

fn classify_line(stream: OutputStream, bytes: &[u8]) -> Option<StartupDiagnosticCategory> {
    let line = std::str::from_utf8(bytes).ok();
    let Some(line) = line else {
        return Some(StartupDiagnosticCategory::InvalidUtf8);
    };
    let line = line.trim();
    if line.is_empty()
        || line.contains("\"prefix\":\"session-trace\"")
        || stream == OutputStream::Stdout
    {
        return None;
    }

    if contains_ascii_case_insensitive(line, "EADDRINUSE")
        || contains_ascii_case_insensitive(line, "address already in use")
        || (contains_ascii_case_insensitive(line, "port")
            && contains_ascii_case_insensitive(line, "already in use"))
        || (contains_ascii_case_insensitive(line, "failed to start server")
            && contains_ascii_case_insensitive(line, "port"))
    {
        return Some(StartupDiagnosticCategory::PortConflict);
    }
    if contains_ascii_case_insensitive(line, "app-server option") {
        return Some(StartupDiagnosticCategory::ConfigurationRejected);
    }
    if line.contains("[app-server:") {
        return Some(StartupDiagnosticCategory::AppServerReportedError);
    }

    Some(StartupDiagnosticCategory::UnclassifiedStderr)
}

fn contains_ascii_case_insensitive(haystack: &str, needle: &str) -> bool {
    haystack
        .as_bytes()
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET_CANARY: &str = "SECRET_CANARY_DO_NOT_EXPOSE";

    fn collect(classifier: &mut StartupOutputClassifier, bytes: &[u8]) -> Vec<StartupDiagnostic> {
        let mut diagnostics = Vec::new();
        classifier.push(bytes, |diagnostic| diagnostics.push(diagnostic));
        diagnostics
    }

    #[test]
    fn classifies_native_stderr_lines_across_lf_crlf_and_chunks() {
        let mut classifier = StartupOutputClassifier::new(OutputStream::Stderr);
        let mut diagnostics = collect(&mut classifier, b"error: Failed to start ser");
        diagnostics.extend(collect(
            &mut classifier,
            b"ver. Is port 4312 in use?\r\n[app-server:worker.ready] failure\n",
        ));

        assert_eq!(
            diagnostics
                .iter()
                .map(|diagnostic| diagnostic.category())
                .collect::<Vec<_>>(),
            vec![
                StartupDiagnosticCategory::PortConflict,
                StartupDiagnosticCategory::AppServerReportedError,
            ]
        );
        assert_eq!(diagnostics[0].stream(), OutputStream::Stderr);
    }

    #[test]
    fn discards_stdout_without_buffering_or_classifying_it() {
        let mut classifier = StartupOutputClassifier::new(OutputStream::Stdout);
        let mut output = vec![b'x'; MAX_LINE_BYTES + 1];
        output.extend_from_slice(SECRET_CANARY.as_bytes());
        output.extend_from_slice(&[0xff, b'\n']);

        assert!(collect(&mut classifier, &output).is_empty());
        assert!(classifier.line.is_empty());
        assert_eq!(classifier.finish(), None);
    }

    #[test]
    fn reports_invalid_utf8_and_recovers_at_the_next_line() {
        let mut classifier = StartupOutputClassifier::new(OutputStream::Stderr);
        let mut input = SECRET_CANARY.as_bytes().to_vec();
        input.extend_from_slice(&[0xff, b'\n']);
        input.extend_from_slice(b"Unknown app-server option: --synthetic\n");

        let diagnostics = collect(&mut classifier, &input);
        assert_eq!(
            diagnostics
                .iter()
                .map(|diagnostic| diagnostic.category())
                .collect::<Vec<_>>(),
            vec![
                StartupDiagnosticCategory::InvalidUtf8,
                StartupDiagnosticCategory::ConfigurationRejected,
            ]
        );
        assert!(!format!("{diagnostics:?}").contains(SECRET_CANARY));
    }

    #[test]
    fn bounds_overlong_lines_discards_the_remainder_and_recovers() {
        let mut classifier = StartupOutputClassifier::new(OutputStream::Stderr);
        let mut input = vec![b'x'; MAX_LINE_BYTES];
        input.extend_from_slice(SECRET_CANARY.as_bytes());
        let diagnostics = collect(&mut classifier, &input);

        assert_eq!(
            diagnostics,
            vec![classifier.diagnostic(StartupDiagnosticCategory::LineTooLong)]
        );
        assert!(collect(&mut classifier, b"still discarded\n").is_empty());
        assert_eq!(
            collect(&mut classifier, b"synthetic stderr\n"),
            vec![classifier.diagnostic(StartupDiagnosticCategory::UnclassifiedStderr)]
        );
        assert!(!format!("{diagnostics:?}").contains(SECRET_CANARY));
    }

    #[test]
    fn classifies_an_unterminated_line_once_at_eof_without_raw_content() {
        let mut classifier = StartupOutputClassifier::new(OutputStream::Stderr);
        let line = format!("[app-server:bootstrap] {SECRET_CANARY}");

        assert!(collect(&mut classifier, line.as_bytes()).is_empty());
        let diagnostic = classifier.finish();
        assert_eq!(
            diagnostic,
            Some(classifier.diagnostic(StartupDiagnosticCategory::AppServerReportedError))
        );
        assert_eq!(classifier.finish(), None);
        assert!(!format!("{diagnostic:?}").contains(SECRET_CANARY));
    }
}
