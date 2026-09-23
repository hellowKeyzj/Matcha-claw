use std::{io, sync::Arc};

use foundation::{execution::OwnedTask, lifecycle::ModuleScope};
use platform::loopback::RouteDeadline;
use tokio::{
    net::{TcpListener, TcpStream},
    task::JoinSet,
    time::timeout,
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

    pub(crate) fn into_scoped_extension(self) -> ModuleScope {
        let mut scope = ModuleScope::new(HOST_HTTP_EXTENSION_SCOPE_ID);
        let (task, handle) = OwnedTask::spawn(|cancellation| self.run(cancellation));
        scope.register_owned_task(task);
        scope.register_listener(HTTP_LISTENER_EFFECT_ID, move || async move {
            handle.cancel();
        });
        scope
    }

    async fn run(self, cancellation: CancellationToken) -> io::Result<()> {
        let Self { listener, router } = self;
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => break,
                accepted = listener.accept() => {
                    let (stream, _) = accepted?;
                    let router = Arc::clone(&router);
                    connections.spawn(async move {
                        let _ = serve(stream, router).await;
                    });
                }
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }
        connections.abort_all();
        while connections.join_next().await.is_some() {}
        Ok(())
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
    let parts = match read_head(&mut stream).await? {
        Ok(parts) => parts,
        Err(response) => return RouteOutcome::Response(response).write(stream).await,
    };
    let deadline = router.deadline(&parts.head).await;
    let policy = router.body_policy(&parts.head).await;
    let timeout_response = router.timeout_response(Some(&parts.head)).await;
    let outcome = match deadline {
        RouteDeadline::Request(deadline) => {
            match timeout(deadline, async {
                let request = finish_request(&mut stream, parts, policy).await?;
                Ok::<_, io::Error>(match request {
                    Ok(request) => router.route(request).await,
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
            match timeout(deadline, finish_request(&mut stream, parts, policy)).await {
                Ok(Ok(Ok(request))) => router.route(request).await,
                Ok(Ok(Err(response))) => RouteOutcome::Response(response),
                Ok(Err(error)) => return Err(error),
                Err(_) => RouteOutcome::Response(timeout_response),
            }
        }
    };
    outcome.write(stream).await
}
