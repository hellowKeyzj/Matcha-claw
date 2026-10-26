pub(crate) mod objects;
pub(crate) mod context;
pub(crate) mod agent_bridge;
mod discovery;

use world_protocol::{api::{QueryResult, WorldQuery}, failure::FailureStage, time::Timestamp};
use crate::{authorization::VerifiedInvocation, store::{StoreFuture, WorldTransaction}};
use super::{Error, resources::Resources, workflows};

pub(crate) fn query<'a>(
    resources: &'a Resources, tx: &'a WorldTransaction<'_>, verified: &'a VerifiedInvocation,
    query: &'a WorldQuery, now: &'a Timestamp, budget: &'a crate::extensions::invocation::CallBudget,
    cancel: &'a tokio_util::sync::CancellationToken,
) -> StoreFuture<'a, QueryResult, Error> {
    match query {
        WorldQuery::Discover(request) => Box::pin(async move { discovery::query(tx, verified, request, now).await.map(QueryResult::Discover) }),
        WorldQuery::TaskContract(_) | WorldQuery::Abstractions(_) | WorldQuery::Abstraction(_) => Box::pin(async move { context::query(resources, tx, verified, query, now, budget, cancel).await }),
        WorldQuery::Materials(_) | WorldQuery::SourceVersion(_) => Box::pin(async move { workflows::archive::query(&resources.content, tx, verified, query, now).await }),
        WorldQuery::MaterialDraft(reference) => Box::pin(async move { workflows::materials::draft_query(tx, verified, reference, now).await.map(QueryResult::MaterialDraft) }),
        WorldQuery::Connections(_) | WorldQuery::Capabilities(_) | WorldQuery::SourceSchema(_) | WorldQuery::BranchSourceContext(_) | WorldQuery::Mappings(_) | WorldQuery::SyncStatus(_) => Box::pin(async move { workflows::sources::query(tx, verified, query, now, budget, cancel).await }),
        WorldQuery::Definitions(_) | WorldQuery::Definition(_) | WorldQuery::Branches(_) | WorldQuery::Releases(_) => Box::pin(async move { workflows::releases::query(tx, verified, query, now).await }),
        WorldQuery::Changes(_) | WorldQuery::Change(_) | WorldQuery::Tasks(_) | WorldQuery::Task(_) => Box::pin(async move { workflows::learning::query(tx, verified, query, now).await }),
        WorldQuery::Evaluations(_) | WorldQuery::Evaluation(_) | WorldQuery::Suites(_) | WorldQuery::Suite(_) | WorldQuery::SuiteCreationContext(_) | WorldQuery::TestCases(_) | WorldQuery::ExactTestCase(_) | WorldQuery::FrozenSuite(_) => Box::pin(async move { workflows::evaluation::query(resources, tx, verified, query, now).await }),
        WorldQuery::ActionProposals(_) | WorldQuery::ActionStatus(_) => Box::pin(async move { workflows::actions::query(tx, verified, query, now, budget, cancel).await }),
        WorldQuery::Explain(_) => Box::pin(async move { workflows::facts::query(tx, verified, query, now, budget, cancel).await }),
        WorldQuery::Packages(_) | WorldQuery::PackageTrustPolicy(_) | WorldQuery::Bindings(_) | WorldQuery::BindingHead(_) | WorldQuery::PackageConfig(_) | WorldQuery::Contributions(_) => Box::pin(async move { workflows::packages::query(tx, verified, query, now).await }),
        _ => Box::pin(async move { Err(Error::internal(FailureStage::Decode)) }),
    }
}

pub(crate) use discovery::{impact as discovery_impact, query as discover};
