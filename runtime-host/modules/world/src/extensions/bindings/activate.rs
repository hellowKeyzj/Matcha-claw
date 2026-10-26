use std::collections::BTreeSet;

use world_protocol::{
    api::PackageConfigView,
    authorization::{AccessMode, AccessScope},
    bindings::{BindingChannel, BindingFailure, BindingHead, BindingHeadCas},
    ids::{EventId, ResourceRef},
    operation::{OperationAccepted, OperationResult},
};

use crate::{
    authorization::{self, Admission},
    owner,
    store::WorldTransaction,
};
use super::{BindingError, BindingGraph, durable, guards};

/// All inputs were prepared outside the transaction. This reducer is called once
/// by the publication owner; it cannot spawn a task, compile or perform external I/O.
pub(super) async fn commit_activation(
    tx: &mut WorldTransaction<'_>, graph: &BindingGraph, heads: &[BindingHeadCas],
    channels: &[BindingChannel], configs: &[PackageConfigView],
    namespaces: &[crate::extensions::migration::PreparedNamespace],
    migrations: &[crate::extensions::migration::PreparedMigration],
    install_revision: Option<&world_protocol::api::InstallCommand>,
    source_lock: Option<&world_protocol::ids::ActivationLockId>,
    admission: &Admission, operation: &OperationAccepted,
    event_id: EventId,
) -> Result<Vec<BindingHead>, BindingError> {
    if operation.world != *tx.world() || graph.lock().world != *tx.world() {
        return Err(BindingFailure::HeadInvalid.into());
    }
    tx.require_domain(&world_protocol::ids::WriterDomain::try_new("bindings").expect("fixed binding writer domain"))?;
    let now = tx.now().await?;
    authorization::recheck(tx, admission, &now).await?;
    let current = owner::read_operation(tx, &operation.operation_id).await?;
    if current.accepted != *operation { return Err(BindingFailure::HeadInvalid.into()); }
    let run_id = current.progress.run_id.as_ref().ok_or(BindingFailure::HeadInvalid)?;
    let run = owner::require_run_invocation(tx, admission, run_id).await?;
    if run.operation != *operation { return Err(BindingFailure::HeadInvalid.into()); }
    admission.require_access(&activation_impact(tx, graph, heads).await?)?;
    durable::validate_heads(graph, heads, channels)?;
    if let Some(install) = install_revision {
        crate::extensions::package::require_install_revision(tx, &install.install_id, install.expected_revision).await?;
    }
    if let Some(source_lock) = source_lock {
        let source = durable::read_graph_in_transaction(tx, source_lock).await?;
        for migration in migrations {
            if source.node(&migration.source_node().id)? != migration.source_node() {
                return Err(BindingFailure::StateConflict { node_id: migration.source_node().id.clone() }.into());
            }
        }
    } else if !migrations.is_empty() { return Err(BindingFailure::HeadInvalid.into()); }
    for migration in migrations {
        crate::extensions::migration::publish_state_head(tx, admission, migration).await?;
    }
    for namespace in namespaces {
        crate::extensions::migration::apply_namespace(tx, admission, namespace).await?;
    }
    guards::recheck(tx, graph, configs).await?;
    durable::append_graph(tx, graph).await?;
    crate::extensions::migration::retain_activation_references(tx, &graph.lock().id).await?;
    let published = durable::publish_heads(tx, graph, heads, channels).await?;
    owner::complete_operation(tx, operation, OperationResult::Activation { heads: published.clone() }, &now).await?;
    durable::emit_published(tx, &published, event_id).await?;
    Ok(published)
}

pub(crate) async fn activation_impact(
    tx: &WorldTransaction<'_>, graph: &BindingGraph, heads: &[BindingHeadCas],
) -> Result<world_protocol::authorization::ActualImpact, BindingError> {
    if graph.lock().world != *tx.world() { return Err(BindingFailure::HeadInvalid.into()); }
    let mut resources: BTreeSet<_> = graph.lock().nodes.iter().flat_map(|node| [
        ResourceRef::Binding { id: node.binding_id.clone() },
        ResourceRef::Package { id: node.implementation.install_id.clone() },
    ]).collect();
    resources.extend(heads.iter().map(|head| ResourceRef::Head { channel: head.channel.clone() }));
    resources.extend(graph.lock().nodes.iter().filter_map(|node| node.state.as_ref()
        .map(|state| ResourceRef::State { id: state.root.id.clone() })));
    let management_scope = owner::management_scope(tx).await?;
    Ok(authorization::actual_impact(vec![AccessScope {
        resources: resources.into_iter().collect(), fields: Vec::new(),
        modes: vec![AccessMode::Manage, AccessMode::Publish], scope: management_scope, valid_time: None,
    }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?)
}
