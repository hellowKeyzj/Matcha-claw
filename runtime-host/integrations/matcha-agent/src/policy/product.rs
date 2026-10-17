use security::native_policy as public;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::{NativePolicyError, PolicyTarget, invalid_response};
use crate::{client::Delivery, driver::MatchaRuntimeDriver};

impl public::NativePolicyOps for MatchaRuntimeDriver {
    fn permissions_get<'a>(
        &'a self,
        target: public::PolicyTarget,
    ) -> security::ports::SecurityFuture<
        'a,
        Result<public::Snapshot<public::Permissions>, public::Failure>,
    > {
        Box::pin(async move {
            let native_target = self.policy_target(&target).await?;
            let snapshot = self
                .native_permissions_get(native_target)
                .await
                .map_err(failure)?;
            snapshot_view(snapshot, target, "nativePermissionPipeline")
        })
    }

    fn permissions_set<'a>(
        &'a self,
        target: public::PolicyTarget,
        patch: public::Permissions,
    ) -> security::ports::SecurityFuture<'a, Result<public::Mutation, public::Failure>> {
        Box::pin(async move {
            let native_target = self.policy_target(&target).await?;
            let receipt = self
                .native_permissions_set(native_target, json!(patch))
                .await
                .map_err(failure)?;
            mutation_view(receipt)
        })
    }

    fn hooks_get<'a>(
        &'a self,
        target: public::PolicyTarget,
    ) -> security::ports::SecurityFuture<
        'a,
        Result<public::Snapshot<public::HookCounts>, public::Failure>,
    > {
        Box::pin(async move {
            let native_target = self.policy_target(&target).await?;
            let snapshot = self
                .native_hooks_get(native_target)
                .await
                .map_err(failure)?;
            snapshot_view(snapshot, target, "nativeHookPipeline")
        })
    }

    fn hooks_set<'a>(
        &'a self,
        target: public::PolicyTarget,
        patch: public::Hooks,
    ) -> security::ports::SecurityFuture<'a, Result<public::Mutation, public::Failure>> {
        Box::pin(async move {
            let native_target = self.policy_target(&target).await?;
            let receipt = self
                .native_hooks_set(native_target, json!(patch))
                .await
                .map_err(failure)?;
            mutation_view(receipt)
        })
    }

    fn sandbox_status<'a>(
        &'a self,
        target: public::PolicyTarget,
    ) -> security::ports::SecurityFuture<
        'a,
        Result<public::Snapshot<public::Sandbox>, public::Failure>,
    > {
        Box::pin(async move {
            let native_target = self.policy_target(&target).await?;
            let snapshot = self
                .native_sandbox_status(native_target)
                .await
                .map_err(failure)?;
            snapshot_view(snapshot, target, "nativeSandbox")
        })
    }

    fn sandbox_set<'a>(
        &'a self,
        target: public::PolicyTarget,
        patch: public::SandboxPatch,
    ) -> security::ports::SecurityFuture<'a, Result<public::Mutation, public::Failure>> {
        Box::pin(async move {
            let native_target = self.policy_target(&target).await?;
            let receipt = self
                .native_sandbox_set(native_target, json!(patch))
                .await
                .map_err(failure)?;
            mutation_view(receipt)
        })
    }
}

impl MatchaRuntimeDriver {
    async fn policy_target(
        &self,
        target: &public::PolicyTarget,
    ) -> Result<PolicyTarget, public::Failure> {
        let endpoint = runtime_directory::RuntimeDriver::identity(self).endpoint();
        if !target.is_valid() || target.endpoint != endpoint {
            return Err(public::Failure::rejected());
        }
        let session_id = if let Some(identity) = &target.session_identity {
            let (agent_id, session_id) =
                crate::session::projection::parse_session_key(identity.session_key())
                    .ok_or_else(public::Failure::rejected)?;
            if agent_id != target.agent_id {
                return Err(public::Failure::rejected());
            }
            let response = self
                .native_client()
                .call("sessions.get", json!({"sessionId":session_id}))
                .await
                .map_err(|error| failure(error.into()))?;
            if response.get("agentId").and_then(Value::as_str) != Some(agent_id)
                || response.get("sessionId").and_then(Value::as_str) != Some(session_id)
            {
                return Err(failure(invalid_response(response)));
            }
            Some(session_id.into())
        } else {
            None
        };
        Ok(PolicyTarget {
            agent_id: target.agent_id.clone(),
            session_id,
        })
    }
}

fn typed<T: DeserializeOwned>(value: Value) -> Result<T, public::Failure> {
    serde_json::from_value(value.clone()).map_err(|_| failure(invalid_response(value)))
}

fn snapshot_view<T: DeserializeOwned>(
    snapshot: super::PolicySnapshot,
    target: public::PolicyTarget,
    authority: &'static str,
) -> Result<public::Snapshot<T>, public::Failure> {
    let native = snapshot
        .native
        .map(|native| {
            let session_identity = target
                .session_identity
                .clone()
                .ok_or_else(public::Failure::unknown)?;
            let sources = native
                .sources
                .into_iter()
                .map(|source| {
                    Ok(public::Source {
                        source: typed(json!(source.source))?,
                        settings: typed(source.settings)?,
                    })
                })
                .collect::<Result<Vec<_>, public::Failure>>()?;
            Ok::<_, public::Failure>(public::NativeSettings {
                status: "observedSettings",
                session_identity,
                instance_id: native.instance_id,
                effective: typed(native.effective)?,
                sources,
            })
        })
        .transpose()?;
    Ok(public::Snapshot {
        agent_id: snapshot.agent_id,
        configured: typed(snapshot.configured)?,
        configured_source: public::ConfiguredSource::ServerAgentSettings,
        projection: public::Projection::NextLaunchFlagSettings,
        authority,
        native,
        native_observation: match snapshot.native_observation {
            super::NativeObservation::NotRequested => public::NativeObservation::NotRequested,
            super::NativeObservation::NotRunning => public::NativeObservation::NotRunning,
            super::NativeObservation::Observed => public::NativeObservation::Observed,
        },
        platform: snapshot
            .platform
            .map(|platform| {
                typed(json!({"name":platform.name,
            "support":platform.support, "nativeDependencies":platform.native_dependencies}))
            })
            .transpose()?,
        isolation: snapshot
            .isolation
            .map(|isolation| typed(json!(isolation)))
            .transpose()?,
    })
}

fn mutation_view(receipt: super::PolicyMutation) -> Result<public::Mutation, public::Failure> {
    Ok(public::Mutation {
        agent_id: receipt.agent_id,
        persisted: receipt.persisted,
        projection: public::Projection::NextLaunchFlagSettings,
        live: public::LiveApplication {
            status: match receipt.live.status {
                super::LiveStatus::NotRequested => public::LiveStatus::NotRequested,
                super::LiveStatus::NotRunning => public::LiveStatus::NotRunning,
                super::LiveStatus::RestartRequired => public::LiveStatus::RestartRequired,
                super::LiveStatus::Acknowledged => public::LiveStatus::Acknowledged,
            },
            session_id: receipt.live.session_id,
            instance_id: receipt.live.instance_id,
            steps: typed(json!(receipt.live.steps))?,
        },
        restart_required: receipt.restart_required,
        restart_fields: receipt.restart_fields,
        other_sessions: public::OtherSessions::NotApplied,
    })
}

pub(super) fn restart_field(field: &str) -> bool {
    matches!(
        field,
        "sandbox"
            | "permissions.allow"
            | "permissions.deny"
            | "permissions.ask"
            | "permissions.defaultMode"
            | "permissions.disableBypassPermissionsMode"
            | "permissions.additionalDirectories"
    ) || field
        .strip_prefix("hooks.")
        .is_some_and(|event| serde_json::from_value::<public::HookEvent>(json!(event)).is_ok())
}

fn failure(error: NativePolicyError) -> public::Failure {
    use public::FailureOutcome;
    let outcome = if error.delivery() == Delivery::Unknown
        || error.persisted() == Some(true)
        || error.kind() == "policy_response_invalid"
        || error.private_data().is_some_and(|data| {
            data.get("commitState").and_then(Value::as_str) == Some("unresolved")
        }) {
        FailureOutcome::Unknown
    } else if matches!(
        error.kind(),
        "sandbox_windows_unsupported" | "sandbox_wsl1_unsupported" | "sandbox_platform_unsupported"
    ) {
        FailureOutcome::Unsupported
    } else if matches!(
        error.code(),
        Some(-32602 | -32001 | -32002 | -32005 | -32009)
    ) {
        FailureOutcome::Rejected
    } else {
        FailureOutcome::Unavailable
    };
    // Remote kind is not a public string channel. Only fixed policy errors cross it.
    let kind = match error.kind() {
        "policy_response_invalid"
        | "policy_session_agent_mismatch"
        | "policy_settings_shape"
        | "policy_native_settings_schema"
        | "permissions_rule_invalid"
        | "permissions_directory_invalid"
        | "hooks_event_unknown"
        | "hooks_event_type_unsupported"
        | "hooks_timeout_invalid"
        | "hooks_url_invalid"
        | "hooks_schema_invalid"
        | "sandbox_windows_unsupported"
        | "sandbox_wsl1_unsupported"
        | "sandbox_platform_unsupported"
        | "sandbox_platform_excluded"
        | "sandbox_silent_fallback_forbidden"
        | "sandbox_unsandboxed_exclusions"
        | "sandbox_settings_invalid"
        | "sandbox_platform_probe" => error.kind(),
        _ => "native_policy_failed",
    };
    let mut result = public::Failure::new(outcome, kind);
    result.code = error.code();
    result.persisted = error.persisted();
    result.acknowledged_steps = error
        .acknowledged_steps()
        .into_iter()
        .filter_map(|step| serde_json::from_value(json!(step)).ok())
        .collect();
    if let Some(data) = error.private_data() {
        result.projection = (data.get("projection").and_then(Value::as_str)
            == Some("nextLaunchFlagSettings"))
        .then_some(public::Projection::NextLaunchFlagSettings);
        result.restart_required = data.get("restartRequired").and_then(Value::as_bool);
        result.restart_fields = data
            .get("restartFields")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|field| restart_field(field))
            .map(str::to_owned)
            .collect();
        result.other_sessions = (data.get("otherSessions").and_then(Value::as_str)
            == Some("notApplied"))
        .then_some(public::OtherSessions::NotApplied);
    }
    result
}
