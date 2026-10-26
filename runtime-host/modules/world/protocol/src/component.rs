//! WIT has no recursive values. These canonical postorder trees are the single host/guest lowering.
mod invocation_failure;
mod source_failure;
use crate::{
    expression::{AggregateOperator, BinaryOperator, ExpressionIr, TimeWindow, UnaryOperator},
    ids::{DefinitionId, DefinitionRef, ObjectId, ParameterId, RelationId, RoleId, SymbolId},
    time::Timestamp,
    value::{Currency, Decimal, RecordField, Unit, Value, ValueType},
};
pub use invocation_failure::{
    ActionFailureNode, HostFailureNode, OperationFailureNode, QueryFailureNode, ReleaseFailureNode,
    SlotFailureNode,
};
use serde::{Deserialize, Serialize};
pub use source_failure::{
    ReleaseFailureLeaf, SourceFailureArena, SourceFailureLeaf, SourceFailureNode,
};
use std::collections::{BTreeMap, BTreeSet};

pub const TARGET: &str = "wasm-component";
pub const PROJECTION_WORLD: &str = "matcha:world/projection-plugin@1.0.0";
pub const RECONCILE_WORLD: &str = "matcha:world/reconcile-plugin@1.0.0";
pub const EVALUATION_WORLD: &str = "matcha:world/evaluation-plugin@1.0.0";
pub const PROJECTION_INTERFACE: &str = "matcha:world/projection@1.0.0";
pub const RECONCILE_INTERFACE: &str = "matcha:world/reconcile@1.0.0";
pub const EVALUATION_INTERFACE: &str = "matcha:world/evaluation@1.0.0";
pub const STATE_MIGRATION_WORLD: &str = "matcha:world/state-migration-plugin@1.0.0";
pub const STATE_MIGRATION_INTERFACE: &str = "matcha:world/state-migration@1.0.0";
pub fn slot_world(slot: crate::bindings::SlotKind) -> &'static str {
    use crate::bindings::SlotKind::*;
    match slot {
        Connector => "matcha:world/connector-plugin@1.0.0",
        Identity => "matcha:world/identity-plugin@1.0.0",
        Schema => "matcha:world/schema-plugin@1.0.0",
        Resolver => "matcha:world/resolver-plugin@1.0.0",
        Projection => PROJECTION_WORLD,
        Provenance => "matcha:world/provenance-plugin@1.0.0",
        Compiler => "matcha:world/compiler-plugin@1.0.0",
        Policy => "matcha:world/policy-plugin@1.0.0",
        Action => "matcha:world/action-plugin@1.0.0",
        Reconcile => RECONCILE_WORLD,
        Abstraction => "matcha:world/abstraction-plugin@1.0.0",
        Evaluation => EVALUATION_WORLD,
        Context => "matcha:world/context-plugin@1.0.0",
        AgentBridge => "matcha:world/agent-bridge-plugin@1.0.0",
        Storage => "matcha:world/storage-plugin@1.0.0",
    }
}
pub fn slot_interface(slot: crate::bindings::SlotKind) -> &'static str {
    use crate::bindings::SlotKind::*;
    match slot {
        Connector => "matcha:world/connector@1.0.0",
        Identity => "matcha:world/identity@1.0.0",
        Schema => "matcha:world/schema@1.0.0",
        Resolver => "matcha:world/resolver@1.0.0",
        Projection => PROJECTION_INTERFACE,
        Provenance => "matcha:world/provenance@1.0.0",
        Compiler => "matcha:world/compiler@1.0.0",
        Policy => "matcha:world/policy@1.0.0",
        Action => "matcha:world/action@1.0.0",
        Reconcile => RECONCILE_INTERFACE,
        Abstraction => "matcha:world/abstraction@1.0.0",
        Evaluation => EVALUATION_INTERFACE,
        Context => "matcha:world/context@1.0.0",
        AgentBridge => "matcha:world/agent-bridge@1.0.0",
        Storage => "matcha:world/storage@1.0.0",
    }
}
pub const MAX_NODES: usize = 4096;
pub const MAX_DEPTH: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ComponentFailure {
    NodeLimit,
    DepthLimit,
    InvalidRoot,
    InvalidIndex { node: u32 },
    NonCanonicalTree { node: u32 },
    DuplicateField { node: u32 },
    InvalidScalar { node: u32, field: String },
}
fn scalar(node: usize, field: &str) -> ComponentFailure {
    ComponentFailure::InvalidScalar {
        node: node as u32,
        field: field.into(),
    }
}
fn validate<N>(
    nodes: &[N],
    root: u32,
    children: impl Fn(&N) -> Vec<u32>,
) -> Result<(), ComponentFailure> {
    if nodes.len() > MAX_NODES {
        return Err(ComponentFailure::NodeLimit);
    }
    if nodes.is_empty() || root as usize != nodes.len() - 1 {
        return Err(ComponentFailure::InvalidRoot);
    }
    let mut parents = vec![0u8; nodes.len()];
    let mut depths = vec![1usize; nodes.len()];
    for (index, node) in nodes.iter().enumerate() {
        for child in children(node) {
            let child = child as usize;
            if child >= index {
                return Err(ComponentFailure::InvalidIndex { node: index as u32 });
            }
            if parents[child] != 0 {
                return Err(ComponentFailure::NonCanonicalTree { node: child as u32 });
            }
            parents[child] = 1;
            depths[index] = depths[index].max(depths[child] + 1);
        }
        if depths[index] > MAX_DEPTH {
            return Err(ComponentFailure::DepthLimit);
        }
    }
    if let Some(index) = parents[..nodes.len() - 1]
        .iter()
        .position(|count| *count != 1)
    {
        return Err(ComponentFailure::NonCanonicalTree { node: index as u32 });
    }
    Ok(())
}
fn take<T>(values: &mut [Option<T>], index: u32) -> Result<T, ComponentFailure> {
    values
        .get_mut(index as usize)
        .and_then(Option::take)
        .ok_or(ComponentFailure::InvalidIndex { node: index })
}
fn room(length: usize, depth: usize) -> Result<(), ComponentFailure> {
    if depth > MAX_DEPTH {
        Err(ComponentFailure::DepthLimit)
    } else if length >= MAX_NODES {
        Err(ComponentFailure::NodeLimit)
    } else {
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValueArena {
    pub nodes: Vec<ValueNode>,
    pub root: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ValueNode {
    Null,
    Boolean {
        value: bool,
    },
    Integer {
        #[serde(with = "crate::wire::i64_decimal")]
        #[schemars(with = "String")]
        value: i64,
    },
    Decimal {
        value: String,
    },
    Text {
        value: String,
    },
    Money {
        amount: String,
        currency: String,
    },
    Quantity {
        amount: String,
        unit_code: String,
        dimension: String,
    },
    Timestamp {
        value: String,
    },
    Date {
        value: String,
        calendar: String,
    },
    Duration {
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        milliseconds: u64,
    },
    Object {
        id: String,
    },
    Relation {
        id: String,
    },
    List {
        items: Vec<u32>,
    },
    Record {
        fields: Vec<ValueField>,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValueField {
    pub name: String,
    pub node: u32,
}
impl ValueArena {
    pub fn from_value(value: &Value) -> Result<Self, ComponentFailure> {
        fn push(
            value: &Value,
            nodes: &mut Vec<ValueNode>,
            depth: usize,
        ) -> Result<u32, ComponentFailure> {
            room(nodes.len(), depth)?;
            let node = match value {
                Value::Null => ValueNode::Null,
                Value::Boolean { value } => ValueNode::Boolean { value: *value },
                Value::Integer { value } => ValueNode::Integer { value: *value },
                Value::Decimal { value } => ValueNode::Decimal {
                    value: value.to_string(),
                },
                Value::Text { value } => ValueNode::Text {
                    value: value.clone(),
                },
                Value::Money { amount, currency } => ValueNode::Money {
                    amount: amount.to_string(),
                    currency: currency.as_str().into(),
                },
                Value::Quantity { amount, unit } => ValueNode::Quantity {
                    amount: amount.to_string(),
                    unit_code: unit.code.clone(),
                    dimension: unit.dimension.clone(),
                },
                Value::Timestamp { value } => ValueNode::Timestamp {
                    value: value.as_str().into(),
                },
                Value::Date { value, calendar } => ValueNode::Date {
                    value: value.clone(),
                    calendar: calendar.clone(),
                },
                Value::Duration { milliseconds } => ValueNode::Duration {
                    milliseconds: *milliseconds,
                },
                Value::Object { id } => ValueNode::Object {
                    id: id.as_str().into(),
                },
                Value::Relation { id } => ValueNode::Relation {
                    id: id.as_str().into(),
                },
                Value::List { items } => ValueNode::List {
                    items: items
                        .iter()
                        .map(|value| push(value, nodes, depth + 1))
                        .collect::<Result<_, _>>()?,
                },
                Value::Record { fields } => ValueNode::Record {
                    fields: fields
                        .iter()
                        .map(|(name, value)| {
                            Ok(ValueField {
                                name: name.clone(),
                                node: push(value, nodes, depth + 1)?,
                            })
                        })
                        .collect::<Result<_, ComponentFailure>>()?,
                },
            };
            room(nodes.len(), depth)?;
            let index = nodes.len() as u32;
            nodes.push(node);
            Ok(index)
        }
        let mut nodes = Vec::new();
        let root = push(value, &mut nodes, 1)?;
        Ok(Self { nodes, root })
    }
    pub fn into_value(self) -> Result<Value, ComponentFailure> {
        validate(&self.nodes, self.root, |node| match node {
            ValueNode::List { items } => items.clone(),
            ValueNode::Record { fields } => fields.iter().map(|field| field.node).collect(),
            _ => Vec::new(),
        })?;
        let mut values = Vec::with_capacity(self.nodes.len());
        for (index, node) in self.nodes.into_iter().enumerate() {
            let value = match node {
                ValueNode::Null => Value::Null,
                ValueNode::Boolean { value } => Value::Boolean { value },
                ValueNode::Integer { value } => Value::Integer { value },
                ValueNode::Decimal { value } => Value::Decimal {
                    value: Decimal::try_new(value).map_err(|_| scalar(index, "decimal"))?,
                },
                ValueNode::Text { value } => Value::Text { value },
                ValueNode::Money { amount, currency } => Value::Money {
                    amount: Decimal::try_new(amount).map_err(|_| scalar(index, "amount"))?,
                    currency: Currency::try_new(currency).map_err(|_| scalar(index, "currency"))?,
                },
                ValueNode::Quantity {
                    amount,
                    unit_code,
                    dimension,
                } => Value::Quantity {
                    amount: Decimal::try_new(amount).map_err(|_| scalar(index, "amount"))?,
                    unit: Unit::try_new(unit_code, dimension).map_err(|_| scalar(index, "unit"))?,
                },
                ValueNode::Timestamp { value } => Value::Timestamp {
                    value: Timestamp::try_new(value).map_err(|_| scalar(index, "timestamp"))?,
                },
                ValueNode::Date { value, calendar } => Value::Date { value, calendar },
                ValueNode::Duration { milliseconds } => Value::Duration { milliseconds },
                ValueNode::Object { id } => Value::Object {
                    id: ObjectId::try_new(id).map_err(|_| scalar(index, "objectId"))?,
                },
                ValueNode::Relation { id } => Value::Relation {
                    id: RelationId::try_new(id).map_err(|_| scalar(index, "relationId"))?,
                },
                ValueNode::List { items } => Value::List {
                    items: items
                        .into_iter()
                        .map(|child| take(&mut values, child))
                        .collect::<Result<_, _>>()?,
                },
                ValueNode::Record { fields } => {
                    let mut result = BTreeMap::new();
                    for field in fields {
                        if result
                            .insert(field.name, take(&mut values, field.node)?)
                            .is_some()
                        {
                            return Err(ComponentFailure::DuplicateField { node: index as u32 });
                        }
                    }
                    Value::Record { fields: result }
                }
            };
            values.push(Some(value));
        }
        take(&mut values, self.root)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypeArena {
    pub nodes: Vec<TypeNode>,
    pub root: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TypeNode {
    Null,
    Boolean,
    Integer,
    Decimal {
        precision: u16,
        scale: u16,
    },
    Text {
        max_length: u32,
    },
    Money {
        currency: String,
    },
    Quantity {
        unit_code: String,
        dimension: String,
    },
    Timestamp {
        time_zone: String,
    },
    Date {
        calendar: String,
    },
    Duration,
    Object {
        type_id: String,
    },
    Relation {
        type_id: String,
    },
    List {
        element: u32,
        max_items: u32,
    },
    Record {
        fields: Vec<TypeField>,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypeField {
    pub name: String,
    pub node: u32,
    pub nullable: bool,
    pub optional: bool,
}
impl TypeArena {
    pub fn from_type(value: &ValueType) -> Result<Self, ComponentFailure> {
        fn push(
            value: &ValueType,
            nodes: &mut Vec<TypeNode>,
            depth: usize,
        ) -> Result<u32, ComponentFailure> {
            room(nodes.len(), depth)?;
            let node = match value {
                ValueType::Null => TypeNode::Null,
                ValueType::Boolean => TypeNode::Boolean,
                ValueType::Integer => TypeNode::Integer,
                ValueType::Decimal { precision, scale } => TypeNode::Decimal {
                    precision: *precision,
                    scale: *scale,
                },
                ValueType::Text { max_length } => TypeNode::Text {
                    max_length: *max_length,
                },
                ValueType::Money { currency } => TypeNode::Money {
                    currency: currency.as_str().into(),
                },
                ValueType::Quantity { unit } => TypeNode::Quantity {
                    unit_code: unit.code.clone(),
                    dimension: unit.dimension.clone(),
                },
                ValueType::Timestamp { time_zone } => TypeNode::Timestamp {
                    time_zone: time_zone.clone(),
                },
                ValueType::Date { calendar } => TypeNode::Date {
                    calendar: calendar.clone(),
                },
                ValueType::Duration => TypeNode::Duration,
                ValueType::Object { type_id } => TypeNode::Object {
                    type_id: type_id.as_str().into(),
                },
                ValueType::Relation { type_id } => TypeNode::Relation {
                    type_id: type_id.as_str().into(),
                },
                ValueType::List { element, max_items } => TypeNode::List {
                    element: push(element, nodes, depth + 1)?,
                    max_items: *max_items,
                },
                ValueType::Record { fields } => TypeNode::Record {
                    fields: fields
                        .iter()
                        .map(|field| {
                            Ok(TypeField {
                                name: field.name.clone(),
                                node: push(&field.value_type, nodes, depth + 1)?,
                                nullable: field.nullable,
                                optional: field.optional,
                            })
                        })
                        .collect::<Result<_, ComponentFailure>>()?,
                },
            };
            room(nodes.len(), depth)?;
            let index = nodes.len() as u32;
            nodes.push(node);
            Ok(index)
        }
        let mut nodes = Vec::new();
        let root = push(value, &mut nodes, 1)?;
        Ok(Self { nodes, root })
    }
    pub fn into_type(self) -> Result<ValueType, ComponentFailure> {
        validate(&self.nodes, self.root, |node| match node {
            TypeNode::List { element, .. } => vec![*element],
            TypeNode::Record { fields } => fields.iter().map(|field| field.node).collect(),
            _ => Vec::new(),
        })?;
        let mut values = Vec::with_capacity(self.nodes.len());
        for (index, node) in self.nodes.into_iter().enumerate() {
            let value = match node {
                TypeNode::Null => ValueType::Null,
                TypeNode::Boolean => ValueType::Boolean,
                TypeNode::Integer => ValueType::Integer,
                TypeNode::Decimal { precision, scale } => ValueType::Decimal { precision, scale },
                TypeNode::Text { max_length } => ValueType::Text { max_length },
                TypeNode::Money { currency } => ValueType::Money {
                    currency: Currency::try_new(currency).map_err(|_| scalar(index, "currency"))?,
                },
                TypeNode::Quantity {
                    unit_code,
                    dimension,
                } => ValueType::Quantity {
                    unit: Unit::try_new(unit_code, dimension).map_err(|_| scalar(index, "unit"))?,
                },
                TypeNode::Timestamp { time_zone } => ValueType::Timestamp { time_zone },
                TypeNode::Date { calendar } => ValueType::Date { calendar },
                TypeNode::Duration => ValueType::Duration,
                TypeNode::Object { type_id } => ValueType::Object {
                    type_id: DefinitionId::try_new(type_id).map_err(|_| scalar(index, "typeId"))?,
                },
                TypeNode::Relation { type_id } => ValueType::Relation {
                    type_id: DefinitionId::try_new(type_id).map_err(|_| scalar(index, "typeId"))?,
                },
                TypeNode::List { element, max_items } => ValueType::List {
                    element: Box::new(take(&mut values, element)?),
                    max_items,
                },
                TypeNode::Record { fields } => {
                    let mut names = BTreeSet::new();
                    let mut result = Vec::new();
                    for field in fields {
                        if !names.insert(field.name.clone()) {
                            return Err(ComponentFailure::DuplicateField { node: index as u32 });
                        }
                        result.push(RecordField {
                            name: field.name,
                            value_type: take(&mut values, field.node)?,
                            nullable: field.nullable,
                            optional: field.optional,
                        });
                    }
                    ValueType::Record { fields: result }
                }
            };
            values.push(Some(value));
        }
        take(&mut values, self.root)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryArena {
    pub nodes: Vec<QueryTreeNode>,
    pub root: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QueryTreeNode {
    Objects {
        type_ref: DefinitionRef,
        symbol: SymbolId,
    },
    Relations {
        type_ref: DefinitionRef,
        symbol: SymbolId,
    },
    Filter {
        input: u32,
        predicate: ExpressionIr,
    },
    Join {
        left: u32,
        right: u32,
        on: ExpressionIr,
        join_kind: crate::query::JoinKind,
    },
    Traverse {
        input: u32,
        relation_type: DefinitionRef,
        from_role: RoleId,
        to_role: RoleId,
        target: SymbolId,
    },
    Project {
        input: u32,
        columns: Vec<crate::query::QueryColumn>,
    },
    Aggregate {
        input: u32,
        group_by: Vec<crate::query::QueryColumn>,
        aggregates: Vec<crate::query::QueryAggregate>,
    },
    Sort {
        input: u32,
        order: Vec<crate::query::QueryOrder>,
    },
    Distinct {
        input: u32,
    },
    Union {
        inputs: Vec<u32>,
    },
    NotExists {
        input: u32,
        correlated: u32,
        predicate: ExpressionIr,
    },
    Limit {
        input: u32,
        count: u32,
    },
}
impl QueryArena {
    pub fn from_query(value: &crate::query::QueryNode) -> Result<Self, ComponentFailure> {
        use crate::query::QueryNode as Q;
        fn push(
            value: &Q,
            nodes: &mut Vec<QueryTreeNode>,
            depth: usize,
        ) -> Result<u32, ComponentFailure> {
            room(nodes.len(), depth)?;
            let node = match value {
                Q::Objects { type_ref, symbol } => QueryTreeNode::Objects {
                    type_ref: type_ref.clone(),
                    symbol: symbol.clone(),
                },
                Q::Relations { type_ref, symbol } => QueryTreeNode::Relations {
                    type_ref: type_ref.clone(),
                    symbol: symbol.clone(),
                },
                Q::Filter { input, predicate } => QueryTreeNode::Filter {
                    input: push(input, nodes, depth + 1)?,
                    predicate: predicate.clone(),
                },
                Q::Join {
                    left,
                    right,
                    on,
                    join_kind,
                } => QueryTreeNode::Join {
                    left: push(left, nodes, depth + 1)?,
                    right: push(right, nodes, depth + 1)?,
                    on: on.clone(),
                    join_kind: *join_kind,
                },
                Q::Traverse {
                    input,
                    relation_type,
                    from_role,
                    to_role,
                    target,
                } => QueryTreeNode::Traverse {
                    input: push(input, nodes, depth + 1)?,
                    relation_type: relation_type.clone(),
                    from_role: from_role.clone(),
                    to_role: to_role.clone(),
                    target: target.clone(),
                },
                Q::Project { input, columns } => QueryTreeNode::Project {
                    input: push(input, nodes, depth + 1)?,
                    columns: columns.clone(),
                },
                Q::Aggregate {
                    input,
                    group_by,
                    aggregates,
                } => QueryTreeNode::Aggregate {
                    input: push(input, nodes, depth + 1)?,
                    group_by: group_by.clone(),
                    aggregates: aggregates.clone(),
                },
                Q::Sort { input, order } => QueryTreeNode::Sort {
                    input: push(input, nodes, depth + 1)?,
                    order: order.clone(),
                },
                Q::Distinct { input } => QueryTreeNode::Distinct {
                    input: push(input, nodes, depth + 1)?,
                },
                Q::Union { inputs } => QueryTreeNode::Union {
                    inputs: inputs
                        .iter()
                        .map(|input| push(input, nodes, depth + 1))
                        .collect::<Result<_, _>>()?,
                },
                Q::NotExists {
                    input,
                    correlated,
                    predicate,
                } => QueryTreeNode::NotExists {
                    input: push(input, nodes, depth + 1)?,
                    correlated: push(correlated, nodes, depth + 1)?,
                    predicate: predicate.clone(),
                },
                Q::Limit { input, count } => QueryTreeNode::Limit {
                    input: push(input, nodes, depth + 1)?,
                    count: *count,
                },
            };
            room(nodes.len(), depth)?;
            let index = nodes.len() as u32;
            nodes.push(node);
            Ok(index)
        }
        let mut nodes = Vec::new();
        let root = push(value, &mut nodes, 1)?;
        Ok(Self { nodes, root })
    }
    pub fn into_query(self) -> Result<crate::query::QueryNode, ComponentFailure> {
        use crate::query::QueryNode as Q;
        validate(&self.nodes, self.root, |node| match node {
            QueryTreeNode::Objects { .. } | QueryTreeNode::Relations { .. } => vec![],
            QueryTreeNode::Join { left, right, .. } => vec![*left, *right],
            QueryTreeNode::Union { inputs } => inputs.clone(),
            QueryTreeNode::NotExists {
                input, correlated, ..
            } => vec![*input, *correlated],
            QueryTreeNode::Filter { input, .. }
            | QueryTreeNode::Traverse { input, .. }
            | QueryTreeNode::Project { input, .. }
            | QueryTreeNode::Aggregate { input, .. }
            | QueryTreeNode::Sort { input, .. }
            | QueryTreeNode::Distinct { input }
            | QueryTreeNode::Limit { input, .. } => vec![*input],
        })?;
        let mut values = Vec::with_capacity(self.nodes.len());
        for node in self.nodes {
            let value = match node {
                QueryTreeNode::Objects { type_ref, symbol } => Q::Objects { type_ref, symbol },
                QueryTreeNode::Relations { type_ref, symbol } => Q::Relations { type_ref, symbol },
                QueryTreeNode::Filter { input, predicate } => Q::Filter {
                    input: Box::new(take(&mut values, input)?),
                    predicate,
                },
                QueryTreeNode::Join {
                    left,
                    right,
                    on,
                    join_kind,
                } => Q::Join {
                    left: Box::new(take(&mut values, left)?),
                    right: Box::new(take(&mut values, right)?),
                    on,
                    join_kind,
                },
                QueryTreeNode::Traverse {
                    input,
                    relation_type,
                    from_role,
                    to_role,
                    target,
                } => Q::Traverse {
                    input: Box::new(take(&mut values, input)?),
                    relation_type,
                    from_role,
                    to_role,
                    target,
                },
                QueryTreeNode::Project { input, columns } => Q::Project {
                    input: Box::new(take(&mut values, input)?),
                    columns,
                },
                QueryTreeNode::Aggregate {
                    input,
                    group_by,
                    aggregates,
                } => Q::Aggregate {
                    input: Box::new(take(&mut values, input)?),
                    group_by,
                    aggregates,
                },
                QueryTreeNode::Sort { input, order } => Q::Sort {
                    input: Box::new(take(&mut values, input)?),
                    order,
                },
                QueryTreeNode::Distinct { input } => Q::Distinct {
                    input: Box::new(take(&mut values, input)?),
                },
                QueryTreeNode::Union { inputs } => Q::Union {
                    inputs: inputs
                        .into_iter()
                        .map(|index| take(&mut values, index))
                        .collect::<Result<_, _>>()?,
                },
                QueryTreeNode::NotExists {
                    input,
                    correlated,
                    predicate,
                } => Q::NotExists {
                    input: Box::new(take(&mut values, input)?),
                    correlated: Box::new(take(&mut values, correlated)?),
                    predicate,
                },
                QueryTreeNode::Limit { input, count } => Q::Limit {
                    input: Box::new(take(&mut values, input)?),
                    count,
                },
            };
            values.push(Some(value));
        }
        take(&mut values, self.root)
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpressionArena {
    pub nodes: Vec<ExpressionNode>,
    pub root: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExpressionNode {
    Literal {
        value: ValueArena,
    },
    Parameter {
        id: ParameterId,
    },
    Field {
        subject: SymbolId,
        property: DefinitionRef,
    },
    Role {
        relation: SymbolId,
        role: RoleId,
    },
    Unary {
        operator: UnaryOperator,
        operand: u32,
    },
    Binary {
        operator: BinaryOperator,
        left: u32,
        right: u32,
    },
    All {
        terms: Vec<u32>,
    },
    Any {
        terms: Vec<u32>,
    },
    If {
        condition: u32,
        then_value: u32,
        else_value: u32,
    },
    Call {
        function: DefinitionRef,
        arguments: Vec<u32>,
    },
    Aggregate {
        operator: AggregateOperator,
        collection: SymbolId,
        expression: u32,
        window: Option<TimeWindow>,
    },
    IsNull {
        operand: u32,
    },
    IsKnown {
        operand: u32,
    },
}
impl ExpressionArena {
    pub fn from_expression(value: &ExpressionIr) -> Result<Self, ComponentFailure> {
        fn push(
            value: &ExpressionIr,
            nodes: &mut Vec<ExpressionNode>,
            depth: usize,
        ) -> Result<u32, ComponentFailure> {
            room(nodes.len(), depth)?;
            let node = match value {
                ExpressionIr::Literal { value } => ExpressionNode::Literal {
                    value: ValueArena::from_value(value)?,
                },
                ExpressionIr::Parameter { id } => ExpressionNode::Parameter { id: id.clone() },
                ExpressionIr::Field { subject, property } => ExpressionNode::Field {
                    subject: subject.clone(),
                    property: property.clone(),
                },
                ExpressionIr::Role { relation, role } => ExpressionNode::Role {
                    relation: relation.clone(),
                    role: role.clone(),
                },
                ExpressionIr::Unary { operator, operand } => ExpressionNode::Unary {
                    operator: *operator,
                    operand: push(operand, nodes, depth + 1)?,
                },
                ExpressionIr::Binary {
                    operator,
                    left,
                    right,
                } => ExpressionNode::Binary {
                    operator: *operator,
                    left: push(left, nodes, depth + 1)?,
                    right: push(right, nodes, depth + 1)?,
                },
                ExpressionIr::All { terms } => ExpressionNode::All {
                    terms: terms
                        .iter()
                        .map(|term| push(term, nodes, depth + 1))
                        .collect::<Result<_, _>>()?,
                },
                ExpressionIr::Any { terms } => ExpressionNode::Any {
                    terms: terms
                        .iter()
                        .map(|term| push(term, nodes, depth + 1))
                        .collect::<Result<_, _>>()?,
                },
                ExpressionIr::If {
                    condition,
                    then_value,
                    else_value,
                } => ExpressionNode::If {
                    condition: push(condition, nodes, depth + 1)?,
                    then_value: push(then_value, nodes, depth + 1)?,
                    else_value: push(else_value, nodes, depth + 1)?,
                },
                ExpressionIr::Call {
                    function,
                    arguments,
                } => ExpressionNode::Call {
                    function: function.clone(),
                    arguments: arguments
                        .iter()
                        .map(|argument| push(argument, nodes, depth + 1))
                        .collect::<Result<_, _>>()?,
                },
                ExpressionIr::Aggregate {
                    operator,
                    collection,
                    expression,
                    window,
                } => ExpressionNode::Aggregate {
                    operator: *operator,
                    collection: collection.clone(),
                    expression: push(expression, nodes, depth + 1)?,
                    window: window.clone(),
                },
                ExpressionIr::IsNull { operand } => ExpressionNode::IsNull {
                    operand: push(operand, nodes, depth + 1)?,
                },
                ExpressionIr::IsKnown { operand } => ExpressionNode::IsKnown {
                    operand: push(operand, nodes, depth + 1)?,
                },
            };
            room(nodes.len(), depth)?;
            let index = nodes.len() as u32;
            nodes.push(node);
            Ok(index)
        }
        let mut nodes = Vec::new();
        let root = push(value, &mut nodes, 1)?;
        Ok(Self { nodes, root })
    }
    pub fn into_expression(self) -> Result<ExpressionIr, ComponentFailure> {
        validate(&self.nodes, self.root, |node| match node {
            ExpressionNode::Unary { operand, .. }
            | ExpressionNode::IsNull { operand }
            | ExpressionNode::IsKnown { operand } => vec![*operand],
            ExpressionNode::Binary { left, right, .. } => vec![*left, *right],
            ExpressionNode::All { terms } | ExpressionNode::Any { terms } => terms.clone(),
            ExpressionNode::If {
                condition,
                then_value,
                else_value,
            } => vec![*condition, *then_value, *else_value],
            ExpressionNode::Call { arguments, .. } => arguments.clone(),
            ExpressionNode::Aggregate { expression, .. } => vec![*expression],
            _ => Vec::new(),
        })?;
        let mut values = Vec::with_capacity(self.nodes.len());
        for node in self.nodes {
            let value = match node {
                ExpressionNode::Literal { value } => ExpressionIr::Literal {
                    value: value.into_value()?,
                },
                ExpressionNode::Parameter { id } => ExpressionIr::Parameter { id },
                ExpressionNode::Field { subject, property } => {
                    ExpressionIr::Field { subject, property }
                }
                ExpressionNode::Role { relation, role } => ExpressionIr::Role { relation, role },
                ExpressionNode::Unary { operator, operand } => ExpressionIr::Unary {
                    operator,
                    operand: Box::new(take(&mut values, operand)?),
                },
                ExpressionNode::Binary {
                    operator,
                    left,
                    right,
                } => ExpressionIr::Binary {
                    operator,
                    left: Box::new(take(&mut values, left)?),
                    right: Box::new(take(&mut values, right)?),
                },
                ExpressionNode::All { terms } => ExpressionIr::All {
                    terms: terms
                        .into_iter()
                        .map(|index| take(&mut values, index))
                        .collect::<Result<_, _>>()?,
                },
                ExpressionNode::Any { terms } => ExpressionIr::Any {
                    terms: terms
                        .into_iter()
                        .map(|index| take(&mut values, index))
                        .collect::<Result<_, _>>()?,
                },
                ExpressionNode::If {
                    condition,
                    then_value,
                    else_value,
                } => ExpressionIr::If {
                    condition: Box::new(take(&mut values, condition)?),
                    then_value: Box::new(take(&mut values, then_value)?),
                    else_value: Box::new(take(&mut values, else_value)?),
                },
                ExpressionNode::Call {
                    function,
                    arguments,
                } => ExpressionIr::Call {
                    function,
                    arguments: arguments
                        .into_iter()
                        .map(|index| take(&mut values, index))
                        .collect::<Result<_, _>>()?,
                },
                ExpressionNode::Aggregate {
                    operator,
                    collection,
                    expression,
                    window,
                } => ExpressionIr::Aggregate {
                    operator,
                    collection,
                    expression: Box::new(take(&mut values, expression)?),
                    window,
                },
                ExpressionNode::IsNull { operand } => ExpressionIr::IsNull {
                    operand: Box::new(take(&mut values, operand)?),
                },
                ExpressionNode::IsKnown { operand } => ExpressionIr::IsKnown {
                    operand: Box::new(take(&mut values, operand)?),
                },
            };
            values.push(Some(value));
        }
        take(&mut values, self.root)
    }
}
