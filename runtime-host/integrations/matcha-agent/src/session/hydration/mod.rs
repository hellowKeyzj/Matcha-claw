mod decode;
mod model;

use std::collections::VecDeque;

use crate::session::{
    client::{AppServerClient, AppServerClientError},
    facts::NativeSessionFacts,
    model::{SessionId, SessionRecord},
    protocol_event::ReplayLimit,
    request::{SessionSnapshotParams, SessionTranscriptParams},
};

pub use model::{
    HydratedContentBlock, HydratedImage, HydratedMessage, HydratedMessageRole,
    HydratedToolMetadata, HydratedToolResult, HydratedToolUse, HydrationIncomplete,
    HydrationResult, HydrationSnapshot, HydrationWindow, HydrationWindowMode,
    HydrationWindowRequest,
};

const REPLAY_LIMIT: f64 = 10_000.0;

pub(crate) async fn hydrate_connected_for_history(
    client: &AppServerClient,
    session: SessionRecord,
    request: HydrationWindowRequest,
) -> HydrationResult {
    let session_id = session.session_id.clone();
    match hydrate_loaded(client, session, session_id, request).await {
        Ok(facts) => HydrationResult::Complete(facts.transcript().clone()),
        Err(reason) => HydrationResult::Incomplete(reason),
    }
}

pub(crate) async fn hydrate_connected_for_canonical(
    client: &AppServerClient,
    session: SessionRecord,
    request: HydrationWindowRequest,
) -> Result<NativeSessionFacts, HydrationIncomplete> {
    let session_id = session.session_id.clone();
    hydrate_loaded(client, session, session_id, request).await
}

pub(crate) fn hydrate_lines(
    lines: &[String],
    request: HydrationWindowRequest,
) -> Result<HydrationSnapshot, HydrationIncomplete> {
    let (messages, window) = decode_transcript_window(lines, request)
        .map_err(|_| HydrationIncomplete::TranscriptRejected)?;
    Ok(HydrationSnapshot::new(messages, window))
}

async fn hydrate_loaded(
    client: &AppServerClient,
    session: SessionRecord,
    session_id: SessionId,
    request: HydrationWindowRequest,
) -> Result<NativeSessionFacts, HydrationIncomplete> {
    let transcript = match client
        .transcript_session(SessionTranscriptParams::new(session_id.clone()))
        .await
    {
        Ok(transcript) => transcript,
        Err(error) => return Err(client_failure(error)),
    };
    let snapshot = match client
        .snapshot_session(SessionSnapshotParams::new(session_id.clone()))
        .await
    {
        Ok(snapshot) if snapshot.session.session_id == session_id => snapshot,
        Ok(_) => return Err(HydrationIncomplete::ProtocolRejected),
        Err(error) => return Err(client_failure(error)),
    };
    let replay_limit = ReplayLimit::try_new(REPLAY_LIMIT).expect("replay limit is finite");
    let replay = match client
        .replay_event_payload(session_id, None, Some(replay_limit))
        .await
    {
        Ok(replay)
            if replay.cursor() == snapshot.session.last_seq
                && (replay.event_count() > 0 || snapshot.session.last_seq.get() == 0) =>
        {
            replay
        }
        Ok(_) => return Err(HydrationIncomplete::ReplayIncomplete),
        Err(error) => return Err(client_failure(error)),
    };

    let (messages, window) = match decode_transcript_window(&transcript.lines, request) {
        Ok(window) => window,
        Err(_) => return Err(HydrationIncomplete::TranscriptRejected),
    };
    let transcript = HydrationSnapshot::new(messages, window);
    let facts = NativeSessionFacts::from_native(session, snapshot, transcript.clone(), replay)
        .map_err(|_| HydrationIncomplete::ProtocolRejected)?;
    Ok(facts)
}

#[cfg(test)]
fn close_outcome(
    hydration: HydrationResult,
    close: Result<(), AppServerClientError>,
) -> HydrationResult {
    match close {
        Ok(()) => hydration,
        Err(_) => HydrationResult::Incomplete(HydrationIncomplete::ConnectionCloseFailed),
    }
}

fn client_failure(error: AppServerClientError) -> HydrationIncomplete {
    match error {
        AppServerClientError::EventRecoveryRequired => HydrationIncomplete::ReplayRecoveryRequired,
        AppServerClientError::ConnectionClosed => HydrationIncomplete::ConnectionInterrupted,
        AppServerClientError::PeerRejected => HydrationIncomplete::SourceRejected,
        AppServerClientError::SessionNotFound => HydrationIncomplete::SourceRejected,
        AppServerClientError::HealthDeadline
        | AppServerClientError::RequestDeadline
        | AppServerClientError::UnknownResponse
        | AppServerClientError::Transport => HydrationIncomplete::SourceUnavailable,
        AppServerClientError::CloseFailed => HydrationIncomplete::ConnectionCloseFailed,
        AppServerClientError::InvalidEndpoint
        | AppServerClientError::HealthFailed
        | AppServerClientError::UpgradeDeadline
        | AppServerClientError::UpgradeFailed
        | AppServerClientError::InitializeFailed
        | AppServerClientError::Protocol => HydrationIncomplete::ProtocolRejected,
    }
}

const MAX_TRANSCRIPT_LINES: usize = 10_000;

type DecodedTranscriptWindow =
    Result<(Vec<model::HydratedMessage>, HydrationWindow), model::DecodeFailure>;

fn decode_transcript_window(
    lines: &[String],
    request: HydrationWindowRequest,
) -> DecodedTranscriptWindow {
    if lines.len() > MAX_TRANSCRIPT_LINES {
        return Err(model::DecodeFailure::TranscriptTooLarge);
    }

    let mut decoded_count = 0;
    let mut latest_messages = VecDeque::with_capacity(request.limit());
    let mut selected_messages = Vec::with_capacity(request.limit().saturating_mul(2));
    let range = match (request.mode(), request.offset()) {
        (HydrationWindowMode::Latest, _) | (HydrationWindowMode::Older, None) => None,
        (HydrationWindowMode::Older, Some(anchor)) => Some((
            anchor.saturating_sub(request.limit()),
            anchor.saturating_add(request.limit()),
        )),
        (HydrationWindowMode::Newer, Some(start)) => {
            Some((start, start.saturating_add(request.limit())))
        }
        (HydrationWindowMode::Newer, None) => Some((usize::MAX, usize::MAX)),
    };
    let retain_latest = matches!(
        request.mode(),
        HydrationWindowMode::Latest | HydrationWindowMode::Older
    );

    for line in lines {
        let Some(message) = decode::decode_transcript_line(line)? else {
            continue;
        };
        let message = message.with_source_index(decoded_count);
        if retain_latest && request.limit() > 0 {
            latest_messages.push_back(message.clone());
            if latest_messages.len() > request.limit() {
                latest_messages.pop_front();
            }
        }
        if let Some((start, end)) = range
            && decoded_count >= start
            && decoded_count < end
        {
            selected_messages.push(message);
        }
        decoded_count = decoded_count.saturating_add(1);
    }

    let (start, end) = window_bounds(decoded_count, request);
    let messages = if matches!(request.mode(), HydrationWindowMode::Latest)
        || matches!(request.mode(), HydrationWindowMode::Older)
            && request
                .offset()
                .is_none_or(|offset| offset >= decoded_count)
    {
        latest_messages.into_iter().collect()
    } else {
        selected_messages
    };
    Ok((messages, HydrationWindow::new(decoded_count, start, end)))
}

fn window_bounds(total: usize, request: HydrationWindowRequest) -> (usize, usize) {
    let limit = request.limit();
    match request.mode() {
        HydrationWindowMode::Latest => (total.saturating_sub(limit), total),
        HydrationWindowMode::Older => {
            let anchor = request.offset().unwrap_or(total).min(total);
            (
                anchor.saturating_sub(limit),
                anchor.saturating_add(limit).min(total),
            )
        }
        HydrationWindowMode::Newer => {
            let start = request.offset().unwrap_or(total).min(total);
            (start, start.saturating_add(limit).min(total))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_matches_legacy_paging_bounds_without_retaining_full_transcript() {
        assert_eq!(
            window_bounds(300, HydrationWindowRequest::latest()),
            (220, 300)
        );
        assert_eq!(
            window_bounds(
                300,
                HydrationWindowRequest::new(HydrationWindowMode::Older, 80, Some(160)),
            ),
            (80, 240)
        );
        assert_eq!(
            window_bounds(
                300,
                HydrationWindowRequest::new(HydrationWindowMode::Newer, 80, Some(160)),
            ),
            (160, 240)
        );
        assert_eq!(
            HydrationWindowRequest::new(HydrationWindowMode::Latest, 999, None).limit(),
            HydrationWindowRequest::MAX_LIMIT
        );
    }

    #[test]
    fn decode_retains_only_the_requested_latest_window() {
        let lines = (0..300)
            .map(|index| format!(r#"{{"message":{{"role":"user","content":"message-{index}"}}}}"#))
            .collect::<Vec<_>>();
        let (messages, window) = decode_transcript_window(&lines, HydrationWindowRequest::latest())
            .expect("bounded transcript window should decode");

        assert_eq!(messages.len(), HydrationWindowRequest::DEFAULT_LIMIT);
        assert_eq!(messages[0].text(), "message-220");
        assert_eq!(messages[79].text(), "message-299");
        assert_eq!(window.total_item_count(), 300);
        assert_eq!(window.window_start_offset(), 220);
        assert_eq!(window.window_end_offset(), 300);
    }

    #[test]
    fn decode_applies_older_and_newer_offsets_without_crosswalk() {
        let lines = (0..300)
            .map(|index| format!(r#"{{"message":{{"role":"user","content":"message-{index}"}}}}"#))
            .collect::<Vec<_>>();

        let (older, _) = decode_transcript_window(
            &lines,
            HydrationWindowRequest::new(HydrationWindowMode::Older, 80, Some(160)),
        )
        .expect("older window should decode");
        assert_eq!(
            older.first().map(HydratedMessage::text),
            Some("message-80".into())
        );
        assert_eq!(
            older.last().map(HydratedMessage::text),
            Some("message-239".into())
        );

        let (newer, _) = decode_transcript_window(
            &lines,
            HydrationWindowRequest::new(HydrationWindowMode::Newer, 80, Some(160)),
        )
        .expect("newer window should decode");
        assert_eq!(
            newer.first().map(HydratedMessage::text),
            Some("message-160".into())
        );
        assert_eq!(
            newer.last().map(HydratedMessage::text),
            Some("message-239".into())
        );
    }

    #[test]
    fn decode_rejects_transcript_beyond_native_cap() {
        let lines = vec![String::from(r#"{"message":{"role":"user","content":"x"}}"#); 10_001];
        assert_eq!(
            decode_transcript_window(&lines, HydrationWindowRequest::latest()),
            Err(model::DecodeFailure::TranscriptTooLarge)
        );
    }

    #[test]
    fn window_reports_renderer_paging_flags() {
        let window = HydrationWindow::new(300, 80, 240);
        assert_eq!(window.total_item_count(), 300);
        assert!(window.has_more());
        assert!(window.has_newer());
        assert!(!window.is_at_latest());
    }

    #[test]
    fn close_failure_overrides_a_provisional_complete_snapshot() {
        let snapshot = HydrationSnapshot::new(
            vec![HydratedMessage::try_new(HydratedMessageRole::User, "visible".into()).unwrap()],
            HydrationWindow::new(1, 0, 1),
        );
        assert_eq!(
            close_outcome(
                HydrationResult::Complete(snapshot),
                Err(AppServerClientError::CloseFailed),
            ),
            HydrationResult::Incomplete(HydrationIncomplete::ConnectionCloseFailed)
        );
    }

    #[test]
    fn recovery_and_interruption_are_typed_incomplete_outcomes() {
        assert_eq!(
            client_failure(AppServerClientError::EventRecoveryRequired),
            HydrationIncomplete::ReplayRecoveryRequired
        );
        assert_eq!(
            client_failure(AppServerClientError::ConnectionClosed),
            HydrationIncomplete::ConnectionInterrupted
        );
    }

    #[test]
    fn debug_redacts_message_text() {
        let message = HydratedMessage::try_new(
            HydratedMessageRole::Assistant,
            "secret-canary cwd-canary path-canary".into(),
        )
        .unwrap();
        let rendered = format!("{message:?}");
        for canary in ["secret-canary", "cwd-canary", "path-canary"] {
            assert!(!rendered.contains(canary));
        }
    }
}
