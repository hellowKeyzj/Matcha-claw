use std::{future::Future, path::PathBuf, pin::Pin};

pub type ParentCallbackFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait ParentShellOpenPath: Send + Sync + 'static {
    fn open_path<'a>(&'a self, path: PathBuf) -> ParentCallbackFuture<'a, bool>;
}
