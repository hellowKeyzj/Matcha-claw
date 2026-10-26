// These built-in proposals only import config::read; keep the full WIT, not unused Rust wrappers.
#[cfg(feature = "guest-projection")]
wit_bindgen::generate!({
    path: "../protocol/wit",
    world: "projection-plugin",
    additional_derives: [PartialEq],
    skip: [
        "query",
        "generate",
        "write",
        "now",
        "log",
        "matcha:world/source@1.0.0#read",
        "matcha:world/state@1.0.0#read",
    ],
});
#[cfg(feature = "guest-reconcile")]
wit_bindgen::generate!({
    path: "../protocol/wit",
    world: "reconcile-plugin",
    additional_derives: [PartialEq],
    skip: [
        "query",
        "generate",
        "write",
        "now",
        "log",
        "matcha:world/source@1.0.0#read",
        "matcha:world/state@1.0.0#read",
    ],
});
#[cfg(feature = "guest-oracle")]
wit_bindgen::generate!({
    path: "../protocol/wit",
    world: "evaluation-plugin",
    skip: [
        "read",
        "query",
        "generate",
        "write",
        "now",
        "log",
        "matcha:world/source@1.0.0#read",
        "matcha:world/state@1.0.0#read",
    ],
});
#[cfg(feature = "guest-policy")]
wit_bindgen::generate!({
    path: "../protocol/wit",
    world: "policy-plugin",
    skip: [
        "query",
        "generate",
        "write",
        "now",
        "log",
        "matcha:world/source@1.0.0#read",
        "matcha:world/state@1.0.0#read",
    ],
});

#[cfg(any(
    feature = "guest-projection",
    feature = "guest-reconcile",
    feature = "guest-policy"
))]
use crate::protocol::{
    api::{ConfigValue, package_config_digest},
    component::{ValueArena, ValueField, ValueNode},
};
use matcha::world::types as w;

struct Component;

// Mechanical WIT lowering only; recursive value validity is owned by protocol::component.
#[cfg(any(
    feature = "guest-projection",
    feature = "guest-reconcile",
    feature = "guest-policy"
))]
fn value(value: w::Value) -> Result<crate::protocol::value::Value, ()> {
    let nodes = value
        .nodes
        .into_iter()
        .map(|node| match node {
            w::ValueNode::Null => ValueNode::Null,
            w::ValueNode::Boolean(value) => ValueNode::Boolean { value },
            w::ValueNode::Integer(value) => ValueNode::Integer { value },
            w::ValueNode::Decimal(value) => ValueNode::Decimal { value },
            w::ValueNode::Text(value) => ValueNode::Text { value },
            w::ValueNode::Money(value) => ValueNode::Money {
                amount: value.amount,
                currency: value.currency,
            },
            w::ValueNode::Quantity(value) => ValueNode::Quantity {
                amount: value.amount,
                unit_code: value.unit.code,
                dimension: value.unit.dimension,
            },
            w::ValueNode::Timestamp(value) => ValueNode::Timestamp { value },
            w::ValueNode::Date(value) => ValueNode::Date {
                value: value.value,
                calendar: value.calendar,
            },
            w::ValueNode::Duration(milliseconds) => ValueNode::Duration { milliseconds },
            w::ValueNode::Object(id) => ValueNode::Object { id },
            w::ValueNode::Relation(id) => ValueNode::Relation { id },
            w::ValueNode::List(items) => ValueNode::List { items },
            w::ValueNode::Record(fields) => ValueNode::Record {
                fields: fields
                    .into_iter()
                    .map(|field| ValueField {
                        name: field.name,
                        node: field.node,
                    })
                    .collect(),
            },
        })
        .collect();
    ValueArena {
        nodes,
        root: value.root,
    }
    .into_value()
    .map_err(|_| ())
}

#[cfg(any(
    feature = "guest-projection",
    feature = "guest-reconcile",
    feature = "guest-policy"
))]
fn config_enabled() -> Result<bool, ()> {
    let config = matcha::world::config::read().map_err(|_| ())?;
    let fields = config
        .fields
        .into_iter()
        .map(|field| {
            Ok(ConfigValue {
                name: field.name,
                value: value(field.value)?,
            })
        })
        .collect::<Result<Vec<_>, ()>>()?;
    if package_config_digest(&fields).map_err(|_| ())?.as_str() != config.digest {
        return Err(());
    }
    match fields
        .iter()
        .find(|field| field.name == "enabled")
        .map(|field| &field.value)
    {
        None => Err(()),
        Some(crate::protocol::value::Value::Boolean { value }) => Ok(*value),
        _ => Err(()),
    }
}

#[cfg(any(feature = "guest-projection", feature = "guest-reconcile"))]
mod projection {
    use super::*;

    type RefKey = (String, String, String, u64);
    type FieldKey = ((u8, String), RefKey);

    fn reference_key(reference: &w::RevisionRef) -> RefKey {
        (
            reference.world.tenant_id.clone(),
            reference.world.world_id.clone(),
            reference.id.clone(),
            reference.revision,
        )
    }
    fn field_key(subject: &w::Subject, property: &w::DefinitionRef) -> FieldKey {
        let subject = match subject {
            w::Subject::Object(id) => (0, id.clone()),
            w::Subject::Relation(id) => (1, id.clone()),
        };
        (subject, reference_key(property))
    }

    enum InputFailure {
        Invalid(&'static str),
        Budget,
    }
    impl From<InputFailure> for w::ProjectionFailure {
        fn from(error: InputFailure) -> Self {
            match error {
                InputFailure::Invalid(field) => Self::InvalidInput(vec![field.into()]),
                InputFailure::Budget => Self::BudgetExceeded,
            }
        }
    }
    impl From<InputFailure> for w::ReconcileFailure {
        fn from(error: InputFailure) -> Self {
            match error {
                InputFailure::Invalid(field) => Self::InvalidInput(vec![field.into()]),
                InputFailure::Budget => Self::BudgetExceeded,
            }
        }
    }
    fn charge(steps: &mut u64, amount: usize, budget: &w::Budget) -> Result<(), InputFailure> {
        *steps = steps
            .checked_add(amount as u64)
            .filter(|steps| *steps <= budget.max_steps)
            .ok_or(InputFailure::Budget)?;
        Ok(())
    }

    struct Candidates {
        cell: w::ProjectedCell,
        maximum: Option<u32>,
        positive: Vec<(crate::protocol::value::Value, w::Value)>,
        negative: Vec<crate::protocol::value::Value>,
        assertions: Vec<w::AssertionRef>,
        fallback: Option<w::Cell>,
    }
    impl Candidates {
        fn positive(
            &mut self,
            incoming: &w::Value,
            steps: &mut u64,
            budget: &w::Budget,
        ) -> Result<(), InputFailure> {
            charge(steps, incoming.nodes.len() + self.positive.len(), budget)?;
            let typed = value(incoming.clone()).map_err(|_| InputFailure::Invalid("value"))?;
            if !self.positive.iter().any(|(existing, _)| existing == &typed) {
                self.positive.push((typed, incoming.clone()));
            }
            Ok(())
        }
    }

    // Both phases read the same admitted candidates; only reconciliation decides conflicts.
    fn candidates(
        world: &w::WorldRef,
        definitions: &[w::DefinitionDefinitionBody],
        cells: Vec<w::ProjectedCell>,
        assertions: &[w::Assertion],
        sources: &[w::ProjectionSourceWitness],
        budget: &w::Budget,
    ) -> Result<std::collections::BTreeMap<FieldKey, Candidates>, InputFailure> {
        use std::collections::{BTreeMap, BTreeSet};
        let mut steps = 0;
        let rows = assertions
            .len()
            .checked_add(sources.len())
            .ok_or(InputFailure::Budget)?;
        if rows as u64 > budget.max_rows {
            return Err(InputFailure::Budget);
        }
        let mut properties = BTreeMap::new();
        for definition in definitions {
            charge(&mut steps, 1, budget)?;
            if let w::DefinitionBody::Property(property) = &definition.body {
                if properties
                    .insert(reference_key(&definition.reference), property)
                    .is_some()
                {
                    return Err(InputFailure::Invalid("definitions"));
                }
            }
        }
        let mut fields = BTreeMap::new();
        for cell in cells {
            charge(&mut steps, 1, budget)?;
            if &cell.field.property.world != world || cell.field.property.revision == 0 {
                return Err(InputFailure::Invalid("cells"));
            }
            let property = properties
                .get(&reference_key(&cell.field.property))
                .ok_or(InputFailure::Invalid("definitions"))?;
            let key = field_key(&cell.subject, &cell.field.property);
            if fields
                .insert(
                    key,
                    Candidates {
                        cell,
                        maximum: property.cardinality.maximum,
                        positive: Vec::new(),
                        negative: Vec::new(),
                        assertions: Vec::new(),
                        fallback: None,
                    },
                )
                .is_some()
            {
                return Err(InputFailure::Invalid("cells"));
            }
        }
        let mut references = BTreeSet::new();
        for assertion in assertions {
            charge(&mut steps, 1, budget)?;
            if &assertion.reference.world != world
                || assertion.reference.revision == 0
                || assertion.status != w::AssertionStatus::Accepted
                || !references.insert(reference_key(&assertion.reference))
            {
                return Err(InputFailure::Invalid("assertions"));
            }
            let w::Claim::Attribute(claim) = &assertion.claim else {
                continue;
            };
            let field = fields
                .get_mut(&field_key(&claim.subject, &claim.property))
                .ok_or(InputFailure::Invalid("assertions"))?;
            field.assertions.push(assertion.reference.clone());
            field
                .cell
                .field
                .evidence
                .extend(assertion.evidence.iter().cloned());
            match assertion.polarity {
                w::Polarity::Positive => field.positive(&claim.value, &mut steps, budget)?,
                w::Polarity::Negative => {
                    charge(&mut steps, claim.value.nodes.len(), budget)?;
                    field.negative.push(
                        value(claim.value.clone())
                            .map_err(|_| InputFailure::Invalid("assertions.value"))?,
                    );
                }
            }
        }
        for source in sources {
            charge(&mut steps, 1, budget)?;
            let field = fields
                .get_mut(&field_key(
                    &source.cell.subject,
                    &source.cell.field.property,
                ))
                .ok_or(InputFailure::Invalid("sources"))?;
            field
                .cell
                .field
                .evidence
                .extend(source.cell.field.evidence.iter().cloned());
            match &source.cell.field.cell {
                w::Cell::Known(value) => field.positive(value, &mut steps, budget)?,
                w::Cell::Unknown(_) | w::Cell::SourceUnavailable(_) => {
                    if field.fallback.is_none() {
                        field.fallback = Some(source.cell.field.cell.clone());
                    }
                }
                w::Cell::Conflicted(_) => return Err(InputFailure::Invalid("sources")),
            }
        }
        for field in fields.values_mut() {
            charge(&mut steps, field.cell.field.evidence.len(), budget)?;
            if field
                .cell
                .field
                .evidence
                .iter()
                .any(|reference| &reference.world != world || reference.revision == 0)
            {
                return Err(InputFailure::Invalid("evidence"));
            }
            field.cell.field.evidence.sort_by_key(reference_key);
            field.cell.field.evidence.dedup();
            field.assertions.sort_by_key(reference_key);
            // Charge the exact positive/negative comparisons performed by reconciliation.
            let comparisons = field
                .positive
                .len()
                .checked_mul(field.negative.len())
                .ok_or(InputFailure::Budget)?;
            charge(&mut steps, comparisons, budget)?;
        }
        Ok(fields)
    }

    #[cfg(feature = "guest-projection")]
    fn list(values: Vec<w::Value>) -> Result<w::Value, InputFailure> {
        let mut nodes = Vec::new();
        let mut items = Vec::new();
        for value in values {
            let offset = u32::try_from(nodes.len()).map_err(|_| InputFailure::Budget)?;
            items.push(value.root.checked_add(offset).ok_or(InputFailure::Budget)?);
            for mut node in value.nodes {
                match &mut node {
                    w::ValueNode::List(items) => {
                        for item in items {
                            *item = item.checked_add(offset).ok_or(InputFailure::Budget)?;
                        }
                    }
                    w::ValueNode::Record(fields) => {
                        for field in fields {
                            field.node =
                                field.node.checked_add(offset).ok_or(InputFailure::Budget)?;
                        }
                    }
                    _ => {}
                }
                nodes.push(node);
            }
        }
        let root = u32::try_from(nodes.len()).map_err(|_| InputFailure::Budget)?;
        nodes.push(w::ValueNode::List(items));
        let result = w::Value { nodes, root };
        value(result.clone()).map_err(|_| InputFailure::Budget)?;
        Ok(result)
    }

    #[cfg(feature = "guest-projection")]
    impl exports::matcha::world::projection::Guest for Component {
        fn project(
            request: w::ProjectionRequest,
        ) -> Result<w::ProjectionResult, w::ProjectionFailure> {
            if !config_enabled().map_err(|_| w::ProjectionFailure::InternalFault)? {
                return Err(w::ProjectionFailure::Cancelled);
            }
            let mut fields = candidates(
                &request.world,
                &request.definitions,
                request.cells,
                &request.assertions,
                &request.sources,
                &request.budget,
            )?;
            for fixed in request.fixed {
                let field = fields
                    .get_mut(&field_key(&fixed.subject, &fixed.field.property))
                    .ok_or(InputFailure::Invalid("fixed"))?;
                if !field.positive.is_empty()
                    || !matches!(
                        fixed.field.cell,
                        w::Cell::Unknown(_) | w::Cell::SourceUnavailable(_)
                    )
                {
                    return Err(InputFailure::Invalid("fixed").into());
                }
                field.fallback = Some(fixed.field.cell);
            }
            let mut cells = Vec::with_capacity(fields.len());
            for mut field in fields.into_values() {
                field.cell.field.cell = if field.positive.is_empty() {
                    field
                        .fallback
                        .ok_or(InputFailure::Invalid("cells.witness"))?
                } else if field.maximum == Some(1) {
                    w::Cell::Known(field.positive.remove(0).1)
                } else {
                    w::Cell::Known(list(
                        field.positive.into_iter().map(|(_, wire)| wire).collect(),
                    )?)
                };
                cells.push(field.cell);
            }
            Ok(w::ProjectionResult {
                cells,
                dependencies: request.dependencies,
                diagnostics: Vec::new(),
            })
        }
    }

    #[cfg(feature = "guest-reconcile")]
    impl exports::matcha::world::reconcile::Guest for Component {
        fn reconcile(
            request: w::ReconcileRequest,
        ) -> Result<w::ReconcileResult, w::ReconcileFailure> {
            if !config_enabled().map_err(|_| w::ReconcileFailure::InternalFault)? {
                return Err(w::ReconcileFailure::Cancelled);
            }
            let fields = candidates(
                &request.world,
                &request.definitions,
                request.cells,
                &request.assertions,
                &request.sources,
                &request.budget,
            )?;
            let conflicts = fields
                .into_values()
                .filter_map(|mut field| {
                    let opposing = field
                        .positive
                        .iter()
                        .any(|(value, _)| field.negative.contains(value));
                    let over = field
                        .maximum
                        .is_some_and(|maximum| field.positive.len() as u64 > maximum as u64);
                    if !opposing && !over {
                        return None;
                    }
                    field.cell.field.cell = w::Cell::Conflicted(field.assertions);
                    Some(field.cell)
                })
                .collect();
            Ok(w::ReconcileResult {
                selected: request
                    .assertions
                    .into_iter()
                    .map(|assertion| assertion.reference)
                    .collect(),
                conflicts,
                observations: Vec::new(),
                dependencies: request.dependencies,
            })
        }
    }
}

#[cfg(feature = "guest-oracle")]
impl exports::matcha::world::evaluation::Guest for Component {
    fn evaluate(_request: w::OracleRequest) -> Result<w::OracleResult, w::OracleFailure> {
        // Protected expectations belong to the explicitly trusted oracle process only.
        Err(w::OracleFailure::Unavailable)
    }
}

#[cfg(feature = "guest-policy")]
impl PartialEq for w::PolicyObligation {
    fn eq(&self, other: &Self) -> bool {
        use w::PolicyObligation::*;
        match self {
            Approval => matches!(other, Approval),
            Audit => matches!(other, Audit),
            Redact(left) => matches!(other, Redact(right) if left.fields == right.fields),
            Limit(left) => matches!(other, Limit(right) if left.maximum == right.maximum),
            RevalidateBeforeEffect => matches!(other, RevalidateBeforeEffect),
        }
    }
}

#[cfg(feature = "guest-policy")]
impl exports::matcha::world::policy::Guest for Component {
    fn evaluate(
        request: w::PolicyEvaluationRequest,
    ) -> Result<w::PolicyEvaluationResult, w::AuthorizationFailure> {
        if !config_enabled().map_err(|_| w::AuthorizationFailure::InternalFault)? {
            return Err(w::AuthorizationFailure::InsufficientScope);
        }
        let contract =
            crate::protocol::slots::slot_contract(crate::protocol::bindings::SlotKind::Policy)
                .map_err(|_| w::AuthorizationFailure::InternalFault)?;
        if request.policies.is_empty() {
            return Err(w::AuthorizationFailure::InsufficientScope);
        }
        let mut ids = std::collections::BTreeSet::new();
        let mut obligations = Vec::new();
        let mut approval = false;
        for policy in &request.policies {
            if policy.revision == 0
                || !ids.insert(&policy.policy_id)
                || policy.contract.id != contract.id.as_str()
                || policy.contract.version != contract.version.to_string()
                || policy.contract.schema_digest != contract.schema_digest.as_str()
            {
                return Err(w::AuthorizationFailure::PolicyContractMismatch(
                    policy.contract.id.clone(),
                ));
            }
            for obligation in &policy.obligations {
                approval |= matches!(obligation, w::PolicyObligation::Approval);
                if !obligations.contains(obligation) {
                    obligations.push(obligation.clone());
                }
            }
        }
        // A proposal carries exact obligations; current World authorization still decides access.
        Ok(w::PolicyEvaluationResult {
            verdict: if approval {
                w::PolicyVerdict::NeedsApproval
            } else {
                w::PolicyVerdict::Allow
            },
            obligations,
            policies: request.policies,
        })
    }
}

export!(Component);
