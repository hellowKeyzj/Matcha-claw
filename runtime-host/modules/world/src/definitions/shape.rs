use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    actions::{IdempotencyPolicy, RiskClass, SourceFieldExpression, SourceMutation},
    definitions::{
        Cardinality, DefinitionBody, DefinitionFailure, DefinitionFieldReason as Reason,
    },
    expression::{Effect, ExpressionIr, Parameter, TimeWindow},
    failure::FieldPath,
    learning::StrategyOperation,
    value::ValueType,
};

use super::{invalid, validate_value_type};

fn name(value: &str, path: &[String]) -> Result<(), DefinitionFailure> {
    if value.trim().is_empty() {
        return Err(invalid(path, Reason::Empty));
    }
    if value.len() > 4096 {
        return Err(DefinitionFailure::LimitExceeded {
            field: FieldPath(path.to_vec()),
            maximum: 4096,
        });
    }
    Ok(())
}

fn unique<T: Ord>(
    items: impl IntoIterator<Item = T>,
    path: &[String],
) -> Result<(), DefinitionFailure> {
    let mut seen = BTreeSet::new();
    for item in items {
        if !seen.insert(item) {
            return Err(invalid(path, Reason::Duplicate));
        }
    }
    Ok(())
}

fn cardinality(value: &Cardinality, path: &[String]) -> Result<(), DefinitionFailure> {
    if value.maximum.is_some_and(|maximum| maximum < value.minimum) {
        return Err(DefinitionFailure::InvalidCardinality {
            field: FieldPath(path.to_vec()),
        });
    }
    Ok(())
}

fn parameters(values: &[Parameter]) -> Result<(), DefinitionFailure> {
    unique(
        values.iter().map(|parameter| &parameter.id),
        &["parameters".into()],
    )?;
    for parameter in values {
        validate_value_type(&parameter.value_type)?;
    }
    Ok(())
}

fn effects(values: &[Effect], external: bool) -> Result<(), DefinitionFailure> {
    unique(values, &["effects".into()])?;
    if values.is_empty()
        || (values.contains(&Effect::Pure) && values.len() != 1)
        || (!external && values.contains(&Effect::ExternalWrite))
    {
        return Err(invalid(&["effects".into()], Reason::ImpureExpression));
    }
    Ok(())
}

fn window(value: &TimeWindow) -> Result<(), DefinitionFailure> {
    match value {
        TimeWindow::Fixed { interval }
            if interval.to.as_ref().is_some_and(|to| to <= &interval.from) =>
        {
            Err(invalid(&["window".into()], Reason::InvalidInterval))
        }
        TimeWindow::Sliding { width, .. } if width.0 == 0 => {
            Err(invalid(&["window".into()], Reason::InvalidInterval))
        }
        _ => Ok(()),
    }
}

fn source_fields(
    values: &[SourceFieldExpression],
    slot: &str,
    required: bool,
) -> Result<(), DefinitionFailure> {
    let path = ["sourceOperation".into(), slot.into()];
    if required && values.is_empty() {
        return Err(invalid(&path, Reason::Empty));
    }
    unique(values.iter().map(|value| &value.field), &path)?;
    for value in values {
        validate_expression(&value.expression)?;
    }
    Ok(())
}

pub(super) fn validate_body(body: &DefinitionBody) -> Result<(), DefinitionFailure> {
    match body {
        DefinitionBody::Extension(body) => {
            name(&body.name, &["name".into()])?;
            let mut pending = vec![(&body.payload, 0)];
            let mut count = 0;
            while let Some((value, depth)) = pending.pop() {
                count += 1;
                if depth > 64 || count > 65_536 {
                    return Err(DefinitionFailure::LimitExceeded {
                        field: FieldPath(vec!["payload".into()]), maximum: 65_536,
                    });
                }
                match value {
                    world_protocol::value::Value::List { items } =>
                        pending.extend(items.iter().map(|value| (value, depth + 1))),
                    world_protocol::value::Value::Record { fields } => {
                        for (key, value) in fields {
                            name(key, &["payload".into()])?;
                            pending.push((value, depth + 1));
                        }
                    }
                    world_protocol::value::Value::Date { calendar, .. } => super::validate_value(
                        &ValueType::Date { calendar: calendar.clone() }, false, value)?,
                    world_protocol::value::Value::Text { value } if value.len() > 1_048_576 => {
                        return Err(DefinitionFailure::LimitExceeded {
                            field: FieldPath(vec!["payload".into()]), maximum: 1_048_576,
                        });
                    }
                    _ => {}
                }
            }
        }
        DefinitionBody::ObjectType(body) => {
            name(&body.name, &["name".into()])?;
            unique(&body.properties, &["properties".into()])?;
            unique(&body.interfaces, &["interfaces".into()])?;
            unique(&body.source_bindings, &["sourceBindings".into()])?;
        }
        DefinitionBody::Property(body) => {
            name(&body.name, &["name".into()])?;
            if body.domain.is_empty() {
                return Err(invalid(&["domain".into()], Reason::Empty));
            }
            unique(&body.domain, &["domain".into()])?;
            unique(&body.access_labels, &["accessLabels".into()])?;
            cardinality(&body.cardinality, &["cardinality".into()])?;
            validate_value_type(&body.value_type)?;
        }
        DefinitionBody::RelationType(body) => {
            name(&body.name, &["name".into()])?;
            if body.roles.is_empty() {
                return Err(invalid(&["roles".into()], Reason::Empty));
            }
            unique(body.roles.iter().map(|role| &role.id), &["roles".into()])?;
            unique(&body.properties, &["properties".into()])?;
            for role in &body.roles {
                name(
                    &role.name,
                    &["roles".into(), role.id.to_string(), "name".into()],
                )?;
                cardinality(
                    &role.cardinality,
                    &["roles".into(), role.id.to_string(), "cardinality".into()],
                )?;
            }
        }
        DefinitionBody::Facet(body) => {
            name(&body.name, &["name".into()])?;
            if body.attaches_to.is_empty() {
                return Err(invalid(&["attachesTo".into()], Reason::Empty));
            }
            unique(&body.attaches_to, &["attachesTo".into()])?;
            unique(&body.definitions, &["definitions".into()])?;
            validate_expression(&body.applicability)?;
        }
        DefinitionBody::ConceptView(body) => {
            name(&body.name, &["name".into()])?;
            unique(&body.inputs, &["inputs".into()])?;
            query(&body.query)?;
        }
        DefinitionBody::Rule(body) => {
            name(&body.name, &["name".into()])?;
            parameters(&body.parameters)?;
            effects(&body.effects, false)?;
            validate_expression(&body.condition)?;
            match &body.conclusion {
                world_protocol::definitions::RuleConclusion::Attribute {
                    subject, value, ..
                } => {
                    validate_expression(subject)?;
                    validate_expression(value)?;
                }
                world_protocol::definitions::RuleConclusion::Relation {
                    relation, roles, ..
                } => {
                    validate_expression(relation)?;
                    if roles.is_empty() {
                        return Err(invalid(
                            &["conclusion".into(), "roles".into()],
                            Reason::Empty,
                        ));
                    }
                    unique(
                        roles.iter().map(|role| &role.role),
                        &["conclusion".into(), "roles".into()],
                    )?;
                    for role in roles {
                        validate_expression(&role.object)?;
                    }
                }
            }
        }
        DefinitionBody::Metric(body) => {
            name(&body.name, &["name".into()])?;
            parameters(&body.parameters)?;
            validate_value_type(&body.result_type)?;
            validate_expression(&body.expression)?;
            unique(&body.grain, &["grain".into()])?;
            if let Some(value) = &body.window {
                window(value)?;
            }
            if let Some(unit) = &body.unit {
                match &body.result_type {
                    ValueType::Quantity { unit: result } if unit == result => {}
                    _ => {
                        return Err(DefinitionFailure::UnitMismatch {
                            field: FieldPath(vec!["unit".into()]),
                        });
                    }
                }
            }
        }
        DefinitionBody::Function(body) => {
            name(&body.name, &["name".into()])?;
            parameters(&body.parameters)?;
            validate_value_type(&body.result_type)?;
            effects(&body.effects, false)?;
            if body.max_evaluations == 0 {
                return Err(invalid(
                    &["maxEvaluations".into()],
                    Reason::IncompleteContract,
                ));
            }
            validate_expression(&body.expression)?;
        }
        DefinitionBody::StateModel(body) => {
            name(&body.name, &["name".into()])?;
            if body.states.is_empty() {
                return Err(invalid(&["states".into()], Reason::Empty));
            }
            unique(
                body.states.iter().map(|state| &state.id),
                &["states".into()],
            )?;
            let states: BTreeMap<_, _> =
                body.states.iter().map(|state| (&state.id, state)).collect();
            for state in &body.states {
                name(&state.name, &["states".into(), state.id.to_string()])?;
            }
            for transition in &body.transitions {
                if states
                    .get(&transition.from)
                    .is_none_or(|state| state.terminal)
                    || !states.contains_key(&transition.to)
                    || (transition.action.is_none()
                        && transition
                            .source_constraint
                            .as_ref()
                            .is_none_or(|value| value.trim().is_empty()))
                {
                    return Err(invalid(&["transitions".into()], Reason::InvalidTransition));
                }
                validate_expression(&transition.guard)?;
            }
        }
        DefinitionBody::ActionContract(body) => {
            name(&body.name, &["name".into()])?;
            parameters(&body.parameters)?;
            validate_value_type(&body.result_type)?;
            effects(&body.effects, true)?;
            unique(&body.reads, &["reads".into()])?;
            unique(&body.writes, &["writes".into()])?;
            unique(
                body.targets.iter().map(|target| &target.parameter_id),
                &["targets".into()],
            )?;
            for target in &body.targets {
                if !body
                    .parameters
                    .iter()
                    .any(|parameter| parameter.id == target.parameter_id)
                {
                    return Err(invalid(&["targets".into()], Reason::IncompleteContract));
                }
            }
            if !body.writes.is_empty()
                && (!body.effects.contains(&Effect::ExternalWrite)
                    || body.risk == RiskClass::ReadOnly)
            {
                return Err(invalid(&["writes".into()], Reason::IncompleteContract));
            }
            if body.risk != RiskClass::ReadOnly && !body.verifier.require_authoritative {
                return Err(invalid(&["verifier".into()], Reason::IncompleteContract));
            }
            if body.verifier.maximum_attempts == 0 {
                return Err(invalid(&["verifier".into()], Reason::IncompleteContract));
            }
            name(
                &body.source_operation.resource,
                &["sourceOperation".into(), "resource".into()],
            )?;
            let conditional = match &body.source_operation.mutation {
                SourceMutation::Insert { values } => {
                    source_fields(values, "values", true)?;
                    false
                }
                SourceMutation::Update {
                    keys,
                    values,
                    expected,
                } => {
                    source_fields(keys, "keys", true)?;
                    source_fields(values, "values", true)?;
                    source_fields(expected, "expected", false)?;
                    !expected.is_empty()
                }
                SourceMutation::Delete { keys, expected } => {
                    source_fields(keys, "keys", true)?;
                    source_fields(expected, "expected", false)?;
                    !expected.is_empty()
                }
            };
            if body.idempotency == IdempotencyPolicy::ConditionalWrite && !conditional {
                return Err(invalid(
                    &["sourceOperation".into(), "expected".into()],
                    Reason::Empty,
                ));
            }
            for expression in &body.preconditions {
                validate_expression(expression)?;
            }
            validate_expression(&body.expected_effect)?;
            query(&body.verifier.query)?;
            validate_expression(&body.verifier.expected)?;
            if let Some(compensation) = &body.compensation {
                unique(
                    compensation.arguments.iter().map(|argument| &argument.name),
                    &["compensation".into(), "arguments".into()],
                )?;
                for argument in &compensation.arguments {
                    validate_expression(&argument.expression)?;
                }
                for expression in &compensation.preconditions {
                    validate_expression(expression)?;
                }
            }
            budget(&body.budget)?;
        }
        DefinitionBody::Strategy(body) => {
            name(&body.name, &["name".into()])?;
            parameters(&body.parameters)?;
            validate_expression(&body.guard)?;
            unique(body.steps.iter().map(|step| &step.id), &["steps".into()])?;
            let mut resolved = BTreeSet::new();
            while resolved.len() < body.steps.len() {
                let before = resolved.len();
                for step in &body.steps {
                    unique(
                        &step.depends_on,
                        &["steps".into(), step.id.to_string(), "dependsOn".into()],
                    )?;
                    if step
                        .depends_on
                        .iter()
                        .all(|dependency| resolved.contains(dependency))
                    {
                        resolved.insert(step.id.clone());
                    }
                }
                if before == resolved.len() {
                    return Err(invalid(&["steps".into()], Reason::IncompleteContract));
                }
            }
            for step in &body.steps {
                validate_expression(&step.guard)?;
                match &step.operation {
                    StrategyOperation::Query { query: value } => query(value)?,
                    StrategyOperation::Function { arguments, .. } => {
                        for argument in arguments {
                            validate_expression(argument)?;
                        }
                    }
                    _ => {}
                }
            }
            budget(&body.budget)?;
        }
        DefinitionBody::PolicyBinding(body) => {
            name(&body.name, &["name".into()])?;
            if body.access.is_empty() || body.applies_to.is_empty() || body.policy.revision.0 == 0 {
                return Err(invalid(&["policy".into()], Reason::IncompleteContract));
            }
            unique(&body.access, &["access".into()])?;
            unique(&body.applies_to, &["appliesTo".into()])?;
            unique(&body.labels, &["labels".into()])?;
            validate_expression(&body.predicate)?;
        }
        DefinitionBody::SourceBinding(body) => {
            name(&body.namespace, &["namespace".into()])?;
            name(&body.resource, &["resource".into()])?;
            name(&body.incarnation, &["incarnation".into()])?;
            unique(&body.selected_fields, &["selectedFields".into()])?;
            unique(
                body.field_modes.iter().map(|mode| &mode.field_id),
                &["fieldModes".into()],
            )?;
            if body
                .field_modes
                .iter()
                .any(|mode| !body.selected_fields.contains(&mode.field_id))
                || body.schema.revision.0 == 0
                || body.mapping.revision.0 == 0
                || body.identity_rule.revision.0 == 0
            {
                return Err(invalid(
                    &["sourceBinding".into()],
                    Reason::IncompleteContract,
                ));
            }
            if body.connection_revision.0 == 0
                || body.authority.revision.0 == 0
                || body.retention.revision.0 == 0
                || body.identity_mapping.key_fields.is_empty()
            {
                return Err(invalid(
                    &["sourceBinding".into()],
                    Reason::IncompleteContract,
                ));
            }
            unique(
                &body.identity_mapping.key_fields,
                &["identityMapping".into(), "keyFields".into()],
            )?;
            for key in &body.identity_mapping.key_fields {
                name(key, &["identityMapping".into(), "keyFields".into()])?;
            }
            unique(
                body.field_mapping.iter().map(|mapping| &mapping.property),
                &["fieldMapping".into()],
            )?;
            unique(
                body.role_mapping.iter().map(|mapping| &mapping.role),
                &["roleMapping".into()],
            )?;
            for mapping in &body.field_mapping {
                name(
                    &mapping.source_field,
                    &["fieldMapping".into(), "sourceField".into()],
                )?;
                validate_value_type(&mapping.source_type)?;
                match &mapping.transform {
                    Some(world_protocol::sources::SourceTransform::Quantity { unit }) => {
                        validate_value_type(&ValueType::Quantity { unit: unit.clone() })?
                    }
                    Some(world_protocol::sources::SourceTransform::Date { calendar }) => {
                        validate_value_type(&ValueType::Date {
                            calendar: calendar.clone(),
                        })?
                    }
                    _ => {}
                }
            }
            for mapping in &body.role_mapping {
                name(
                    &mapping.source_field,
                    &["roleMapping".into(), "sourceField".into()],
                )?;
            }
            if let world_protocol::sources::SyncPolicy::Poll { interval } = &body.sync {
                if interval.0 == 0 {
                    return Err(invalid(&["sync".into()], Reason::InvalidInterval));
                }
            }
        }
    }
    Ok(())
}

fn budget(value: &world_protocol::budget::Budget) -> Result<(), DefinitionFailure> {
    if value.max_steps == 0
        || value.max_wall_time.0 == 0
        || value
            .max_cost
            .as_ref()
            .is_some_and(|cost| cost.amount.as_str().starts_with('-'))
    {
        return Err(invalid(&["budget".into()], Reason::IncompleteContract));
    }
    Ok(())
}

pub(crate) fn validate_expression(expression: &ExpressionIr) -> Result<(), DefinitionFailure> {
    let mut pending = vec![(expression, 0)];
    let mut count = 0;
    while let Some((expression, depth)) = pending.pop() {
        count += 1;
        if depth > 64 || count > 65_536 {
            return Err(DefinitionFailure::LimitExceeded {
                field: FieldPath(vec!["expression".into()]),
                maximum: 65_536,
            });
        }
        match expression {
            ExpressionIr::Unary { operand, .. }
            | ExpressionIr::IsNull { operand }
            | ExpressionIr::IsKnown { operand } => pending.push((operand, depth + 1)),
            ExpressionIr::Binary { left, right, .. } => {
                pending.push((left, depth + 1));
                pending.push((right, depth + 1));
            }
            ExpressionIr::All { terms }
            | ExpressionIr::Any { terms }
            | ExpressionIr::Call {
                arguments: terms, ..
            } => pending.extend(terms.iter().map(|term| (term, depth + 1))),
            ExpressionIr::If {
                condition,
                then_value,
                else_value,
            } => pending.extend(
                [condition.as_ref(), then_value.as_ref(), else_value.as_ref()]
                    .map(|term| (term, depth + 1)),
            ),
            ExpressionIr::Aggregate {
                expression,
                window: value,
                ..
            } => {
                pending.push((expression, depth + 1));
                if let Some(value) = value {
                    window(value)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn query(value: &world_protocol::query::QueryIr) -> Result<(), DefinitionFailure> {
    use world_protocol::query::QueryNode;
    parameters(&value.parameters)?;
    unique(
        value.output.iter().map(|column| &column.name),
        &["output".into()],
    )?;
    for column in &value.output {
        validate_expression(&column.expression)?;
    }
    let mut pending = vec![(&value.root, 0)];
    let mut count = 0;
    while let Some((node, depth)) = pending.pop() {
        count += 1;
        if depth > 64 || count > 65_536 {
            return Err(DefinitionFailure::LimitExceeded {
                field: FieldPath(vec!["query".into()]),
                maximum: 65_536,
            });
        }
        match node {
            QueryNode::Objects { .. } | QueryNode::Relations { .. } => {}
            QueryNode::Filter { input, predicate } => {
                pending.push((input, depth + 1));
                validate_expression(predicate)?;
            }
            QueryNode::Join {
                left, right, on, ..
            } => {
                pending.extend([(left.as_ref(), depth + 1), (right.as_ref(), depth + 1)]);
                validate_expression(on)?;
            }
            QueryNode::Traverse { input, .. }
            | QueryNode::Distinct { input }
            | QueryNode::Limit { input, .. } => pending.push((input, depth + 1)),
            QueryNode::Project { input, columns } => {
                pending.push((input, depth + 1));
                for column in columns {
                    validate_expression(&column.expression)?;
                }
            }
            QueryNode::Aggregate {
                input,
                group_by,
                aggregates,
            } => {
                pending.push((input, depth + 1));
                for column in group_by {
                    validate_expression(&column.expression)?;
                }
                for aggregate in aggregates {
                    validate_expression(&aggregate.expression)?;
                }
            }
            QueryNode::Sort { input, order } => {
                pending.push((input, depth + 1));
                for order in order {
                    validate_expression(&order.expression)?;
                }
            }
            QueryNode::Union { inputs } => {
                pending.extend(inputs.iter().map(|input| (input, depth + 1)))
            }
            QueryNode::NotExists {
                input,
                correlated,
                predicate,
            } => {
                pending.extend([
                    (input.as_ref(), depth + 1),
                    (correlated.as_ref(), depth + 1),
                ]);
                validate_expression(predicate)?;
            }
        }
    }
    Ok(())
}
