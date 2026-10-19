use std::{future::Future, pin::Pin};

use platform::endpoint::runtime_address::RuntimeEndpoint;

use crate::{RuntimeSearchPhase, SearchError, SearchVerification};

pub type RuntimeSearchFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, SearchError>> + Send + 'a>>;

#[derive(Clone, Debug)]
pub struct RuntimeSearchProjection {
    pub base_url: String,
    pub categories: String,
    pub language: String,
    pub safe_search: u8,
    pub result_count: u8,
    pub revision: String,
}

pub trait RuntimeSearchPort: Send + Sync {
    fn apply<'a>(
        &'a self,
        endpoint: &'a RuntimeEndpoint,
        projection: Option<&'a RuntimeSearchProjection>,
        authorize: bool,
    ) -> RuntimeSearchFuture<'a, RuntimeSearchPhase>;
    fn observe<'a>(
        &'a self,
        endpoint: &'a RuntimeEndpoint,
    ) -> RuntimeSearchFuture<'a, RuntimeSearchPhase>;
    fn verify<'a>(
        &'a self,
        endpoint: &'a RuntimeEndpoint,
        request: &'a searxng::SearchRequest,
    ) -> RuntimeSearchFuture<'a, SearchVerification>;
}
