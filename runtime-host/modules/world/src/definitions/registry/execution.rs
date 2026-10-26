use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    bindings::{BindingNode, PortDirection, SlotKind},
    compiler::CompileRequest,
    definitions::{DefinitionBody, DefinitionFailure, DefinitionLifecycle, KindOperation, KindRequest,
        KindResponse, KindResult, KindVerb},
    ids::{Digest, NodeId, ResourceRef},
    package::{InstalledRecord, KindContract},
};

use super::{KindRegistry, Model, Reason, invalid};
use crate::{authorization::{self, Admission}, extensions::bindings::BindingGraph,
    releases::Error, store::WorldTransaction};

/// Original claim input, not a registration or permission to invoke a package later.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KindPlan {
    request_digest: Digest,
    node: BindingNode,
    kind: KindContract,
    definition: Model,
    previous: Option<Model>,
}

impl KindPlan {
    pub(crate) fn node(&self) -> &NodeId { &self.node.id }
    pub(crate) fn contract(&self) -> &KindContract { &self.kind }
    pub(crate) fn definition(&self) -> &Model { &self.definition }
    pub(crate) fn previous(&self) -> Option<&Model> { self.previous.as_ref() }

    pub(crate) fn requests(&self, request: &CompileRequest) -> Vec<KindRequest> {
        let verb = match self.definition.lifecycle {
            DefinitionLifecycle::Deprecated { .. } => KindVerb::Deprecate,
            DefinitionLifecycle::Split { .. } => KindVerb::Split,
            DefinitionLifecycle::Available if self.previous.is_some() => KindVerb::Refine,
            DefinitionLifecycle::Available => KindVerb::Create,
        };
        [KindOperation::Validate, KindOperation::Lower, KindOperation::Index,
            KindOperation::Migrate, KindOperation::Reducer { verb }, KindOperation::Lifecycle]
            .into_iter().map(|operation| KindRequest {
                kind: self.kind.clone(), definition: self.definition.clone(),
                previous: self.previous.clone(), definitions: request.definitions.clone(),
                scopes: request.scopes.clone(), operation,
            }).collect()
    }
}

/// Six exact handler proposals checked by the owner; compiler still checks the lowered standard IR.
#[derive(Clone)]
pub(crate) struct CheckedKind {
    plan: KindPlan,
    lowered: DefinitionBody,
}
impl CheckedKind {
    pub(crate) fn definition(&self) -> &Model { &self.plan.definition }
    pub(crate) fn lowered(&self) -> &DefinitionBody { &self.lowered }
}

impl KindRegistry {
    pub(crate) async fn plan(
        tx: &WorldTransaction<'_>, admission: &Admission, request: &CompileRequest,
    ) -> Result<Vec<KindPlan>, Error> {
        if tx.world() != &request.world || admission.invocation().world != request.world {
            return Err(rejected().into());
        }
        let graph = BindingGraph::validate(request.activation_lock.clone())
            .map_err(crate::extensions::bindings::BindingError::from)?;
        let request_digest = super::super::canonical_digest(request)?;
        let mut plans = Vec::new();
        for definition in &request.definitions {
            let DefinitionBody::Extension(body) = &definition.body else { continue };
            super::super::shape::validate_body(&definition.body)?;
            if super::super::content_digest(definition)? != definition.content_digest {
                return Err(rejected().into());
            }
            let mut selected = None;
            for node in graph.lock().nodes.iter().filter(|node| node.slot == SlotKind::Schema
                && node.implementation.contracts.contains(&body.contract)
                && node.ports.iter().any(|port| port.direction == PortDirection::Export
                    && port.contract == body.contract)) {
                let installed = crate::extensions::package::read_installed_record(
                    tx, &node.implementation.install_id).await?;
                let Some(kind) = installed.manifest.owned_kinds.iter().find(|kind|
                    kind.name == body.name && kind.schema == body.contract) else { continue };
                require_handler(node, kind, &installed)?;
                if selected.replace((node.clone(), kind.clone())).is_some() {
                    return Err(rejected().into());
                }
            }
            let (node, kind) = selected.ok_or_else(|| DefinitionFailure::ProviderMissing {
                contract_id: body.contract.id.clone(),
            })?;
            let previous = match &definition.previous_ref {
                Some(reference) => Some(crate::releases::read_definition_exact(tx, reference).await?
                    .ok_or_else(|| DefinitionFailure::MissingReference { reference: reference.clone() })?),
                None => None,
            };
            super::super::validate_revision(previous.as_ref(), definition)?;
            if let Some(previous) = &previous {
                let impact = crate::releases::model_impact(tx, std::slice::from_ref(previous),
                    Vec::new(), &[AccessMode::Read]).await?;
                admission.require_access(&impact)?;
            }
            let mut resources = Vec::new();
            for id in graph.closure_nodes(&node.id)
                .map_err(crate::extensions::bindings::BindingError::from)? {
                let selected = graph.node(&id).map_err(crate::extensions::bindings::BindingError::from)?;
                crate::extensions::invocation::check_node_in_transaction(tx, admission, selected)
                    .await.map_err(current_error)?;
                resources.push(ResourceRef::Binding { id: selected.binding_id.clone() });
            }
            let impact = authorization::actual_impact(vec![AccessScope {
                resources, fields: Vec::new(), modes: vec![AccessMode::Execute],
                scope: definition.scope.clone(), valid_time: None,
            }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?;
            admission.require_access(&impact)?;
            plans.push(KindPlan { request_digest: request_digest.clone(), node, kind,
                definition: definition.clone(), previous });
        }
        authorization::recheck(tx, admission, &tx.now().await?).await?;
        Self::validate_plans(request, &plans)?;
        Ok(plans)
    }

    pub(crate) fn validate_plans(
        request: &CompileRequest, plans: &[KindPlan],
    ) -> Result<(), DefinitionFailure> {
        let digest = super::super::canonical_digest(request)?;
        let extensions: Vec<_> = request.definitions.iter()
            .filter(|definition| matches!(definition.body, DefinitionBody::Extension(_))).collect();
        let mut seen = BTreeSet::new();
        if extensions.len() != plans.len() { return Err(rejected()) }
        for plan in plans {
            let DefinitionBody::Extension(body) = &plan.definition.body else { return Err(rejected()) };
            if plan.request_digest != digest || !extensions.contains(&&plan.definition)
                || !seen.insert(&plan.definition.reference)
                || !request.activation_lock.nodes.contains(&plan.node)
                || plan.kind.standard_kind.is_some() || plan.kind.name != body.name
                || plan.kind.schema != body.contract
                || plan.previous.as_ref().map(|previous| &previous.reference)
                    != plan.definition.previous_ref.as_ref() {
                return Err(rejected());
            }
            super::super::validate_revision(plan.previous.as_ref(), &plan.definition)?;
        }
        Ok(())
    }

    pub(crate) fn check_results(
        request: &CompileRequest, plan: &KindPlan, results: &[KindResponse],
    ) -> Result<CheckedKind, DefinitionFailure> {
        if plan.request_digest != super::super::canonical_digest(request)?
            || !request.definitions.contains(&plan.definition) { return Err(rejected()) }
        let calls = plan.requests(request);
        if results.len() != calls.len() { return Err(rejected()) }
        let mut lowered = None;
        for (call, response) in calls.iter().zip(results) {
            if &response.contract != call.contract() { return Err(rejected()) }
            match (&call.operation, &response.result) {
                (KindOperation::Validate, KindResult::Validated)
                | (KindOperation::Lifecycle, KindResult::LifecycleChecked) => {}
                (KindOperation::Lower, KindResult::Lowered { body }) => {
                    if matches!(body, DefinitionBody::Extension(_)) { return Err(rejected()) }
                    super::super::shape::validate_body(body)?;
                    let mut allowed = super::super::definition_resources(&plan.definition.body);
                    allowed.extend(plan.definition.dependencies.iter().map(|reference|
                        ResourceRef::Definition { id: reference.id.clone() }));
                    if super::super::definition_resources(body).iter().any(|resource| !allowed.contains(resource)) {
                        return Err(rejected());
                    }
                    lowered = Some(body.clone());
                }
                (KindOperation::Index, KindResult::Indexed { dependencies }) => {
                    let indexed: BTreeSet<_> = dependencies.iter().collect();
                    let admitted: BTreeSet<_> = plan.definition.dependencies.iter().collect();
                    if indexed.len() != dependencies.len() || indexed != admitted { return Err(rejected()) }
                }
                (KindOperation::Migrate, KindResult::Migrated { definition })
                | (KindOperation::Reducer { .. }, KindResult::Reduced { definition })
                    if definition == &plan.definition => {}
                _ => return Err(rejected()),
            }
        }
        super::super::validate_revision(plan.previous.as_ref(), &plan.definition)?;
        Ok(CheckedKind { plan: plan.clone(), lowered: lowered.ok_or_else(rejected)? })
    }

    pub(crate) async fn recheck(
        tx: &WorldTransaction<'_>, admission: &Admission, request: &CompileRequest,
        checked: &[CheckedKind],
    ) -> Result<(), Error> {
        let current = Self::plan(tx, admission, request).await?;
        if current.len() != checked.len() || current.iter().zip(checked)
            .any(|(plan, checked)| plan != &checked.plan) { return Err(rejected().into()) }
        Ok(())
    }
}

fn require_handler(
    node: &BindingNode, kind: &KindContract, installed: &InstalledRecord,
) -> Result<(), DefinitionFailure> {
    let implementation = &node.implementation;
    if kind.standard_kind.is_some() || node.slot != SlotKind::Schema
        || installed.package_digest != implementation.package_digest
        || installed.lock.digest != implementation.dependency_lock
        || !installed.manifest.artifacts.iter().any(|artifact| artifact.id == implementation.artifact_id
            && artifact.kind == world_protocol::package::ArtifactKind::Implementation
            && artifact.digest == implementation.artifact_digest && artifact.entrypoint == implementation.entrypoint)
    { return Err(rejected()) }
    let contracts = [&kind.schema, &kind.validate, &kind.lower, &kind.index,
        &kind.migrate, &kind.reducer, &kind.lifecycle];
    let provided = installed.manifest.provides.iter().any(|provided|
        provided.provider_id == node.provider_id && provided.slot == SlotKind::Schema
        && provided.artifact_id == implementation.artifact_id && provided.trust == node.trust
        && contracts.iter().all(|contract| provided.contracts.contains(contract)));
    if !provided { return Err(rejected()) }
    let declaration = installed.manifest.contracts.iter().find(|declaration|
        declaration.reference == kind.schema).ok_or_else(rejected)?;
    let expected = world_protocol::slots::kind_schema_port(declaration);
    let exports: Vec<_> = node.ports.iter().filter(|port|
        port.direction == PortDirection::Export && port.contract == kind.schema).collect();
    if exports.as_slice() != [&expected] { return Err(rejected()) }
    for contract in contracts {
        if !implementation.contracts.contains(contract)
            || !installed.manifest.contracts.iter().any(|declared| &declared.reference == contract)
            || !node.ports.iter().any(|port| port.direction == PortDirection::Export
                && &port.contract == contract) {
            return Err(DefinitionFailure::ProviderMissing { contract_id: contract.id.clone() });
        }
    }
    for contract in [&kind.validate, &kind.lower, &kind.index, &kind.migrate, &kind.reducer, &kind.lifecycle] {
        let expected = world_protocol::slots::kind_port(contract).map_err(|_| rejected())?;
        let exports: Vec<_> = node.ports.iter().filter(|port|
            port.direction == PortDirection::Export && &port.contract == contract).collect();
        if exports.as_slice() != [&expected] { return Err(rejected()) }
    }
    Ok(())
}

fn current_error(error: crate::extensions::invocation::CurrentFailure) -> Error {
    use crate::extensions::invocation::CurrentFailure;
    match error {
        CurrentFailure::Authorization(error) => error.into(),
        CurrentFailure::Store(error) => error.into(),
        CurrentFailure::Package(error) => error.into(),
        CurrentFailure::Binding(error) => crate::extensions::bindings::BindingError::from(error).into(),
    }
}

fn rejected() -> DefinitionFailure {
    invalid(&["kindHandler".into()], Reason::IncompleteContract)
}
