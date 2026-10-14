use std::future::Future;

use foundation::execution::OperationHandle;
use platform::{
    call::{CallContext, CallLogError, CallStatus},
    loopback::Response,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::call::{self, Detail};

#[derive(Clone)]
pub(crate) struct RecordedCall {
    pub context: CallContext<Detail>,
    pub detail: Detail,
    pub command: &'static str,
    pub accepted:
        std::sync::Arc<tokio::sync::OnceCell<Result<platform::call::CallReceipt, CallLogError>>>,
}

impl RecordedCall {
    pub async fn accepted(&self) -> Result<platform::call::CallReceipt, CallLogError> {
        self.accepted
            .get_or_init(|| self.context.accepted())
            .await
            .clone()
    }
}

pub(crate) enum Effect {
    Config(Vec<String>),
    Install {
        skill_keys: Option<Vec<String>>,
        directories: Option<Vec<String>>,
    },
    Export(Vec<String>),
    Independent,
}

impl Effect {
    pub fn install(slug: String) -> Self {
        Self::Install {
            skill_keys: Some(vec![slug.clone()]),
            directories: Some(vec![slug]),
        }
    }

    pub fn management(command: &crate::management::Command) -> Self {
        use crate::management::Command;
        match command {
            Command::Config { skill_key, .. } => Self::Config(vec![skill_key.clone()]),
            Command::ClawHubInstall { slug, .. } => Self::install(slug.clone()),
            Command::ClawHubUpdate {
                slug: Some(slug),
                all: false,
            } => Self::install(slug.trim().to_ascii_lowercase()),
            Command::ImportBundle { bundle } => Self::install(bundle.skill_key().to_owned()),
            // Native catalog lookup can remove config aliases absent from this command.
            Command::Uninstall { .. } => Self::Install {
                skill_keys: None,
                directories: None,
            },
            Command::ClawHubUpdate { .. }
            | Command::ImportMarkdown { .. }
            | Command::UploadCommit { .. } => Self::Install {
                skill_keys: Some(Vec::new()),
                directories: None,
            },
            _ => Self::Independent,
        }
    }

    pub fn bundles(command: &crate::bundle::Command) -> Self {
        match command {
            crate::bundle::Command::Export { skill_keys } => Self::Export(
                skill_keys
                    .iter()
                    .filter_map(|key| crate::bundle::normalize_skill_key_value(key))
                    .collect(),
            ),
            crate::bundle::Command::Import { bundles } => {
                let keys = bundles
                    .iter()
                    .map(|bundle| bundle.skill_key().to_owned())
                    .collect::<Vec<_>>();
                Self::Install {
                    skill_keys: Some(keys.clone()),
                    directories: Some(keys),
                }
            }
        }
    }

    fn conflicts(&self, other: &Self) -> bool {
        match (self, other) {
            // CLI lock.json RMW and bundle publication share this module's installation root.
            (Self::Install { .. }, Self::Install { .. }) => true,
            (Self::Config(left), Self::Config(right)) => overlap(left, right, false),
            (Self::Install { skill_keys, .. }, Self::Config(keys))
            | (Self::Config(keys), Self::Install { skill_keys, .. }) => skill_keys
                .as_ref()
                .is_none_or(|skill_keys| overlap(skill_keys, keys, false)),
            (Self::Install { directories, .. }, Self::Export(keys))
            | (Self::Export(keys), Self::Install { directories, .. }) => directories
                .as_ref()
                .is_none_or(|directories| overlap(directories, keys, true)),
            _ => false,
        }
    }
}

fn overlap(left: &[String], right: &[String], directory: bool) -> bool {
    left.iter().any(|left| {
        right.iter().any(|right| {
            let (left, right) = (left.trim(), right.trim());
            if directory && cfg!(windows) {
                left.eq_ignore_ascii_case(right)
            } else {
                left == right
            }
        })
    })
}

struct Pending {
    call_id: platform::call::CallId,
    task: OperationHandle<()>,
    effect: Effect,
    completion: watch::Receiver<()>,
}

#[derive(Default)]
pub(crate) struct Operations {
    closed: bool,
    pending: Vec<Pending>,
    pub results: crate::result::Results,
}

impl Operations {
    pub async fn submit<F, U>(
        &mut self,
        call: RecordedCall,
        effect: Effect,
        reservation: Option<(crate::result::ResultAccess, usize)>,
        operation: F,
    ) -> Result<(), CallLogError>
    where
        F: FnOnce(CancellationToken) -> U + Send + 'static,
        U: Future<Output = Response> + Send + 'static,
    {
        let mut index = 0;
        while index < self.pending.len() {
            if self.pending[index].task.is_finished() {
                let mut completed = self.pending.swap_remove(index);
                if completed.task.join().await.is_err() {
                    eprintln!("[skills-call] operation join failed");
                }
            } else {
                index += 1;
            }
        }
        let retained = self.results.occupied().await;
        let occupied = retained.len()
            + self
                .pending
                .iter()
                .filter(|pending| !retained.contains(&pending.call_id))
                .count();
        if self.closed || occupied >= 16 {
            return Err(if self.closed {
                CallLogError::Unavailable
            } else {
                CallLogError::QueueFull
            });
        }
        if let Some((access, budget)) = reservation {
            self.results
                .reserve(call.context.id().clone(), call.command, access, budget)
                .await?;
        }
        let results = self.results.clone();
        let predecessors = self
            .pending
            .iter()
            .filter(|pending| effect.conflicts(&pending.effect))
            .map(|pending| pending.completion.clone())
            .collect::<Vec<_>>();
        let (completed, completion) = watch::channel(());
        let context = call.context.clone();
        let call_id = context.id().clone();
        let (task, _) = OperationHandle::spawn(move |cancellation| async move {
            // Dropping the sole sender also releases dependants if this task unwinds.
            let _completed = completed;
            if let Err(error) = call.accepted().await {
                eprintln!("[skills-call] accepted transition failed: {error}");
                results.remove(context.id()).await;
                let _ = context.finish(CallStatus::Rejected, &call.detail).await;
                for mut predecessor in predecessors {
                    let _ = predecessor.changed().await;
                }
                return;
            }
            for mut predecessor in predecessors {
                let _ = predecessor.changed().await;
            }
            // Native ports own their effects: drain them to a terminal result on shutdown.
            if let Err(error) = context.running().await {
                eprintln!("[skills-call] running transition failed: {error}");
                results.remove(context.id()).await;
                let _ = context.finish(CallStatus::Failed, &call.detail).await;
            } else {
                let started = (platform::trace::enabled()
                    && matches!(
                        call.command,
                        "skills.import.markdown"
                            | "skills.import.bundle"
                            | "skills.importBundles"
                            | "skills.bundles.import"
                    ))
                .then(std::time::Instant::now);
                if started.is_some() {
                    eprintln!(
                        "[startup-trace] source=skills-import phase=running callIdHigh={} callIdLow={} command={}",
                        &context.id().as_str()[..16],
                        &context.id().as_str()[16..],
                        call.command
                    );
                }
                let response = operation(cancellation).await;
                let (status, detail) = call::terminal(call.detail, &response);
                if let Some(started) = started {
                    eprintln!(
                        "[startup-trace] source=skills-import phase=terminal callIdHigh={} callIdLow={} command={} status={} httpStatus={} elapsedMs={}",
                        &context.id().as_str()[..16],
                        &context.id().as_str()[16..],
                        call.command,
                        status.as_str(),
                        response.status(),
                        started.elapsed().as_millis()
                    );
                }
                if let Err(error) = context.finish(status, &detail).await {
                    eprintln!("[skills-call] terminal transition failed: {error}");
                }
            }
        });
        self.pending.push(Pending {
            call_id,
            task,
            effect,
            completion,
        });
        Ok(())
    }

    pub async fn stop(&mut self) {
        self.closed = true;
        for operation in &self.pending {
            operation.task.cancel();
        }
        for mut operation in self.pending.drain(..) {
            if operation.task.join().await.is_err() {
                eprintln!("[skills-call] shutdown join failed");
            }
        }
        self.results.clear().await;
    }
}
