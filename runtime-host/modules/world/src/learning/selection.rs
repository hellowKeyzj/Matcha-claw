use super::{Error, invalid};
use crate::store::WorldTransaction;
use world_protocol::{
    authorization::{ActualImpact, PolicyRef},
    bindings::{ActivationLock, BindingNode, PortDirection, SlotKind, TrustClass},
    compiler::{
        CompileRequest, CompileSelection, ExternalContract, ExternalContractKind,
        ExternalContractUse,
    },
    definitions::DefinitionBody,
    ids::ReleaseId,
    learning::SemanticOperation,
    sources::{ChangeStreamCapability, ContractRef, SnapshotCapability, SourceCapability},
};

struct SelectedContract {
    node: BindingNode,
    contract: ContractRef,
    policy: Option<PolicyRef>,
}

struct SelectionContext {
    lock: ActivationLock,
    contracts: Vec<SelectedContract>,
    impact: Option<ActualImpact>,
}

pub(crate) async fn selection_metadata(
    tx: &WorldTransaction<'_>,
    selection: &CompileSelection,
) -> Result<Option<ActualImpact>, Error> {
    Ok(selection_context(tx, selection).await?.impact)
}

/// Selection names durable providers; implementations and model context are never caller claims.
pub(crate) async fn compile_selection(
    tx: &WorldTransaction<'_>,
    base: &ReleaseId,
    operations: &[SemanticOperation],
    selection: &CompileSelection,
) -> Result<CompileRequest, Error> {
    let mut request = crate::releases::read_compile_context(tx, base).await?;
    let materialized = super::materialize_current(
        tx, &request.definitions, &request.scopes, operations,
    ).await?;
    request.definitions = materialized.definitions().to_vec();
    let context = selection_context(tx, selection).await?;
    let mut external_contracts = Vec::with_capacity(context.contracts.len());
    for (index, (selected, resolved)) in selection
        .external_contracts
        .iter()
        .zip(context.contracts)
        .enumerate()
    {
        let failure = || invalid(index, "compile.externalContracts");
        let SelectedContract {
            node,
            contract,
            policy,
        } = resolved;
        let kind = match &selected.kind {
            ExternalContractUse::DefinitionKind { name } => {
                ExternalContractKind::DefinitionKind { name: name.clone() }
            }
            ExternalContractUse::Function { reference } => {
                let reference = materialized.reference(reference);
                if !request.definitions.iter().any(|definition| {
                    definition.reference == reference
                        && matches!(definition.body, DefinitionBody::Function(_))
                }) {
                    return Err(failure());
                }
                ExternalContractKind::Function {
                    reference: reference.clone(),
                }
            }
            ExternalContractUse::Source { binding } => {
                let binding = materialized.reference(binding);
                let definition = request
                    .definitions
                    .iter()
                    .find(|definition| definition.reference == binding)
                    .ok_or_else(failure)?;
                let DefinitionBody::SourceBinding(source) = &definition.body else {
                    return Err(failure());
                };
                if node.provider_id != source.connector || contract != source.capabilities.contract
                {
                    return Err(failure());
                }
                // Model declarations are compile requirements, not native capability attestations.
                let declared = &source.capabilities;
                let capabilities = [
                    (
                        declared.snapshot != SnapshotCapability::None,
                        SourceCapability::Snapshot,
                    ),
                    (declared.historical_read, SourceCapability::History),
                    (
                        declared.change_stream != ChangeStreamCapability::None,
                        SourceCapability::ChangeStream,
                    ),
                    (
                        declared.conditional_write,
                        SourceCapability::ConditionalWrite,
                    ),
                    (declared.idempotency_key, SourceCapability::Idempotency),
                    (declared.inspect_effect, SourceCapability::InspectEffect),
                    (declared.predicate_pushdown, SourceCapability::Filter),
                    (declared.ordering_pushdown, SourceCapability::Sort),
                    (declared.aggregate_pushdown, SourceCapability::Aggregate),
                ]
                .into_iter()
                .filter_map(|(enabled, capability)| enabled.then_some(capability))
                .collect();
                ExternalContractKind::Source {
                    binding: binding.clone(),
                    capabilities,
                }
            }
            ExternalContractUse::Policy { .. } => ExternalContractKind::Policy {
                policy: policy.ok_or_else(failure)?,
            },
            ExternalContractUse::CompilerPass => ExternalContractKind::CompilerPass {
                pass_id: node.provider_id,
            },
        };
        external_contracts.push(ExternalContract {
            contract,
            implementation: node.implementation,
            kind,
        });
    }
    request.activation_lock = context.lock;
    request.external_contracts = external_contracts;
    crate::compiler::validate_structure(&request)?;
    Ok(request)
}

async fn selection_context(
    tx: &WorldTransaction<'_>,
    selection: &CompileSelection,
) -> Result<SelectionContext, Error> {
    let (graph, impact) =
        crate::extensions::bindings::read_activation_metadata(tx, &selection.activation_lock_id)
            .await
            .map_err(crate::owner::Error::from)?;
    let mut contracts: Vec<SelectedContract> =
        Vec::with_capacity(selection.external_contracts.len());
    for (index, selected) in selection.external_contracts.iter().enumerate() {
        let failure = || invalid(index, "compile.externalContracts");
        let node = graph
            .lock()
            .nodes
            .iter()
            .find(|node| node.id == selected.node_id)
            .ok_or_else(failure)?;
        let mut matching = node.ports.iter().filter(|port| {
            port.direction == PortDirection::Export && port.contract.id == selected.contract_id
        });
        let contract = &matching.next().ok_or_else(failure)?.contract;
        if matching.next().is_some()
            || contracts
                .iter()
                .zip(&selection.external_contracts)
                .any(|(previous, input)| {
                    same_use(&input.kind, &previous.node, &selected.kind, node)
                        && (!matches!(selected.kind, ExternalContractUse::DefinitionKind { .. })
                            || previous.contract == *contract)
                })
        {
            return Err(failure());
        }
        let policy = match &selected.kind {
            ExternalContractUse::DefinitionKind { name } => {
                let installed = crate::extensions::package::read_installed_record(
                    tx,
                    &node.implementation.install_id,
                )
                .await
                .map_err(crate::owner::Error::from)?;
                if installed.package_digest != node.implementation.package_digest
                    || !installed.manifest.owned_kinds.iter().any(|kind| {
                        kind.name == *name
                            && [
                                &kind.schema,
                                &kind.validate,
                                &kind.lower,
                                &kind.index,
                                &kind.migrate,
                                &kind.reducer,
                                &kind.lifecycle,
                            ]
                            .contains(&contract)
                    })
                {
                    return Err(failure());
                }
                None
            }
            ExternalContractUse::Function { reference } => {
                if reference.world != *tx.world() {
                    return Err(failure());
                }
                None
            }
            ExternalContractUse::Source { binding } => {
                if binding.world != *tx.world() || node.slot != SlotKind::Connector {
                    return Err(failure());
                }
                None
            }
            ExternalContractUse::Policy {
                policy_id,
                revision,
            } => {
                let policy =
                    crate::authorization::policy_reference(tx, policy_id, *revision).await?;
                if node.slot != SlotKind::Policy || &policy.contract != contract {
                    return Err(failure());
                }
                Some(policy)
            }
            ExternalContractUse::CompilerPass => {
                if node.slot != SlotKind::Compiler || node.trust == TrustClass::OrdinaryGuest {
                    return Err(failure());
                }
                None
            }
        };
        contracts.push(SelectedContract {
            node: node.clone(),
            contract: contract.clone(),
            policy,
        });
    }
    Ok(SelectionContext {
        lock: graph.lock().clone(),
        contracts,
        impact,
    })
}

fn same_use(
    left: &ExternalContractUse,
    left_node: &BindingNode,
    right: &ExternalContractUse,
    right_node: &BindingNode,
) -> bool {
    match (left, right) {
        (
            ExternalContractUse::DefinitionKind { name: left },
            ExternalContractUse::DefinitionKind { name: right },
        ) => left == right,
        (
            ExternalContractUse::Function { reference: left },
            ExternalContractUse::Function { reference: right },
        ) => left == right,
        (
            ExternalContractUse::Source { binding: left },
            ExternalContractUse::Source { binding: right },
        ) => left == right,
        (
            ExternalContractUse::Policy {
                policy_id: left, ..
            },
            ExternalContractUse::Policy {
                policy_id: right, ..
            },
        ) => left == right,
        (ExternalContractUse::CompilerPass, ExternalContractUse::CompilerPass) => {
            left_node.provider_id == right_node.provider_id
        }
        _ => false,
    }
}
