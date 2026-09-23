use std::sync::Arc;

use platform::parent_callback::{ParentCallbackFuture, ParentShellOpenPath};

#[derive(Clone)]
pub struct OpenClawDriverParentCallbackHandle {
    callback: Arc<dyn ParentShellOpenPath>,
}

impl OpenClawDriverParentCallbackHandle {
    pub fn new(callback: Arc<dyn ParentShellOpenPath>) -> Self {
        Self { callback }
    }

    pub fn open_path<'a>(&'a self, path: std::path::PathBuf) -> ParentCallbackFuture<'a, bool> {
        self.callback.open_path(path)
    }
}
