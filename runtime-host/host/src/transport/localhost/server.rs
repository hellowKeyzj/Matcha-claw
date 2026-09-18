use std::{io, sync::Arc};

use tokio::{net::TcpListener, time::timeout};

use super::{
    RouteOutcome, Router,
    http::{finish_request, read_head},
};

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

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let router = Arc::clone(&self.router);
            tokio::spawn(async move {
                let _ = serve(stream, router).await;
            });
        }
    }

    #[cfg(test)]
    pub(crate) fn port(&self) -> u16 {
        self.listener
            .local_addr()
            .expect("localhost transport listener has a local address")
            .port()
    }
}

async fn serve(mut stream: tokio::net::TcpStream, router: Arc<Router>) -> io::Result<()> {
    let parts = match read_head(&mut stream).await? {
        Ok(parts) => parts,
        Err(response) => return RouteOutcome::Response(response).write(stream).await,
    };
    let deadline = router.deadline(&parts.head);
    let policy = router.body_policy(&parts.head);
    let timeout_response = router.timeout_response(Some(&parts.head));
    let outcome = match timeout(deadline, async {
        let request = finish_request(&mut stream, parts, policy).await?;
        Ok::<_, io::Error>(match request {
            Ok(request) => router.route(request).await,
            Err(response) => RouteOutcome::Response(response),
        })
    })
    .await
    {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(error)) => return Err(error),
        Err(_) => RouteOutcome::Response(timeout_response),
    };
    outcome.write(stream).await
}
