use std::collections::BTreeSet;

use crate::{
    authorization::{self, Admission},
    store::WorldTransaction,
};
use world_protocol::{
    abstraction::{AbstractionContract, AbstractionFailure, Assurance},
    authorization::{AccessMode, AccessScope, ActualImpact},
    ids::ResourceRef,
};

use super::{Error, abstraction_plan_digest, read_report_plan, records};

/// Consume the evaluator's original plan witnesses, never caller-supplied report IDs alone.
pub(crate) async fn require_abstraction_assurance(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    contract: &AbstractionContract,
) -> Result<Option<ActualImpact>, Error> {
    require_assurance(tx, AssuranceReader::Admitted(admission), contract).await
}

pub(crate) async fn require_abstraction_assurance_read(
    tx: &WorldTransaction<'_>,
    verified: &authorization::VerifiedInvocation,
    contract: &AbstractionContract,
) -> Result<Option<ActualImpact>, Error> {
    require_assurance(tx, AssuranceReader::Read(verified), contract).await
}

#[derive(Clone, Copy)]
enum AssuranceReader<'a> {
    Admitted(&'a Admission),
    Read(&'a authorization::VerifiedInvocation),
}

impl AssuranceReader<'_> {
    async fn current(self, tx: &WorldTransaction<'_>, contract: &AbstractionContract, impact: Option<&ActualImpact>) -> Result<(), Error> {
        match self {
            Self::Admitted(admission) => {
                if let Some(impact) = impact { admission.require_access(impact)?; }
                authorization::recheck(tx, admission, &tx.now().await?).await?;
            }
            Self::Read(verified) => {
                let task = authorization::actual_impact(vec![AccessScope {
                    resources: vec![ResourceRef::Task { id: contract.task_id.clone() }],
                    fields: Vec::new(), modes: vec![AccessMode::Read], scope: contract.scope.clone(), valid_time: None,
                }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?;
                authorization::check_impact_read(tx, verified, impact.unwrap_or(&task), &tx.now().await?).await?;
            }
        }
        Ok(())
    }
}

async fn require_assurance(
    tx: &WorldTransaction<'_>, reader: AssuranceReader<'_>, contract: &AbstractionContract,
) -> Result<Option<ActualImpact>, Error> {
    let unsupported = || {
        Error::Abstraction(Box::new(
            AbstractionFailure::AssuranceUnsupported { requested: contract.assurance }.into(),
        ))
    };
    if contract.assurance == Assurance::Verified {
        crate::abstraction::require_verified(tx, contract).await?;
        reader.current(tx, contract, None).await?;
        return Ok(None);
    }
    if contract.assurance != Assurance::Tested {
        return abstraction_assurance_impact(tx, contract).await;
    }
    if contract.world != *tx.world()
        || contract.evaluation_ids.is_empty()
        || contract.evaluation_ids.iter().collect::<BTreeSet<_>>().len()
            != contract.evaluation_ids.len()
    {
        return Err(unsupported());
    }
    let reference = contract.branch.as_ref().ok_or_else(unsupported)?;
    let branch = crate::releases::read_branch(tx, &reference.id)
        .await
        .map_err(|error| Error::Release(Box::new(error)))?
        .ok_or_else(unsupported)?;
    crate::abstraction::require_branch(tx, contract, &branch).await?;
    let task = records::task(tx, &contract.task_id, contract.task_revision).await?;
    if task.scope != contract.scope {
        return Err(unsupported());
    }
    match reader {
        AssuranceReader::Admitted(admission) => crate::releases::require_evaluations(
            tx, admission, &branch, &task, &contract.evaluation_ids,
        ).await?,
        AssuranceReader::Read(verified) => crate::releases::require_evaluations_read(
            tx, verified, &branch, &task, &contract.evaluation_ids,
        ).await?,
    }
    let plan = abstraction_plan_digest(contract)?;
    for id in &contract.evaluation_ids {
        read_report_plan(tx, id, &branch, &plan).await?;
    }
    let impact = abstraction_assurance_impact(tx, contract).await?
        .ok_or_else(unsupported)?;
    reader.current(tx, contract, Some(&impact)).await?;
    Ok(Some(impact))
}

/// Preadmission derives the same read ceiling without granting or asserting assurance.
pub(crate) async fn abstraction_assurance_impact(
    tx: &WorldTransaction<'_>,
    contract: &AbstractionContract,
) -> Result<Option<ActualImpact>, Error> {
    if contract.assurance != Assurance::Tested {
        return Ok(None);
    }
    if contract.world != *tx.world() || contract.evaluation_ids.is_empty() {
        return Err(Error::Abstraction(Box::new(
            AbstractionFailure::AssuranceUnsupported { requested: contract.assurance }.into(),
        )));
    }
    let mut access = Vec::new();
    let mut labels = Vec::new();
    let mut source_ids = Vec::new();
    let task = records::task(tx, &contract.task_id, contract.task_revision).await?;
    for id in &contract.evaluation_ids {
        let (request, _) = super::read_report(tx, id).await?;
        let read = super::report_impact(tx, id, false).await?;
        access.extend(read.access);
        labels.extend(read.labels);
        source_ids.extend(read.source_ids);
        access.push(AccessScope {
            resources: vec![ResourceRef::Suite { id: request.suite.id }],
            fields: Vec::new(), modes: vec![AccessMode::Read],
            scope: task.scope.clone(), valid_time: None,
        });
    }
    Ok(Some(authorization::actual_impact(
        access, Vec::new(), labels, Vec::new(), source_ids,
    )?))
}
