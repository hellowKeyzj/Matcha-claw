use crate::{
    authorization::OnlineOracleBinding,
    content::{ContentOwner, ContentReference, PinKind},
    owner::{self, ExecutionContext},
};
use world_protocol::{ids::ContentId, learning::TestCase, materials::BlobRef};

use super::super::{Error, io, records};

pub(super) async fn read_test_blob(
    ctx: &ExecutionContext,
    binding: &OnlineOracleBinding,
    test: &TestCase,
    blob: &BlobRef,
    stage: &str,
) -> Result<Vec<u8>, owner::Error> {
    let reference = ContentReference::new(
        ContentOwner::TestCase {
            id: test.id.clone(),
            revision: test.revision,
        },
        blob.clone(),
    )?;
    read_blob(ctx, binding, test, reference, stage).await
}

pub(super) async fn read_run_blob(
    ctx: &ExecutionContext,
    plan: &super::OnlineOraclePlan,
    blob: &BlobRef,
) -> Result<Vec<u8>, owner::Error> {
    let reference = ContentReference::new(
        ContentOwner::Run {
            id: plan.binding.run_id.clone(),
        },
        blob.clone(),
    )?;
    read_blob(ctx, &plan.binding, &plan.test, reference, "oracle.restore").await
}

async fn read_blob(
    ctx: &ExecutionContext,
    binding: &OnlineOracleBinding,
    test: &TestCase,
    reference: ContentReference,
    stage: &str,
) -> Result<Vec<u8>, owner::Error> {
    let key = format!("online.{stage}.{}", ctx.admission.invocation().id);
    let template = ctx
        .commit_request(
            &key,
            records::digest(&(binding, &reference))?,
            &["content", "authorization"],
        )
        .await?;
    let pin_id = ContentId::try_new(format!(
        "online-{}",
        &records::digest(&(binding, &key, &reference))?.as_str()[7..]
    ))
    .expect("bounded digest identifier");
    let pinned = reference.clone();
    let auth = ctx.admission.clone();
    let exact = binding.clone();
    let expected = test.clone();
    let pin = io::transact(&ctx.store, &template, "pin", &reference, move |tx| {
        Box::pin(async move {
            let now = tx.now().await?;
            crate::authorization::recheck(tx, &auth, &now).await?;
            owner::require_run_invocation(tx, &auth, &exact.run_id).await?;
            if super::read_online_test(tx, &exact.test).await? != expected {
                return Err(super::changed());
            }
            Ok(crate::content::pin(tx, &pinned, pin_id, PinKind::Read).await?)
        })
    })
    .await?;
    let bytes = ctx.resources.content.read_pinned(&ctx.store, &pin).await;
    let current = pin.value;
    let released = io::transact(&ctx.store, &template, "release", &reference, move |tx| {
        Box::pin(async move {
            crate::content::release_pin(tx, &current).await?;
            Ok(())
        })
    })
    .await;
    match (bytes, released) {
        (Ok(bytes), Ok(_)) => {
            ctx.budget
                .charge(
                    world_protocol::budget::BudgetDimension::Bytes,
                    bytes.len() as u64,
                )
                .map_err(super::program::budget_failure)?;
            Ok(bytes)
        }
        (Err(error), Ok(_)) => Err(error.into()),
        (Ok(_), Err(error)) => Err(error.into()),
        (Err(error), Err(cleanup)) => {
            Err(owner::Error::from(error).with_related(owner::Error::from(cleanup)))
        }
    }
}

pub(super) fn preserve<T>(
    primary: Result<T, Error>,
    cleanup: Result<(), Error>,
) -> Result<T, Error> {
    match (primary, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(Error::Owner(
            owner::Error::from(error).with_related(cleanup.into()),
        )),
    }
}
