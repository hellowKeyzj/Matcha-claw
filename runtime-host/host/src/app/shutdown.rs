use std::time::Duration;

use crate::{control::ControlError, host_actor};

const SHUTDOWN_RETRY_INTERVAL: Duration = Duration::from_millis(50);

pub(crate) async fn shutdown_host(owner: &mut host_actor::Owner) -> Result<(), ControlError> {
    loop {
        let attempt = owner
            .handle()
            .shutdown()
            .await
            .map_err(|_| ControlError::Owner)?;
        if attempt.terminal {
            let result = attempt
                .result
                .map(|_| ())
                .map_err(|_| ControlError::Shutdown);
            let joined = owner.join().await.map_err(|_| ControlError::Owner)?;
            joined.map_err(|_| ControlError::Shutdown)?;
            return result;
        }
        tokio::time::sleep(SHUTDOWN_RETRY_INTERVAL).await;
    }
}
