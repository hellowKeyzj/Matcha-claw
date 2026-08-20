use std::{
    collections::VecDeque,
    ffi::{OsStr, OsString},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::SystemTime,
};

use tokio::sync::{Notify, Semaphore};

use super::super::{
    NativeAdapter, NativeCleanupResult, NativeDetachResult, NativeFuture, NativeInstallResult,
    NativePollResult,
};
use crate::process::{
    AuthorityScope, ExitObservation, FixedLaunch, LaunchSpec, ProcessIdentity, ProcessObservation,
    Provenance, ScopeId, StdioMode, StdioSpec,
};

#[derive(Clone)]
pub(super) struct FakeAdapter {
    state: Arc<FakeState>,
}

struct FakeState {
    install_permits: Semaphore,
    install_called: Notify,
    install: Mutex<VecDeque<NativeInstallResult>>,
    installed_markers: Mutex<Vec<OsString>>,
    poll_permits: Semaphore,
    poll_called: Notify,
    poll_calls: AtomicUsize,
    poll: Mutex<VecDeque<NativePollResult>>,
    cleanup: Mutex<VecDeque<NativeCleanupResult>>,
    cleanup_permits: Semaphore,
    cleanup_called: Notify,
    cleanup_calls: AtomicUsize,
    detach: Mutex<VecDeque<NativeDetachResult>>,
    detach_calls: AtomicUsize,
    cleanup_returned: AtomicBool,
    cleanup_returned_notify: Notify,
    dropped: AtomicBool,
    dropped_notify: Notify,
}

impl FakeAdapter {
    pub(super) fn new(install: NativeInstallResult) -> Self {
        Self {
            state: Arc::new(FakeState {
                install_permits: Semaphore::new(0),
                install_called: Notify::new(),
                install: Mutex::new(VecDeque::from([install])),
                installed_markers: Mutex::new(Vec::new()),
                poll_permits: Semaphore::new(usize::MAX >> 4),
                poll_called: Notify::new(),
                poll_calls: AtomicUsize::new(0),
                poll: Mutex::new(VecDeque::new()),
                cleanup: Mutex::new(VecDeque::from([NativeCleanupResult::Terminated(exit(9))])),
                cleanup_permits: Semaphore::new(usize::MAX >> 4),
                cleanup_called: Notify::new(),
                cleanup_calls: AtomicUsize::new(0),
                detach: Mutex::new(VecDeque::from([NativeDetachResult::Detached])),
                detach_calls: AtomicUsize::new(0),
                cleanup_returned: AtomicBool::new(false),
                cleanup_returned_notify: Notify::new(),
                dropped: AtomicBool::new(false),
                dropped_notify: Notify::new(),
            }),
        }
    }

    pub(super) fn allow_install(&self) {
        self.state.install_permits.add_permits(1);
    }

    pub(super) async fn wait_install_called(&self) {
        self.state.install_called.notified().await;
    }

    pub(super) fn block_poll(&self) {
        let permits = self.state.poll_permits.available_permits();
        self.state.poll_permits.forget_permits(permits);
    }

    pub(super) fn allow_poll(&self) {
        self.state.poll_permits.add_permits(1);
    }

    pub(super) async fn wait_poll_called(&self) {
        self.state.poll_called.notified().await;
    }

    pub(super) fn block_cleanup(&self) {
        let permits = self.state.cleanup_permits.available_permits();
        self.state.cleanup_permits.forget_permits(permits);
    }

    pub(super) fn allow_cleanup(&self) {
        self.state.cleanup_permits.add_permits(1);
    }

    pub(super) async fn wait_cleanup_called(&self) {
        if self.cleanup_calls() == 0 {
            self.state.cleanup_called.notified().await;
        }
    }

    pub(super) async fn wait_cleanup_returned(&self) {
        if !self.state.cleanup_returned.load(Ordering::SeqCst) {
            self.state.cleanup_returned_notify.notified().await;
        }
    }

    pub(super) fn push_poll(&self, result: NativePollResult) {
        self.state.poll.lock().unwrap().push_back(result);
    }

    pub(super) fn push_cleanup(&self, result: NativeCleanupResult) {
        self.state.cleanup.lock().unwrap().push_front(result);
    }

    pub(super) fn poll_calls(&self) -> usize {
        self.state.poll_calls.load(Ordering::SeqCst)
    }

    pub(super) fn cleanup_calls(&self) -> usize {
        self.state.cleanup_calls.load(Ordering::SeqCst)
    }

    pub(super) fn push_detach(&self, result: NativeDetachResult) {
        self.state.detach.lock().unwrap().push_front(result);
    }

    pub(super) fn detach_calls(&self) -> usize {
        self.state.detach_calls.load(Ordering::SeqCst)
    }

    pub(super) fn installed_markers(&self) -> Vec<OsString> {
        self.state.installed_markers.lock().unwrap().clone()
    }

    pub(super) fn is_dropped(&self) -> bool {
        self.state.dropped.load(Ordering::SeqCst)
    }

    pub(super) async fn wait_dropped(&self) {
        if !self.is_dropped() {
            self.state.dropped_notify.notified().await;
        }
    }
}

impl Drop for FakeAdapter {
    fn drop(&mut self) {
        if Arc::strong_count(&self.state) == 2 {
            self.state.dropped.store(true, Ordering::SeqCst);
            self.state.dropped_notify.notify_waiters();
        }
    }
}

impl NativeAdapter for FakeAdapter {
    fn install(
        &mut self,
        request: crate::process::launch::LaunchRequest,
    ) -> NativeFuture<'_, NativeInstallResult> {
        let state = self.state.clone();
        let marker = request.spec.arguments().first().cloned().unwrap();
        Box::pin(async move {
            state.installed_markers.lock().unwrap().push(marker);
            state.install_called.notify_one();
            state.install_permits.acquire().await.unwrap().forget();
            state.install.lock().unwrap().pop_front().unwrap()
        })
    }

    fn poll(&mut self) -> NativeFuture<'_, NativePollResult> {
        let state = self.state.clone();
        Box::pin(async move {
            state.poll_calls.fetch_add(1, Ordering::SeqCst);
            state.poll_called.notify_one();
            state.poll_permits.acquire().await.unwrap().forget();
            state
                .poll
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(NativePollResult::Pending)
        })
    }

    fn cleanup(&mut self) -> NativeFuture<'_, NativeCleanupResult> {
        self.state.cleanup_calls.fetch_add(1, Ordering::SeqCst);
        self.state.cleanup_called.notify_one();
        let state = self.state.clone();
        let result = state
            .cleanup
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| NativeCleanupResult::AlreadyDrained(exit(9)));
        Box::pin(async move {
            state.cleanup_permits.acquire().await.unwrap().forget();
            state.cleanup_returned.store(true, Ordering::SeqCst);
            state.cleanup_returned_notify.notify_waiters();
            result
        })
    }

    fn detach(&mut self) -> NativeFuture<'_, NativeDetachResult> {
        self.state.detach_calls.fetch_add(1, Ordering::SeqCst);
        let result = self.state.detach.lock().unwrap().pop_front().unwrap();
        Box::pin(async move { result })
    }
}

pub(super) fn test_launch() -> FixedLaunch {
    FixedLaunch::new(test_spec("fixed-attempt"))
}

pub(super) fn test_spec(marker: impl AsRef<OsStr>) -> LaunchSpec {
    LaunchSpec::try_new(
        test_absolute_path("foundation-test-runtime"),
        test_absolute_path("foundation-test-working-directory"),
        [marker.as_ref().to_owned()],
        [],
        StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
    )
    .unwrap()
}

fn test_absolute_path(name: &str) -> PathBuf {
    let root = if cfg!(windows) { "C:/" } else { "/" };
    PathBuf::from(root).join(name)
}

pub(super) fn observation() -> ProcessObservation {
    ProcessObservation::new(
        ProcessIdentity::new(7, 1),
        Provenance::Spawned {
            scope: AuthorityScope::owned(ScopeId::new([7; 16])),
        },
    )
}

pub(super) fn exit(code: i32) -> ExitObservation {
    ExitObservation::new(Some(code), None, SystemTime::UNIX_EPOCH)
}
