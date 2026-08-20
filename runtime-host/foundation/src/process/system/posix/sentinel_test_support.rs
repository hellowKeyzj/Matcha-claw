use std::io;
use std::sync::atomic::Ordering;

use super::sentinel::launch;

pub(super) fn reap_unarmed_target(target_pid: libc::pid_t) -> io::Result<()> {
    launch::reap_unarmed_target(target_pid)
}

pub(super) fn set_stall_before_target_setup(enabled: bool) {
    launch::STALL_BEFORE_TARGET_SETUP.store(enabled, Ordering::Relaxed);
}

pub(super) fn set_cleanup_confirmation_failure(enabled: bool) {
    launch::FAIL_CLEANUP_CONFIRMATION.store(enabled, Ordering::Relaxed);
}
