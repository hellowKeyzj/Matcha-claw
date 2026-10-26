use super::{decode, reject};
use crate::store::{StoreError, WorldTransaction};
use std::collections::{BTreeMap, BTreeSet};
use world_protocol::{
    commit::CommitFailure,
    failure::FailureStage,
    ids::*,
    provenance::{
        PremiseRef, ProvenanceFailure, ReadDependency, SupportDeltaProposal, SupportSet,
        SupportStatus,
    },
};

fn assertions(support: &SupportSet) -> impl Iterator<Item = &AssertionRef> {
    support.premises.iter().filter_map(|premise| match premise {
        PremiseRef::Assertion(reference)
        | PremiseRef::Read(ReadDependency::Assertion { reference }) => Some(reference),
        _ => None,
    })
}

async fn component(
    tx: &WorldTransaction<'_>,
    scope: &ScopeId,
    release: &ReleaseId,
    branch: Option<&BranchId>,
    seeds: &BTreeSet<AssertionId>,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(BTreeSet<AssertionId>, BTreeMap<SupportId, SupportSet>), StoreError> {
    let mut nodes = seeds.clone();
    let mut pending = seeds.clone();
    let mut supports = BTreeMap::new();
    while !pending.is_empty() {
        super::checkpoint(budget, cancellation)?;
        let frontier: Vec<_> = (0..128).filter_map(|_| pending.pop_first()).collect();
        for statement in [
            "SELECT r.support_id,r.body FROM world_support_revision r JOIN world_support_head h USING(tenant_id,world_id,support_id,revision) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.scope_id=$3 AND r.release_id=$4 AND r.branch_id IS NOT DISTINCT FROM $5 AND r.status<>'invalid' AND r.conclusion_id=ANY($6) AND r.support_id>$7 ORDER BY r.support_id LIMIT 256",
            "SELECT DISTINCT r.support_id,r.body FROM world_support_premise p JOIN world_support_head h ON h.tenant_id=p.tenant_id AND h.world_id=p.world_id AND h.support_id=p.support_id AND h.revision=p.support_revision JOIN world_support_revision r ON r.tenant_id=h.tenant_id AND r.world_id=h.world_id AND r.support_id=h.support_id AND r.revision=h.revision WHERE p.tenant_id=$1 AND p.world_id=$2 AND r.scope_id=$3 AND r.release_id=$4 AND r.branch_id IS NOT DISTINCT FROM $5 AND r.status<>'invalid' AND p.premise_kind='assertion' AND p.premise_id=ANY($6) AND r.support_id>$7 ORDER BY r.support_id LIMIT 256",
        ] {
            let mut after = String::new();
            let ids: Vec<_> = frontier.iter().map(AssertionId::as_str).collect();
            loop {
                super::checkpoint(budget, cancellation)?;
                let rows = tx
                    .query(
                        statement,
                        &[
                            &tx.world().tenant_id.as_str(),
                            &tx.world().world_id.as_str(),
                            &scope.as_str(),
                            &release.as_str(),
                            &branch.map(BranchId::as_str),
                            &ids,
                            &after,
                        ],
                    )
                    .await?;
                if rows.is_empty() {
                    break;
                }
                for row in rows {
                    super::checkpoint(budget, cancellation)?;
                    after = row.get("support_id");
                    let support: SupportSet = decode(row.get("body"))?;
                    for id in std::iter::once(&support.conclusion.id)
                        .chain(assertions(&support).map(|reference| &reference.id))
                    {
                        if nodes.insert(id.clone()) {
                            pending.insert(id.clone());
                        }
                    }
                    supports.insert(support.reference.id.clone(), support);
                }
            }
        }
    }
    Ok((nodes, supports))
}

pub(super) async fn validate(
    tx: &WorldTransaction<'_>,
    proposal: &SupportDeltaProposal,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(), StoreError> {
    let mut contexts =
        BTreeMap::<(ScopeId, ReleaseId, Option<BranchId>), BTreeSet<AssertionId>>::new();
    for support in &proposal.upserts {
        let nodes = contexts
            .entry((
                support.scope.clone(),
                support.release_id.clone(),
                support.branch_id.clone(),
            ))
            .or_default();
        nodes.insert(support.conclusion.id.clone());
        nodes.extend(assertions(support).map(|reference| reference.id.clone()));
    }
    // Guard identities omit release/branch, so acquire their union in one global order.
    let mut guards = BTreeSet::new();
    let mut components = Vec::new();
    for ((scope, release, branch), seeds) in contexts {
        let (locked, _) = component(
            tx,
            &scope,
            &release,
            branch.as_ref(),
            &seeds,
            budget,
            cancellation,
        )
        .await?;
        guards.extend(locked.iter().cloned().map(|id| (scope.clone(), id)));
        components.push((scope, release, branch, seeds, locked));
    }
    // Lock the reachable component, not just new endpoints: disjoint concurrent edges can close a cycle.
    for (scope, id) in guards {
        super::checkpoint(budget, cancellation)?;
        tx.execute("INSERT INTO world_support_graph_guard(tenant_id,world_id,scope_id,component_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &scope.as_str(), &id.as_str()]).await?;
        tx.query_opt("SELECT generation FROM world_support_graph_guard WHERE tenant_id=$1 AND world_id=$2 AND scope_id=$3 AND component_id=$4 FOR UPDATE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &scope.as_str(), &id.as_str()]).await?;
    }
    for (scope, release, branch, seeds, locked) in components {
        let (current, mut supports) = component(
            tx,
            &scope,
            &release,
            branch.as_ref(),
            &seeds,
            budget,
            cancellation,
        )
        .await?;
        if !current.is_subset(&locked) {
            return Err(StoreError::new(
                CommitFailure::SerializationConflict,
                FailureStage::Validate,
            ));
        }
        for reference in &proposal.invalidate {
            supports.remove(&reference.id);
        }
        for support in &proposal.upserts {
            if support.scope == scope
                && support.release_id == release
                && support.branch_id == branch
            {
                supports.insert(support.reference.id.clone(), support.clone());
            }
        }
        let mut edges: BTreeMap<AssertionRef, BTreeSet<AssertionRef>> = BTreeMap::new();
        for support in supports
            .values()
            .filter(|support| support.status != SupportStatus::Invalid)
        {
            edges
                .entry(support.conclusion.clone())
                .or_default()
                .extend(assertions(support).cloned());
        }
        let mut colors = BTreeMap::<AssertionRef, u8>::new();
        for root in edges.keys() {
            if colors.get(root) == Some(&2) {
                continue;
            }
            let mut stack = vec![(root.clone(), false)];
            while let Some((node, exit)) = stack.pop() {
                super::checkpoint(budget, cancellation)?;
                if exit {
                    colors.insert(node, 2);
                    continue;
                }
                match colors.get(&node) {
                    Some(2) => continue,
                    Some(1) => {
                        return Err(reject(ProvenanceFailure::CyclicSupport {
                            assertions: supports
                                .values()
                                .filter(|support| support.conclusion == node)
                                .map(|support| support.conclusion.clone())
                                .collect(),
                        }));
                    }
                    _ => {}
                }
                colors.insert(node.clone(), 1);
                stack.push((node.clone(), true));
                if let Some(children) = edges.get(&node) {
                    for child in children.iter().rev() {
                        stack.push((child.clone(), false));
                    }
                }
            }
        }
    }
    Ok(())
}
