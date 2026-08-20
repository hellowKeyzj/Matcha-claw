mod adapter;
mod child;
mod command;
mod custody;
mod error;
mod handle;
mod job;
mod stdio;

pub mod loader;

#[cfg(test)]
mod stdio_tests;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

use super::super::{LaunchAttemptMaterializer, resource::ResourceRuntime};
use adapter::Adapter;

pub(crate) fn resource<M: LaunchAttemptMaterializer>(materializer: M) -> ResourceRuntime {
    ResourceRuntime::deferred(Adapter::new(), materializer)
}
