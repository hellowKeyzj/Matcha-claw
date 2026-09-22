use std::{future::Future, pin::Pin};

pub type RuntimeEndpointDirectoryFuture<'a> =
    Pin<Box<dyn Future<Output = Result<crate::Directory, ()>> + Send + 'a>>;

pub trait RuntimeEndpointDirectorySource: Send + Sync {
    fn runtime_endpoint_directory<'a>(&'a self) -> RuntimeEndpointDirectoryFuture<'a>;
}
