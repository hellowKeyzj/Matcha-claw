pub(crate) fn is_main_session_key(session_key: &str) -> bool {
    let mut segments = session_key.split(':');
    match segments.next() {
        Some("main") => segments.next().is_none(),
        Some("agent") => {
            let (Some(agent_id), Some("main")) = (segments.next(), segments.next()) else {
                return false;
            };
            !agent_id.is_empty() && segments.next().is_none()
        }
        _ => false,
    }
}

pub(crate) fn is_cron_session_key(session_key: &str) -> bool {
    let mut segments = session_key.split(':');
    match segments.next() {
        Some("cron") => {
            let Some(job_id) = segments.next() else {
                return false;
            };
            !job_id.is_empty() && segments.next().is_none()
        }
        Some("agent") => {
            let (Some(agent_id), Some("cron"), Some(job_id)) =
                (segments.next(), segments.next(), segments.next())
            else {
                return false;
            };
            if agent_id.is_empty() || job_id.is_empty() {
                return false;
            }
            match segments.next() {
                None => true,
                Some("run") => {
                    segments.next().is_some_and(|run_id| !run_id.is_empty())
                        && segments.next().is_none()
                }
                Some(_) => false,
            }
        }
        _ => false,
    }
}
