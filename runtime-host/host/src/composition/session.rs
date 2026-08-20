use std::{fmt, future::Future};

use tokio::task::JoinHandle;

use super::admission::RequestAdmissionClosed;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeSessionError<E> {
    AdmissionClosed(RequestAdmissionClosed),
    RuntimeUnavailable,
    Client(E),
}

impl<E: fmt::Display> fmt::Display for RuntimeSessionError<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::RuntimeUnavailable => formatter.write_str("runtime session is unavailable"),
            Self::Client(error) => error.fmt(formatter),
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for RuntimeSessionError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::AdmissionClosed(error) => Some(error),
            Self::RuntimeUnavailable => None,
            Self::Client(error) => Some(error),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionShutdownFailure {
    Close,
    Join,
}

pub(super) struct SessionShutdown {
    state: SessionShutdownState,
}

enum SessionShutdownState {
    Pending,
    Closing(JoinHandle<Result<(), SessionShutdownFailure>>),
    Settled(Option<SessionShutdownFailure>),
}

impl SessionShutdown {
    pub(super) const fn new() -> Self {
        Self {
            state: SessionShutdownState::Pending,
        }
    }

    pub(super) const fn is_pending(&self) -> bool {
        matches!(&self.state, SessionShutdownState::Pending)
    }

    pub(super) fn begin<F, E>(&mut self, close: F)
    where
        F: Future<Output = Result<(), E>> + Send + 'static,
        E: Send + 'static,
    {
        if !self.is_pending() {
            return;
        }
        self.state = SessionShutdownState::Closing(tokio::spawn(async move {
            close.await.map_err(|_| SessionShutdownFailure::Close)
        }));
    }

    pub(super) async fn finish(&mut self) {
        match &mut self.state {
            SessionShutdownState::Pending => {
                self.state = SessionShutdownState::Settled(None);
            }
            SessionShutdownState::Closing(task) => {
                let failure = match task.await {
                    Ok(result) => result.err(),
                    Err(_) => Some(SessionShutdownFailure::Join),
                };
                self.state = SessionShutdownState::Settled(failure);
            }
            SessionShutdownState::Settled(_) => {}
        }
    }

    pub(super) const fn is_settled(&self) -> bool {
        matches!(&self.state, SessionShutdownState::Settled(_))
    }

    pub(super) const fn failure(&self) -> Option<SessionShutdownFailure> {
        match &self.state {
            SessionShutdownState::Settled(failure) => *failure,
            SessionShutdownState::Pending | SessionShutdownState::Closing(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{convert::Infallible, task::Poll};

    use tokio::sync::oneshot;

    use super::*;

    async fn panic_during_close() -> Result<(), Infallible> {
        panic!("synthetic close panic")
    }

    #[tokio::test]
    async fn waiting_can_be_cancelled_without_cancelling_the_close_task() {
        let (release, released) = oneshot::channel();
        let mut close = SessionShutdown::new();
        close.begin(async move {
            let _ = released.await;
            Ok::<_, Infallible>(())
        });
        let mut wait = Box::pin(close.finish());

        std::future::poll_fn(|context| match wait.as_mut().poll(context) {
            Poll::Pending => Poll::Ready(()),
            Poll::Ready(()) => panic!("close finished before release"),
        })
        .await;
        drop(wait);
        release.send(()).unwrap();
        close.finish().await;

        assert!(close.is_settled());
        assert_eq!(close.failure(), None);
    }

    #[tokio::test]
    async fn close_and_join_failures_stay_distinct() {
        let mut close = SessionShutdown::new();
        close.begin(async { Err::<(), _>(()) });
        close.finish().await;
        assert_eq!(close.failure(), Some(SessionShutdownFailure::Close));

        let mut panic = SessionShutdown::new();
        panic.begin(panic_during_close());
        panic.finish().await;
        assert_eq!(panic.failure(), Some(SessionShutdownFailure::Join));
    }
}
