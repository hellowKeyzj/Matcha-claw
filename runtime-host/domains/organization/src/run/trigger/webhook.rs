use super::{TriggerFireRequest, TriggerFireRequestError, TriggerSource};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArmedWebhookTrigger {
    pub run_id: String,
    pub start_node_id: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebhookTriggerResolution {
    Fire(TriggerFireRequest),
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebhookTriggerResolutionError {
    EmptyIdempotencyKey,
    InvalidPath,
    DuplicatePath,
    InvalidTrigger(TriggerFireRequestError),
}

pub fn resolve_webhook_trigger(
    armed_triggers: impl IntoIterator<Item = ArmedWebhookTrigger>,
    webhook_path: &str,
    idempotency_key: String,
) -> Result<WebhookTriggerResolution, WebhookTriggerResolutionError> {
    let idempotency_key = idempotency_key.trim();
    if idempotency_key.is_empty() {
        return Err(WebhookTriggerResolutionError::EmptyIdempotencyKey);
    }

    let Some(webhook_path) = normalize_path(webhook_path) else {
        return Err(WebhookTriggerResolutionError::InvalidPath);
    };

    let mut matches = armed_triggers
        .into_iter()
        .filter(|trigger| normalize_path(&trigger.path).as_deref() == Some(webhook_path.as_str()));
    let Some(trigger) = matches.next() else {
        return Ok(WebhookTriggerResolution::NotFound);
    };

    if matches.next().is_some() {
        return Err(WebhookTriggerResolutionError::DuplicatePath);
    }

    let request = TriggerFireRequest::try_new(
        trigger.run_id,
        trigger.start_node_id,
        TriggerSource::Webhook,
        idempotency_key,
    )
    .map_err(WebhookTriggerResolutionError::InvalidTrigger)?;

    Ok(WebhookTriggerResolution::Fire(request))
}

fn normalize_path(value: &str) -> Option<String> {
    let path = value.trim().trim_matches('/').to_owned();
    (!path.is_empty() && !path.contains("..")).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trigger(run_id: &str, start_node_id: &str, path: &str) -> ArmedWebhookTrigger {
        ArmedWebhookTrigger {
            run_id: run_id.into(),
            start_node_id: start_node_id.into(),
            path: path.into(),
        }
    }

    #[test]
    fn resolves_normalized_unique_path_to_fire_request() {
        let result = resolve_webhook_trigger(
            [trigger("run-1", "start-1", "/release/")],
            "release",
            "request-1".into(),
        );

        assert_eq!(
            result,
            Ok(WebhookTriggerResolution::Fire(TriggerFireRequest {
                run_id: "run-1".into(),
                start_node_id: "start-1".into(),
                source: TriggerSource::Webhook,
                idempotency_key: "request-1".into(),
            }))
        );
    }

    #[test]
    fn rejects_empty_idempotency_key_before_matching() {
        let result = resolve_webhook_trigger(
            [trigger("run-1", "start-1", "release")],
            "release",
            "  ".into(),
        );

        assert_eq!(
            result,
            Err(WebhookTriggerResolutionError::EmptyIdempotencyKey)
        );
    }

    #[test]
    fn preserves_the_trimmed_idempotency_key() {
        let result = resolve_webhook_trigger(
            [trigger("run-1", "start-1", "release")],
            "release",
            " request-1 ".into(),
        );

        assert_eq!(
            result,
            Ok(WebhookTriggerResolution::Fire(TriggerFireRequest {
                run_id: "run-1".into(),
                start_node_id: "start-1".into(),
                source: TriggerSource::Webhook,
                idempotency_key: "request-1".into(),
            }))
        );
    }

    #[test]
    fn rejects_invalid_path_before_matching() {
        let result = resolve_webhook_trigger([], "/../release", "request-1".into());

        assert_eq!(result, Err(WebhookTriggerResolutionError::InvalidPath));
    }

    #[test]
    fn ignores_invalid_armed_paths_instead_of_matching_them() {
        let result = resolve_webhook_trigger(
            [trigger("run-1", "start-1", "/../release")],
            "release",
            "request-1".into(),
        );

        assert_eq!(result, Ok(WebhookTriggerResolution::NotFound));
    }

    #[test]
    fn rejects_duplicate_armed_paths() {
        let result = resolve_webhook_trigger(
            [
                trigger("run-1", "start-1", "release"),
                trigger("run-2", "start-2", "/release/"),
            ],
            "release",
            "request-1".into(),
        );

        assert_eq!(result, Err(WebhookTriggerResolutionError::DuplicatePath));
    }

    #[test]
    fn returns_not_found_for_unarmed_path() {
        let result = resolve_webhook_trigger(
            [trigger("run-1", "start-1", "release")],
            "deploy",
            "request-1".into(),
        );

        assert_eq!(result, Ok(WebhookTriggerResolution::NotFound));
    }

    #[test]
    fn rejects_armed_triggers_without_a_run_identity() {
        let result = resolve_webhook_trigger(
            [trigger(" ", "start-1", "release")],
            "release",
            "request-1".into(),
        );

        assert_eq!(
            result,
            Err(WebhookTriggerResolutionError::InvalidTrigger(
                TriggerFireRequestError::InvalidRunId
            ))
        );
    }
}
