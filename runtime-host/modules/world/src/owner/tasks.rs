use std::{collections::{BTreeMap, BTreeSet}, future::Future, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};

use foundation::execution::OwnedTask;
use tokio::{sync::oneshot, time::Instant};
use tokio_util::sync::CancellationToken;
use world_protocol::{failure::FailureStage, ids::*};

use super::{Error, ExecutionContext};

struct Work {
    world: WorldRef,
    run: RunId,
    admission: crate::authorization::Admission,
    cancel: CancellationToken,
    budget: crate::extensions::invocation::CallBudget,
    investigation: Mutex<Option<Arc<crate::authorization::InvestigationBinding>>>,
}
struct Task {
    work: Option<Work>,
    transfer: Option<crate::store::TransferCut>,
    investigation: Mutex<Option<crate::authorization::InvestigationWork>>,
    joined: AtomicBool,
    task: tokio::sync::Mutex<Option<OwnedTask<()>>>,
}
impl Task {
    fn finished(&self) -> bool {
        self.task.try_lock().is_ok_and(|task| task.as_ref().is_none_or(OwnedTask::is_finished))
    }

    fn retained(&self) -> bool {
        self.investigation.lock().expect("investigation work poisoned").as_ref().is_some_and(|work| !work.is_joined())
            || self.pending()
    }

    fn pending(&self) -> bool {
        self.work.as_ref().is_some_and(|work| work.budget.has_pending_reservations()
            || work.investigation.lock().expect("investigation custody poisoned").as_ref().is_some_and(|binding| !binding.released()))
    }

    async fn join(&self) -> Result<(), tokio::task::JoinError> {
        let mut task = self.task.lock().await;
        let result = match task.as_mut() {
            Some(task) => {
                let result = task.join().await;
                if result.is_ok() { self.joined.store(true, Ordering::Release); }
                result
            },
            None => Ok(()),
        };
        task.take();
        if self.joined.load(Ordering::Acquire) && !self.pending() {
            if let Some(work) = self.investigation.lock().expect("investigation work poisoned").as_mut() { work.joined(); }
        }
        result
    }
}
enum Closing {
    Accepted(crate::extensions::lifecycle::AcceptedClosing),
    Transfer(crate::extensions::lifecycle::AcceptedTransferSelection),
}
impl Closing {
    fn valid(&self, live: &crate::extensions::lifecycle::LiveExtensions) -> bool {
        match self {
            Self::Accepted(proof) => live.validate_accepted_closing(proof),
            Self::Transfer(proof) => live.validate_accepted_transfer(proof),
        }
    }
}
#[derive(Default)]
pub(crate) struct Tasks {
    tasks: Mutex<Vec<Arc<Task>>>,
    closing: Mutex<BTreeMap<(WorldRef, RunId), (Arc<crate::extensions::lifecycle::LiveExtensions>, Closing)>>,
}

impl Tasks {
    /// The receiver observes work; dropping it does not cancel the owned task.
    pub(crate) fn spawn<T: Send + 'static>(&self, future: impl Future<Output = T> + Send + 'static) -> oneshot::Receiver<T> {
        self.spawn_owned(None, None, future)
    }

    pub(crate) fn spawn_investigation<T: Send + 'static>(
        &self, admission: &crate::authorization::Admission, future: impl Future<Output = T> + Send + 'static,
    ) -> Result<oneshot::Receiver<T>, Error> {
        let work = admission.investigation_work()?;
        Ok(self.spawn_owned(None, work, future))
    }

    pub(crate) fn spawn_run<T: Send + 'static>(&self, ctx: &ExecutionContext, future: impl Future<Output = T> + Send + 'static) -> Result<oneshot::Receiver<T>, Error> {
        let mut tasks = self.tasks.lock().expect("world tasks poisoned");
        if self.closing.lock().expect("world task admission poisoned").contains_key(&(ctx.operation.world.clone(), ctx.run.id.clone())) {
            ctx.cancellation.cancel();
            return Err(Error::from_host_failure(world_protocol::process::HostFailure::Cancelled, FailureStage::Drain));
        }
        let investigation = ctx.admission.investigation_work()?;
        let work = Work { world: ctx.operation.world.clone(), run: ctx.run.id.clone(), admission: ctx.admission.clone(),
            cancel: ctx.cancellation.clone(), budget: ctx.budget.clone(), investigation: Mutex::new(None) };
        let cancellation = ctx.cancellation.clone();
        let pipeline = ctx.pipeline.clone();
        let (reply, receiver) = oneshot::channel();
        let (task, _) = OwnedTask::spawn(move |_| async move {
            tokio::pin!(future);
            let result = tokio::select! {
                biased;
                _ = cancellation.cancelled() => {
                    pipeline.cancel();
                    future.await
                }
                result = &mut future => result,
            };
            let _ = reply.send(result);
        });
        tasks.push(Arc::new(Task { work: Some(work), transfer: None, investigation: Mutex::new(investigation), joined: AtomicBool::new(false), task: tokio::sync::Mutex::new(Some(task)) }));
        Ok(receiver)
    }

    pub(crate) fn retain_investigation(
        &self, ctx: &ExecutionContext, binding: crate::authorization::InvestigationBinding,
    ) -> Result<Arc<crate::authorization::InvestigationBinding>, Error> {
        if binding.world() != &ctx.operation.world || binding.run_id() != &ctx.run.id {
            return Err(Error::internal(FailureStage::Admission));
        }
        let tasks = self.tasks.lock().expect("world tasks poisoned");
        let work = tasks.iter().filter_map(|task| task.work.as_ref()).find(|work| work.world == ctx.operation.world
            && work.run == ctx.run.id && work.admission.invocation() == ctx.admission.invocation()
            && work.admission.decision() == ctx.admission.decision()).ok_or_else(|| Error::internal(FailureStage::Commit))?;
        let mut held = work.investigation.lock().expect("investigation custody poisoned");
        if held.as_ref().is_some_and(|binding| !binding.released()) { return Err(investigation_retained()); }
        let binding = Arc::new(binding);
        *held = Some(binding.clone());
        Ok(binding)
    }

    pub(crate) fn investigation_binding(&self, world: &WorldRef, run: &RunId) -> Option<Arc<crate::authorization::InvestigationBinding>> {
        let tasks = self.tasks.lock().expect("world tasks poisoned");
        tasks.iter().rev().filter_map(|task| task.work.as_ref()).filter(|work| &work.world == world && &work.run == run)
            .find_map(|work| work.investigation.lock().expect("investigation custody poisoned").as_ref()
                .filter(|binding| !binding.released()).cloned())
    }

    pub(crate) fn settled_investigation(&self, world: &WorldRef, run: &RunId) -> Option<Arc<crate::authorization::InvestigationBinding>> {
        let tasks = self.tasks.lock().expect("world tasks poisoned");
        let mut found = None;
        for work in tasks.iter().filter_map(|task| task.work.as_ref()).filter(|work| &work.world == world && &work.run == run) {
            let held = work.investigation.lock().expect("investigation custody poisoned");
            if let Some(binding) = held.as_ref() {
                if !binding.released() || found.as_ref().is_some_and(|previous| !Arc::ptr_eq(previous, binding)) { return None; }
                found = Some(binding.clone());
            }
        }
        found
    }

    pub(crate) fn investigation_for_binding(&self, world: &WorldRef, id: &BindingId) -> Option<Arc<crate::authorization::InvestigationBinding>> {
        let tasks = self.tasks.lock().expect("world tasks poisoned");
        let mut found = None;
        for work in tasks.iter().filter_map(|task| task.work.as_ref()).filter(|work| &work.world == world) {
            let held = work.investigation.lock().expect("investigation custody poisoned");
            if let Some(binding) = held.as_ref().filter(|binding| &binding.identity().binding_id == id && !binding.released()) {
                if found.is_some() { return None; }
                found = Some(binding.clone());
            }
        }
        found
    }

    pub(crate) fn spawn_transfer<T: Send + 'static>(
        &self, cut: crate::store::TransferCut, future: impl Future<Output = T> + Send + 'static,
    ) -> Result<oneshot::Receiver<T>, Error> {
        let mut tasks = self.tasks.lock().expect("world tasks poisoned");
        if tasks.iter().any(|task| !task.finished() && task.transfer.as_ref().is_some_and(|held| held.world == cut.world)) {
            return Err(Error::from(crate::store::StoreError::new(
                world_protocol::commit::CommitFailure::TransferIndeterminate { transfer_id: cut.transfer_id.clone() }, FailureStage::Migrate,
            )));
        }
        let (reply, receiver) = oneshot::channel();
        let (task, _) = OwnedTask::spawn(move |_| async move { let _ = reply.send(future.await); });
        tasks.push(Arc::new(Task { work: None, transfer: Some(cut), investigation: Mutex::new(None), joined: AtomicBool::new(false), task: tokio::sync::Mutex::new(Some(task)) }));
        Ok(receiver)
    }

    pub(crate) fn seal_runs(&self, runs: &[RunId], live: Arc<crate::extensions::lifecycle::LiveExtensions>, closing: &crate::extensions::lifecycle::AcceptedClosing) {
        let _tasks = self.tasks.lock().expect("world tasks poisoned");
        let mut sealed = self.closing.lock().expect("world task admission poisoned");
        for run in runs { sealed.insert((closing.world().clone(), run.clone()), (live.clone(), Closing::Accepted(closing.clone()))); }
    }

    pub(crate) fn seal_transfer_runs(
        &self, runs: &[RunId], live: Arc<crate::extensions::lifecycle::LiveExtensions>, closing: &crate::extensions::lifecycle::AcceptedTransferSelection,
    ) {
        let _tasks = self.tasks.lock().expect("world tasks poisoned");
        let mut sealed = self.closing.lock().expect("world task admission poisoned");
        for run in runs { sealed.insert((closing.world().clone(), run.clone()), (live.clone(), Closing::Transfer(closing.clone()))); }
    }

    /// Only the freshly admitted Resume path may reopen an old run after its closing fence ends.
    pub(crate) fn resume_run(&self, world: &WorldRef, run: &RunId) -> Result<(), Error> {
        let _tasks = self.tasks.lock().expect("world tasks poisoned");
        let mut sealed = self.closing.lock().expect("world task admission poisoned");
        let key = (world.clone(), run.clone());
        if sealed.get(&key).is_some_and(|(live, closing)| closing.valid(live)) {
            return Err(Error::from_host_failure(world_protocol::process::HostFailure::Cancelled, FailureStage::Drain));
        }
        sealed.remove(&key);
        Ok(())
    }

    fn spawn_owned<T: Send + 'static>(
        &self, work: Option<Work>, investigation: Option<crate::authorization::InvestigationWork>,
        future: impl Future<Output = T> + Send + 'static,
    ) -> oneshot::Receiver<T> {
        let (reply, receiver) = oneshot::channel();
        let mut tasks = self.tasks.lock().expect("world tasks poisoned");
        let (task, _) = OwnedTask::spawn(move |_| async move { let _ = reply.send(future.await); });
        tasks.push(Arc::new(Task { work, transfer: None, investigation: Mutex::new(investigation), joined: AtomicBool::new(false), task: tokio::sync::Mutex::new(Some(task)) }));
        receiver
    }

    pub(crate) fn usage(&self, world: &WorldRef, run: &RunId) -> Option<world_protocol::budget::Usage> {
        self.tasks.lock().expect("world tasks poisoned").iter().rev().filter_map(|task| task.work.as_ref())
            .find(|work| &work.world == world && &work.run == run).map(|work| work.budget.checkpoint_usage())
    }

    pub(crate) fn contains_run(&self, world: &WorldRef, run: &RunId) -> bool {
        self.tasks.lock().expect("world tasks poisoned").iter().any(|task| (!task.finished() || task.retained())
            && task.work.as_ref().is_some_and(|work| &work.world == world && &work.run == run))
    }

    pub(crate) async fn join_investigation_child_work(&self, world: &WorldRef, binding: &BindingId, deadline: Instant) -> Result<(), Error> {
        loop {
            let tasks: Vec<_> = self.tasks.lock().expect("world tasks poisoned").iter().filter(|task| {
                task.investigation.lock().expect("investigation work poisoned").as_ref()
                    .is_some_and(|work| work.world() == world && work.binding_id() == binding)
            }).cloned().collect();
            if tasks.is_empty() { return Ok(()); }
            for task in tasks {
                match tokio::time::timeout_at(deadline, task.join()).await {
                    Ok(Ok(())) => {},
                    Ok(Err(cause)) => return Err(investigation_retained().caused(cause)),
                    Err(_) => return Err(investigation_retained()),
                }
                let mut custody = self.tasks.lock().expect("world tasks poisoned");
                if task.retained() { return Err(investigation_retained()); }
                custody.retain(|held| !Arc::ptr_eq(held, &task));
            }
        }
    }

    /// Called only after the exact accepted run set has a confirmed durable checkpoint.
    pub(crate) async fn cancel_join_runs(&self, world: &WorldRef, runs: &[RunId], deadline: Instant) -> Result<(), Error> {
        self.join_runs(world, Some(runs.iter().cloned().collect()), true, deadline).await
    }

    /// Terminal receipts can precede physical cleanup; join those tasks without cancelling cleanup.
    pub(crate) async fn join_world_runs(&self, world: &WorldRef, deadline: Instant) -> Result<(), Error> {
        self.join_runs(world, None, false, deadline).await
    }

    async fn join_runs(&self, world: &WorldRef, selected: Option<BTreeSet<RunId>>, cancel: bool, deadline: Instant) -> Result<(), Error> {
        loop {
            let tasks: Vec<_> = self.tasks.lock().expect("world tasks poisoned").iter()
                .filter(|task| task.work.as_ref().is_some_and(|work| &work.world == world && selected.as_ref().is_none_or(|runs| runs.contains(&work.run)))
                    || selected.is_none() && task.investigation.lock().expect("investigation work poisoned").as_ref().is_some_and(|work| work.world() == world))
                .cloned().collect();
            if tasks.is_empty() { return Ok(()); }
            let mut retained = false;
            let mut failure: Option<Error> = None;
            for task in tasks {
                if cancel { if let Some(work) = &task.work { work.cancel.cancel(); } }
                match tokio::time::timeout_at(deadline, task.join()).await {
                    Ok(Ok(())) => {},
                    Ok(Err(cause)) => {
                        let error = Error::internal(FailureStage::Drain).caused(cause);
                        failure = Some(match failure { Some(previous) => previous.with_related(error), None => error });
                    },
                    Err(_) => { retained = true; continue; },
                }
                let mut custody = self.tasks.lock().expect("world tasks poisoned");
                if task.retained() { retained = true; }
                else { custody.retain(|held| !Arc::ptr_eq(held, &task)); }
            }
            if retained {
                let error = investigation_retained();
                return Err(match failure { Some(failure) => error.with_related(failure), None => error });
            }
            if let Some(error) = failure { return Err(error); }
        }
    }

    pub(crate) async fn checked_join(&self, deadline: Instant, diagnostics: &mut Vec<Error>) -> bool {
        loop {
            let tasks = self.tasks.lock().expect("world tasks poisoned").clone();
            if tasks.is_empty() { return true; }
            let mut retained = false;
            for task in tasks {
                match tokio::time::timeout_at(deadline, task.join()).await {
                    Ok(Ok(())) => {},
                    Ok(Err(cause)) => diagnostics.push(Error::internal(FailureStage::Stop).caused(cause)),
                    Err(_) => { retained = true; continue; },
                }
                let mut custody = self.tasks.lock().expect("world tasks poisoned");
                if task.retained() { retained = true; }
                else { custody.retain(|held| !Arc::ptr_eq(held, &task)); }
            }
            if retained { return false; }
        }
    }
}

fn investigation_retained() -> Error {
    Error::new("world.accepted_work_retained", FailureStage::Drain,
        "已接收的执行尚未停止，原任务托管与检查点仍保留。",
        world_protocol::api::ApiFailure::Operation(world_protocol::operation::OperationFailure::CleanupFailed),
        world_protocol::failure::Recovery::Refresh)
}
