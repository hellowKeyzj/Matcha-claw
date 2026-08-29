//! Owner execution primitive for long-lived mailbox actors.
//!
//! Provides the minimal mechanical substrate for spawning and managing owners
//! with typed command mailboxes. Does not impose business semantics, state management,
//! or generic actor patterns—each owner implements its own command handling logic.
//!
//! # Design Constraints
//!
//! - No generic actor framework or middleware
//! - No supervision tree or message routing DSL
//! - No shared state management or keyed lanes (business concern)
//! - No operation completion tracking (owner-specific)
//!
//! # Usage
//!
//! ```rust,ignore
//! struct MyOwner {
//!     state: MyState,
//! }
//!
//! enum MyCommand {
//!     DoWork { reply: oneshot::Sender<Result> },
//! }
//!
//! impl Owner for MyOwner {
//!     type Command = MyCommand;
//!
//!     async fn handle_command(&mut self, command: Self::Command) {
//!         match command {
//!             MyCommand::DoWork { reply } => {
//!                 let result = self.do_work();
//!                 let _ = reply.send(result);
//!             }
//!         }
//!     }
//! }
//!
//! let (handle, join) = spawn_owner(my_owner, 32);
//! handle.send(MyCommand::DoWork { reply }).await?;
//! join.await?;
//! ```

use std::fmt;

use tokio::sync::mpsc;

use super::TaskHandle;

/// Minimal owner trait: handle commands from a mailbox.
///
/// Owners implement business-specific command handling. The trait does not
/// prescribe state management, operation tracking, or shutdown semantics—
/// these are owner responsibilities.
pub trait Owner: Send + Sized + 'static {
    type Command: Send + 'static;

    /// Set the owner's self-handle after channel creation.
    ///
    /// Called once by `spawn_owner` before the loop starts. Allows the owner
    /// to send commands to itself (e.g., for async operation completion callbacks).
    fn set_handle(&mut self, handle: OwnerHandle<Self::Command>);

    /// Handle a single command.
    ///
    /// Called sequentially by the owner loop. Long-running I/O should spawn
    /// `OperationHandle` to avoid blocking the mailbox.
    fn handle_command(
        &mut self,
        command: Self::Command,
    ) -> impl std::future::Future<Output = ()> + Send;

    /// Optional graceful shutdown hook, called when mailbox closes.
    ///
    /// Default: no-op. Override to flush buffers, cancel operations, or
    /// log final state.
    fn shutdown(self) -> impl std::future::Future<Output = ()> + Send {
        async {}
    }
}

/// Cloneable handle for sending commands to an owner mailbox.
///
/// Cheap to clone—all clones share the same underlying channel.
pub struct OwnerHandle<Cmd> {
    sender: mpsc::Sender<Cmd>,
}

impl<Cmd> OwnerHandle<Cmd> {
    /// Create a closed handle (used during owner initialization).
    pub fn closed() -> Self {
        let (sender, receiver) = mpsc::channel(1);
        drop(receiver);
        Self { sender }
    }

    /// Send a command to the owner mailbox.
    ///
    /// Fails if the owner loop has terminated or the mailbox is full.
    /// Capacity is fixed at spawn time; callers should handle backpressure.
    pub async fn send(&self, command: Cmd) -> Result<(), SendError> {
        self.sender
            .send(command)
            .await
            .map_err(|_| SendError::MailboxClosed)
    }

    /// Try to send without blocking.
    ///
    /// Fails immediately if the mailbox is full or closed.
    pub fn try_send(&self, command: Cmd) -> Result<(), TrySendError> {
        self.sender.try_send(command).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => TrySendError::Full,
            mpsc::error::TrySendError::Closed(_) => TrySendError::Closed,
        })
    }

    /// Check if the owner loop is still running.
    pub fn is_closed(&self) -> bool {
        self.sender.is_closed()
    }
}

impl<Cmd> Clone for OwnerHandle<Cmd> {
    fn clone(&self) -> Self {
        Self {
            sender: self.sender.clone(),
        }
    }
}

impl<Cmd> fmt::Debug for OwnerHandle<Cmd> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OwnerHandle")
            .field("closed", &self.sender.is_closed())
            .finish_non_exhaustive()
    }
}

/// Spawn an owner with a bounded command mailbox.
///
/// Returns:
/// - `OwnerHandle<Cmd>`: Send commands to the owner
/// - `TaskHandle`: Cancel or wait for the owner loop to terminate
///
/// # Owner Loop Lifecycle
///
/// 1. Receives commands from mailbox sequentially
/// 2. Calls `Owner::handle_command` for each
/// 3. On mailbox close (all handles dropped), calls `Owner::shutdown`
/// 4. Loop terminates
///
/// # Panics
///
/// If the owner's `handle_command` or `shutdown` panics, the task aborts.
/// Callers can detect this via `TaskHandle::join` returning `JoinError`.
///
/// # Capacity
///
/// Fixed mailbox capacity. If the mailbox fills, `send()` blocks until space
/// is available. Choose capacity based on expected command rate and processing
/// latency. 32 is a reasonable default for most owners.
pub fn spawn_owner<O>(mut owner: O, capacity: usize) -> (OwnerHandle<O::Command>, TaskHandle)
where
    O: Owner,
{
    let (sender, receiver) = mpsc::channel(capacity);

    // Pass handle to owner before spawning
    let handle = OwnerHandle {
        sender: sender.clone(),
    };
    owner.set_handle(handle.clone());

    let join_handle = TaskHandle::spawn_detached(|_cancel| async move {
        run_owner_loop(owner, receiver).await;
    });

    (handle, join_handle)
}

async fn run_owner_loop<O>(mut owner: O, mut receiver: mpsc::Receiver<O::Command>)
where
    O: Owner,
{
    while let Some(command) = receiver.recv().await {
        owner.handle_command(command).await;
    }

    // Mailbox closed, invoke shutdown hook
    owner.shutdown().await;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendError {
    MailboxClosed,
}

impl fmt::Display for SendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MailboxClosed => write!(f, "owner mailbox closed"),
        }
    }
}

impl std::error::Error for SendError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrySendError {
    Full,
    Closed,
}

impl fmt::Display for TrySendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Full => write!(f, "owner mailbox full"),
            Self::Closed => write!(f, "owner mailbox closed"),
        }
    }
}

impl std::error::Error for TrySendError {}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    struct TestOwner {
        counter: u64,
    }

    enum TestCommand {
        Increment { reply: oneshot::Sender<u64> },
        Get { reply: oneshot::Sender<u64> },
    }

    impl Owner for TestOwner {
        type Command = TestCommand;

        fn set_handle(&mut self, _handle: OwnerHandle<Self::Command>) {}

        async fn handle_command(&mut self, command: Self::Command) {
            match command {
                TestCommand::Increment { reply } => {
                    self.counter += 1;
                    let _ = reply.send(self.counter);
                }
                TestCommand::Get { reply } => {
                    let _ = reply.send(self.counter);
                }
            }
        }
    }

    #[tokio::test]
    async fn owner_handles_commands_sequentially() {
        let owner = TestOwner { counter: 0 };
        let (handle, _join) = spawn_owner(owner, 32);

        let (tx1, rx1) = oneshot::channel();
        handle
            .send(TestCommand::Increment { reply: tx1 })
            .await
            .unwrap();
        assert_eq!(rx1.await.unwrap(), 1);

        let (tx2, rx2) = oneshot::channel();
        handle
            .send(TestCommand::Increment { reply: tx2 })
            .await
            .unwrap();
        assert_eq!(rx2.await.unwrap(), 2);

        let (tx3, rx3) = oneshot::channel();
        handle.send(TestCommand::Get { reply: tx3 }).await.unwrap();
        assert_eq!(rx3.await.unwrap(), 2);
    }

    #[tokio::test]
    async fn owner_handle_detects_closed_mailbox() {
        let owner = TestOwner { counter: 0 };
        let (handle, join) = spawn_owner(owner, 32);

        drop(handle);
        drop(join);

        let handle2: OwnerHandle<TestCommand> = OwnerHandle {
            sender: mpsc::channel(1).0,
        };
        assert!(handle2.is_closed());
    }

    #[tokio::test]
    async fn owner_try_send_respects_capacity() {
        let owner = TestOwner { counter: 0 };
        let (handle, _join) = spawn_owner(owner, 1);

        let (tx1, _rx1) = oneshot::channel();
        handle
            .try_send(TestCommand::Increment { reply: tx1 })
            .unwrap();

        let (tx2, _rx2) = oneshot::channel();
        let err = handle
            .try_send(TestCommand::Increment { reply: tx2 })
            .unwrap_err();
        assert_eq!(err, TrySendError::Full);
    }
}
