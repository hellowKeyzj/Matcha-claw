use std::{io, process::Stdio};

use tokio::{
    process::{ChildStderr, ChildStdin, ChildStdout, Command},
    signal::unix::{Signal, SignalKind, signal},
};

use super::{Launch, io_failure};
use crate::rpc;

pub(super) type Input = ChildStdin;

pub(super) struct Spawned {
    pub(super) child: Child,
    pub(super) stdin: Input,
    pub(super) stdout: ChildStdout,
    pub(super) stderr: ChildStderr,
}

pub(super) struct Child {
    child: tokio::process::Child,
    changed: Signal,
    // Keep the direct child unreaped until killpg: its PID pins our group ID,
    // including after root exit. Never signal a cached PID after wait/reap.
    group: Option<libc::pid_t>,
    pid: u32,
}

pub(super) async fn spawn(launch: Launch) -> rpc::Result<Spawned> {
    let changed = signal(SignalKind::child()).map_err(|error| {
        io_failure(
            "process_signal_setup",
            "CLI exit observation could not be registered",
            error,
        )
    })?;
    let mut command = Command::new(launch.command);
    command
        .args(launch.args)
        .env_clear()
        .envs(launch.env)
        .current_dir(launch.cwd)
        .process_group(0)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        io_failure(
            "process_spawn_failed",
            "CLI process could not be started",
            error,
        )
    })?;
    let pid = child.id().expect("new child PID");
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    Ok(Spawned {
        child: Child {
            child,
            changed,
            group: Some(pid as libc::pid_t),
            pid,
        },
        stdin,
        stdout,
        stderr,
    })
}

impl Child {
    pub(super) fn pid(&self) -> u32 {
        self.pid
    }

    pub(super) async fn exited(&mut self) -> rpc::Result<()> {
        loop {
            if self.probe_exit()? {
                return Ok(());
            }
            self.changed.recv().await.ok_or_else(|| {
                rpc::Error::new(
                    -32004,
                    "process_signal_closed",
                    "CLI exit signal stream closed",
                )
            })?;
        }
    }

    fn probe_exit(&self) -> rpc::Result<bool> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        loop {
            // SAFETY: this is our still-unreaped direct child, not an adopted PID.
            // WNOWAIT is essential: process_group(0) remains pinned until cleanup.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
                )
            };
            if result == 0 {
                return Ok(unsafe { info.si_pid() } != 0);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(io_failure(
                    "process_exit_probe_failed",
                    "CLI exit could not be observed",
                    error,
                ));
            }
        }
    }

    pub(super) fn terminate_tree(&mut self) -> rpc::Result<()> {
        let Some(group) = self.group else {
            return Ok(());
        };
        // Proves that our direct child has not been reaped/reused before using
        // a numeric process-group ID. An external reaper means no kill authority.
        self.probe_exit()?;
        let actual = unsafe { libc::getpgid(self.pid as libc::pid_t) };
        if actual != group || group <= 1 || group == unsafe { libc::getpgrp() } {
            return Err(rpc::Error::new(
                -32004,
                "process_group_unproven",
                "CLI process group ownership could not be confirmed",
            ));
        }
        // SAFETY: process_group(0) created this group and the unreaped leader pins
        // its ID. Only that group is targeted, never the host group or an adopter.
        if unsafe { libc::killpg(group, libc::SIGKILL) } == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(io_failure(
                    "process_tree_cleanup_failed",
                    "CLI process group could not be terminated",
                    error,
                ));
            }
        }
        Ok(())
    }

    pub(super) async fn wait(&mut self) -> rpc::Result<(Option<i32>, Option<i32>)> {
        use std::os::unix::process::ExitStatusExt;
        let result = self.child.wait().await;
        // Whether wait succeeded or failed, never reuse a group number after a
        // reaping attempt; an error no longer proves that the PID is still pinned.
        self.group = None;
        let status = result.map_err(|error| {
            io_failure(
                "process_wait_failed",
                "CLI process could not be reaped",
                error,
            )
        })?;
        Ok((status.code(), status.signal()))
    }

    pub(super) async fn confirm_cleanup(&mut self) -> rpc::Result<()> {
        // POSIX has no waitable group handle. Direct child wait + stdio EOF are
        // the observable confirmations; detached/new-session descendants escape
        // process-group ownership and must not be discovered/killed by PID scans.
        Ok(())
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        if self.group.is_some() {
            let _ = self.terminate_tree();
        }
        // Tokio's kill_on_drop/reaper is only the last-resort direct-child path.
    }
}
