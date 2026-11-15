use std::future::Future;

use futures_util::future::BoxFuture;

// Keep selected future construction out of dispatchers' stack frames.
#[inline(never)]
pub(crate) fn boxed<'a, F>(create: impl FnOnce() -> F) -> BoxFuture<'a, F::Output>
where
    F: Future + Send + 'a,
{
    Box::pin(create())
}
