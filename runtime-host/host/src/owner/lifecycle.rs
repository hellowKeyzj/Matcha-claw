pub(crate) enum StartMatchaError {
    AdmissionClosed,
    RuntimeStart,
}

pub(crate) enum StopMatchaError {
    AdmissionClosed,
    RuntimeStop,
}

pub(crate) enum RestartMatchaError {
    AdmissionClosed,
    RuntimeRestart,
}

pub(crate) enum StartOpenClawError {
    AdmissionClosed,
    RuntimeStart,
}

pub(crate) enum StopOpenClawError {
    AdmissionClosed,
    RuntimeStop,
}

pub(crate) enum RestartOpenClawError {
    AdmissionClosed,
    RuntimeRestart,
}
