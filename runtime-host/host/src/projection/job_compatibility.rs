use serde::Serialize;

pub(crate) const OPENCLAW_TOOLCHAIN_JOB_ID_PREFIX: &str = "runtime-host:openclaw:toolchain:";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RuntimeJobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeJobProgress {
    pub(crate) updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeJobSnapshot {
    pub(crate) id: String,
    #[serde(rename = "type")]
    pub(crate) job_type: String,
    pub(crate) status: RuntimeJobStatus,
    pub(crate) queued_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) finished_at: Option<u64>,
    pub(crate) attempts: u32,
    pub(crate) max_attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) progress: Option<RuntimeJobProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum JobCompatibilityLookupOutcome {
    Known,
    NotFound,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct JobCompatibilityLookup {
    pub(crate) job: Option<RuntimeJobSnapshot>,
    pub(crate) outcome: JobCompatibilityLookupOutcome,
}

impl JobCompatibilityLookup {
    pub(crate) const fn known(job: RuntimeJobSnapshot) -> Self {
        Self {
            job: Some(job),
            outcome: JobCompatibilityLookupOutcome::Known,
        }
    }

    pub(crate) const fn not_found() -> Self {
        Self {
            job: None,
            outcome: JobCompatibilityLookupOutcome::NotFound,
        }
    }

    pub(crate) const fn unknown() -> Self {
        Self {
            job: None,
            outcome: JobCompatibilityLookupOutcome::Unknown,
        }
    }
}

pub(crate) enum JobCompatibilityOwnerRoute<'a> {
    OpenClawToolchain { job_id: &'a str },
    Unknown,
}

pub(crate) fn route_job_id(job_id: &str) -> JobCompatibilityOwnerRoute<'_> {
    if job_id.starts_with(OPENCLAW_TOOLCHAIN_JOB_ID_PREFIX) {
        JobCompatibilityOwnerRoute::OpenClawToolchain { job_id }
    } else {
        JobCompatibilityOwnerRoute::Unknown
    }
}

pub(crate) fn openclaw_toolchain_lookup(
    lookup: openclaw::toolchain::ToolchainJobLookup,
) -> JobCompatibilityLookup {
    match lookup {
        openclaw::toolchain::ToolchainJobLookup::Known(job) => {
            JobCompatibilityLookup::known(openclaw_toolchain_snapshot(job))
        }
        openclaw::toolchain::ToolchainJobLookup::Unknown => JobCompatibilityLookup::not_found(),
    }
}

pub(crate) fn openclaw_toolchain_snapshot(
    job: openclaw::toolchain::ToolchainJobSnapshot,
) -> RuntimeJobSnapshot {
    RuntimeJobSnapshot {
        id: job.id,
        job_type: job.job_type,
        status: match job.status {
            openclaw::toolchain::ToolchainJobStatus::Queued => RuntimeJobStatus::Queued,
            openclaw::toolchain::ToolchainJobStatus::Running => RuntimeJobStatus::Running,
            openclaw::toolchain::ToolchainJobStatus::Succeeded => RuntimeJobStatus::Succeeded,
            openclaw::toolchain::ToolchainJobStatus::Failed => RuntimeJobStatus::Failed,
        },
        queued_at: job.queued_at,
        started_at: job.started_at,
        finished_at: job.finished_at,
        attempts: job.attempts,
        max_attempts: job.max_attempts,
        progress: job.progress.map(|progress| RuntimeJobProgress {
            updated_at: progress.updated_at,
            percent: progress.percent,
            message: progress.message,
        }),
        result: job
            .result
            .and_then(|result| serde_json::to_value(result).ok()),
        error: job.error,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn toolchain_job(
        status: openclaw::toolchain::ToolchainJobStatus,
    ) -> openclaw::toolchain::ToolchainJobSnapshot {
        openclaw::toolchain::ToolchainJobSnapshot {
            id: "runtime-host:openclaw:toolchain:1".to_owned(),
            job_type: "toolchain.uvInstall".to_owned(),
            status,
            queued_at: 10,
            started_at: Some(20),
            finished_at: None,
            attempts: 1,
            max_attempts: 1,
            progress: Some(openclaw::toolchain::ToolchainJobProgress {
                updated_at: 30,
                percent: Some(50),
                message: Some("Installing uv".to_owned()),
            }),
            result: Some(openclaw::toolchain::ToolchainJobResult::Installed),
            error: None,
        }
    }

    #[test]
    fn routes_openclaw_toolchain_jobs_by_compatibility_prefix() {
        assert!(matches!(
            route_job_id("runtime-host:openclaw:toolchain:1"),
            JobCompatibilityOwnerRoute::OpenClawToolchain { job_id }
                if job_id == "runtime-host:openclaw:toolchain:1"
        ));
        assert!(matches!(
            route_job_id("runtime-host:matcha:session:1"),
            JobCompatibilityOwnerRoute::Unknown
        ));
    }

    #[test]
    fn unknown_owner_stays_unknown_without_inventing_terminal_state() {
        assert_eq!(
            JobCompatibilityLookup::unknown(),
            JobCompatibilityLookup {
                job: None,
                outcome: JobCompatibilityLookupOutcome::Unknown,
            }
        );
    }

    #[test]
    fn owner_not_found_is_distinct_from_unknown_route() {
        assert_eq!(
            openclaw_toolchain_lookup(openclaw::toolchain::ToolchainJobLookup::Unknown),
            JobCompatibilityLookup::not_found()
        );
    }

    #[test]
    fn known_jobs_project_to_stable_runtime_job_snapshot_shape() {
        let lookup = openclaw_toolchain_lookup(openclaw::toolchain::ToolchainJobLookup::Known(
            toolchain_job(openclaw::toolchain::ToolchainJobStatus::Running),
        ));

        assert_eq!(lookup.outcome, JobCompatibilityLookupOutcome::Known);
        assert_eq!(
            serde_json::to_value(lookup.job.unwrap()).unwrap(),
            json!({
                "id": "runtime-host:openclaw:toolchain:1",
                "type": "toolchain.uvInstall",
                "status": "running",
                "queuedAt": 10,
                "startedAt": 20,
                "attempts": 1,
                "maxAttempts": 1,
                "progress": {
                    "updatedAt": 30,
                    "percent": 50,
                    "message": "Installing uv"
                },
                "result": "installed"
            })
        );
    }
}
