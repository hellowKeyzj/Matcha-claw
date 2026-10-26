use std::collections::BTreeSet;

use world_protocol::{
    bindings::{SlotKind, TrustClass},
    compiler::{
        CompileFailure, CompileRequest, CompilerPassRequest, CompilerPassResult, DependencyTarget,
        ExternalContractKind, TypedIr,
    },
    failure::FieldPath,
    ids::{NodeId, ProviderId},
};

use super::{emit, mandatory};

/// Called only after mandatory checking, before the exact leased SlotRequest::Compiler call.
pub(crate) fn prepare_pass(
    request: &CompileRequest,
    ir: &TypedIr,
    node_id: &NodeId,
    declared_reads: Vec<DependencyTarget>,
    allowed_rewrites: Vec<FieldPath>,
) -> Result<CompilerPassRequest, CompileFailure> {
    let node = request
        .activation_lock
        .nodes
        .iter()
        .find(|node| &node.id == node_id)
        .ok_or_else(|| CompileFailure::ArtifactInvalid {
            field: FieldPath(vec!["compilerPass".into(), "node".into()]),
        })?;
    if node.slot != SlotKind::Compiler
        || node.trust == TrustClass::OrdinaryGuest
        || ir.world != request.world
    {
        return Err(CompileFailure::PassContractInvalid {
            provider_id: node.provider_id.clone(),
        });
    }
    let mut contracts = request.external_contracts.iter().filter(|external| external.implementation == node.implementation
        && matches!(&external.kind, ExternalContractKind::CompilerPass { pass_id } if pass_id == &node.provider_id));
    let external = contracts
        .next()
        .ok_or_else(|| CompileFailure::PassContractInvalid {
            provider_id: node.provider_id.clone(),
        })?;
    if contracts.next().is_some() || !node.implementation.contracts.contains(&external.contract) {
        return Err(CompileFailure::PassContractInvalid {
            provider_id: node.provider_id.clone(),
        });
    }
    for path in &allowed_rewrites {
        let [definitions, index, body, rest @ ..] = path.0.as_slice() else {
            return Err(invalid(&node.provider_id, path));
        };
        if definitions != "definitions" || body != "body" {
            return Err(invalid(&node.provider_id, path));
        }
        let definition = index
            .parse::<usize>()
            .ok()
            .and_then(|index| ir.definitions.get(index))
            .ok_or_else(|| invalid(&node.provider_id, path))?;
        if rest.is_empty()
            || !definition.annotations.iter().any(|annotation| {
                annotation.field.0.as_slice() == rest && annotation.effects.is_empty()
            })
        {
            return Err(invalid(&node.provider_id, path));
        }
    }
    Ok(CompilerPassRequest {
        ir: ir.clone(),
        declared_reads,
        allowed_rewrites,
        invariants: vec![
            "types".into(),
            "effects".into(),
            "scope".into(),
            "policy".into(),
            "source_capabilities".into(),
        ],
        contract: external.contract.clone(),
    })
}

/// A typed plugin response is still a proposal: identities, pure rewrite bounds and every mandatory check run again.
pub(crate) fn postcheck_pass(
    request: &CompileRequest,
    provider_id: &ProviderId,
    pass: &CompilerPassRequest,
    result: CompilerPassResult,
) -> Result<TypedIr, CompileFailure> {
    if result.ir.ir_version != pass.ir.ir_version
        || result.ir.world != pass.ir.world
        || result.ir.definitions.len() != pass.ir.definitions.len()
    {
        return Err(invalid(provider_id, &FieldPath(vec!["ir".into()])));
    }
    if result.diagnostics.iter().any(|diagnostic| {
        diagnostic.severity == world_protocol::compiler::DiagnosticSeverity::Error
    }) {
        return Err(invalid(provider_id, &FieldPath(vec!["diagnostics".into()])));
    }
    for dependency in &result.observed_dependencies {
        if !pass.declared_reads.contains(&dependency.target)
            || !pass
                .ir
                .definitions
                .iter()
                .any(|definition| definition.reference == dependency.dependent)
        {
            return Err(invalid(provider_id, &dependency.selector));
        }
    }
    let mut candidate = request.clone();
    let mut identities = BTreeSet::new();
    for (index, (before, after)) in pass
        .ir
        .definitions
        .iter()
        .zip(&result.ir.definitions)
        .enumerate()
    {
        if before.reference != after.reference
            || before.scope != after.scope
            || before.valid_time != after.valid_time
            || before.policy_refs != after.policy_refs
            || before.source_requirements != after.source_requirements
            || !identities.insert(&after.reference)
        {
            return Err(invalid(
                provider_id,
                &FieldPath(vec!["definitions".into(), index.to_string()]),
            ));
        }
        let before_json =
            serde_json::to_value(&before.body).map_err(|_| CompileFailure::InternalFault)?;
        let after_json =
            serde_json::to_value(&after.body).map_err(|_| CompileFailure::InternalFault)?;
        let mut path = vec!["definitions".into(), index.to_string(), "body".into()];
        // DefinitionBody's serde envelope is not part of expression body paths.
        let before_body = before_json
            .get("body")
            .ok_or(CompileFailure::InternalFault)?;
        let after_body = after_json
            .get("body")
            .ok_or(CompileFailure::InternalFault)?;
        if before_json.get("kind") != after_json.get("kind") {
            return Err(invalid(provider_id, &FieldPath(path)));
        }
        changed_within(
            before_body,
            after_body,
            &mut path,
            &pass.allowed_rewrites,
            provider_id,
        )?;
        let model = candidate
            .definitions
            .iter_mut()
            .find(|model| model.reference == after.reference)
            .ok_or_else(|| invalid(provider_id, &FieldPath(path.clone())))?;
        model.body = after.body.clone();
        model.content_digest = crate::definitions::content_digest(model)
            .map_err(|failure| CompileFailure::Definition { failure })?;
        if model.content_digest != after.body_hash {
            return Err(invalid(provider_id, &FieldPath(path)));
        }
    }
    let mut checked = mandatory(&candidate, None)?;
    for (index, ((before, after), checked)) in pass
        .ir
        .definitions
        .iter()
        .zip(&result.ir.definitions)
        .zip(&checked.definitions)
        .enumerate()
    {
        if after.annotations != checked.annotations {
            return Err(invalid(provider_id, &FieldPath(vec!["annotations".into()])));
        }
        for allowed in &pass.allowed_rewrites {
            if allowed.0.get(1) != Some(&index.to_string()) {
                continue;
            }
            // A containing pure rewrite may eliminate nested expression annotations.
            if pass
                .allowed_rewrites
                .iter()
                .any(|parent| parent.0.len() < allowed.0.len() && allowed.0.starts_with(&parent.0))
            {
                continue;
            }
            let relative = &allowed.0[3..];
            let before = before
                .annotations
                .iter()
                .find(|annotation| annotation.field.0 == relative)
                .ok_or_else(|| invalid(provider_id, allowed))?;
            let after = checked
                .annotations
                .iter()
                .find(|annotation| annotation.field.0 == relative)
                .ok_or_else(|| invalid(provider_id, allowed))?;
            if before.result_type != after.result_type
                || before.nullable != after.nullable
                || before.optional != after.optional
                || before.effects != after.effects
            {
                return Err(invalid(provider_id, allowed));
            }
        }
    }
    for dependency in pass
        .ir
        .dependencies
        .edges
        .iter()
        .cloned()
        .chain(result.observed_dependencies)
    {
        if !checked.dependencies.edges.contains(&dependency) {
            checked.dependencies.edges.push(dependency);
        }
    }
    let _ = emit::json(&checked)?;
    Ok(checked)
}

fn changed_within(
    before: &serde_json::Value,
    after: &serde_json::Value,
    path: &mut Vec<String>,
    allowed: &[FieldPath],
    provider: &ProviderId,
) -> Result<(), CompileFailure> {
    if before == after {
        return Ok(());
    }
    if allowed.iter().any(|allowed| path.starts_with(&allowed.0)) {
        return Ok(());
    }
    match (before, after) {
        (serde_json::Value::Object(before), serde_json::Value::Object(after))
            if before.keys().eq(after.keys()) =>
        {
            for (key, before) in before {
                path.push(key.clone());
                changed_within(before, &after[key], path, allowed, provider)?;
                path.pop();
            }
            Ok(())
        }
        (serde_json::Value::Array(before), serde_json::Value::Array(after))
            if before.len() == after.len() =>
        {
            for (index, (before, after)) in before.iter().zip(after).enumerate() {
                path.push(index.to_string());
                changed_within(before, after, path, allowed, provider)?;
                path.pop();
            }
            Ok(())
        }
        _ => Err(invalid(provider, &FieldPath(path.clone()))),
    }
}

fn invalid(provider: &ProviderId, field: &FieldPath) -> CompileFailure {
    CompileFailure::PassOutputInvalid {
        provider_id: provider.clone(),
        field: field.clone(),
    }
}
