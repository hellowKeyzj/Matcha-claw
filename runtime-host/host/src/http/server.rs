use std::{io, sync::Arc};

use foundation::{execution::OwnedTask, lifecycle::ModuleScope};
use platform::loopback::RouteDeadline;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinSet,
    time::{Instant, timeout_at},
};
use tokio_util::sync::CancellationToken;

use super::{
    RouteOutcome, Router,
    request::{finish_request, read_head},
};

const HOST_HTTP_EXTENSION_SCOPE_ID: &str = "host.http";
const HTTP_LISTENER_EFFECT_ID: &str = "http.listener";

pub(crate) struct Server {
    listener: TcpListener,
    router: Arc<Router>,
}

impl Server {
    pub(crate) async fn bind(port: u16, router: Router) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            router: Arc::new(router),
        })
    }

    pub(crate) fn local_addr(&self) -> std::net::SocketAddr {
        self.listener
            .local_addr()
            .expect("HTTP substrate listener has a local address")
    }

    pub(crate) fn into_scoped_extension(self) -> (ModuleScope, oneshot::Receiver<io::Result<()>>) {
        let mut scope = ModuleScope::new(HOST_HTTP_EXTENSION_SCOPE_ID);
        let (finished, completion) = oneshot::channel();
        let (task, handle) = OwnedTask::spawn(|cancellation| async move {
            let _ = finished.send(self.run(cancellation).await);
        });
        scope.register_owned_task(task);
        scope.register_listener(HTTP_LISTENER_EFFECT_ID, move || async move {
            handle.cancel();
        });
        (scope, completion)
    }

    async fn run(self, cancellation: CancellationToken) -> io::Result<()> {
        let Self { listener, router } = self;
        let mut connections = JoinSet::new();
        let result = loop {
            tokio::select! {
                _ = cancellation.cancelled() => break Ok(()),
                accepted = listener.accept() => {
                    let (stream, _) = match accepted {
                        Ok(accepted) => accepted,
                        Err(error) if matches!(
                            error.kind(),
                            io::ErrorKind::Interrupted
                                | io::ErrorKind::WouldBlock
                                | io::ErrorKind::ConnectionAborted
                                | io::ErrorKind::ConnectionReset
                        ) => continue,
                        Err(error) => break Err(error),
                    };
                    let router = Arc::clone(&router);
                    connections.spawn(async move {
                        let _ = serve(stream, router).await;
                    });
                }
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        };
        connections.abort_all();
        while connections.join_next().await.is_some() {}
        result
    }

    #[cfg(test)]
    pub(crate) fn port(&self) -> u16 {
        self.listener
            .local_addr()
            .expect("HTTP substrate listener has a local address")
            .port()
    }
}

async fn serve(mut stream: TcpStream, router: Arc<Router>) -> io::Result<()> {
    let mut parts = match read_head(&mut stream).await? {
        Ok(parts) => parts,
        Err(response) => return RouteOutcome::Response(response).write(stream).await,
    };
    let route = router.resolve(&parts.head).await;
    let plan = route.plan();
    let policy = plan.body_policy();
    let timeout_response = plan.timeout_response();
    let request_started_at = Instant::now();
    parts.head.set_request_started_at(request_started_at);
    let outcome = match plan.deadline() {
        RouteDeadline::Request(deadline) => {
            match timeout_at(request_started_at + deadline, async {
                let request = finish_request(&mut stream, parts, policy).await?;
                Ok::<_, io::Error>(match request {
                    Ok(request) => route.dispatch(request).await,
                    Err(response) => RouteOutcome::Response(response),
                })
            })
            .await
            {
                Ok(outcome) => outcome?,
                Err(_) => RouteOutcome::Response(timeout_response),
            }
        }
        RouteDeadline::Body(deadline) => {
            match timeout_at(
                request_started_at + deadline,
                finish_request(&mut stream, parts, policy),
            )
            .await
            {
                Ok(Ok(Ok(request))) => route.dispatch(request).await,
                Ok(Ok(Err(response))) => RouteOutcome::Response(response),
                Ok(Err(error)) => return Err(error),
                Err(_) => RouteOutcome::Response(timeout_response),
            }
        }
    };
    outcome.write(stream).await
}
