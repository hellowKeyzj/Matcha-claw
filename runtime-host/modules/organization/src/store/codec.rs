use std::{collections::BTreeMap, num::NonZeroU32};

use crate::{
    EdgeAction, GraphRunId, NodeDefinition, NodeId, NodeKind, StartTrigger, WorkAssignment,
    run::event::MetadataValue,
};
use super::StoreFault;

const MAX_COLLECTION_ENTRIES: usize = 16_384;

pub(crate) fn graph_version(definition: &crate::GraphDefinition) -> Result<String, StoreFault> {
    use sha2::{Digest, Sha256};
    let mut bytes = Vec::new();
    encode_graph_definition(&mut bytes, definition)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn encode_rework_limits(
    output: &mut Vec<u8>,
    limits: &BTreeMap<String, u32>,
) -> Result<(), StoreFault> {
    push_count(output, limits.len())?;
    for (port, max_reworks) in limits {
        push_string(output, port)?;
        output.extend_from_slice(&max_reworks.to_le_bytes());
    }
    Ok(())
}

fn encode_graph_definition(
    output: &mut Vec<u8>,
    definition: &crate::GraphDefinition,
) -> Result<(), StoreFault> {
    push_string(output, definition.graph_id())?;
    push_string(output, definition.workflow_plan_id())?;
    push_string(output, definition.run_id().as_str())?;
    push_string(output, definition.title())?;
    push_count(output, definition.nodes().len())?;
    for node in definition.nodes() {
        encode_node_definition(output, node)?;
    }
    push_count(output, definition.edges().len())?;
    for edge in definition.edges() {
        encode_edge_definition(output, edge)?;
    }
    Ok(())
}

fn encode_node_definition(
    output: &mut Vec<u8>,
    node: &crate::NodeDefinition,
) -> Result<(), StoreFault> {
    push_string(output, node.id().as_str())?;
    // A distinct tag preserves legacy fingerprints without ambiguous optional bytes.
    output.push(if node.approval_prompt().is_some() { 7 } else { node_kind_tag(node.kind()) });
    push_string(output, node.title())?;
    encode_rework_limits(output, node.rework_limits())?;
    output.push(u8::from(node.is_control()));
    match node.trigger() {
        None => output.push(0),
        Some(StartTrigger::Webhook { path }) => {
            output.push(1);
            push_string(output, path)?;
        }
        Some(StartTrigger::Cron { expression }) => {
            output.push(2);
            push_string(output, expression)?;
        }
    }
    match node.work_assignment() {
        None => output.push(0),
        Some(work) => {
            output.push(1);
            push_string(output, work.task_id())?;
            push_string(output, work.prompt())?;
            push_string(output, work.role_id())?;
            push_string(output, work.session_ref().as_str())?;
            push_optional_string(output, work.output_artifact_kind())?;
        }
    }
    match node.review_assignment() {
        None => output.push(0),
        Some(review) => {
            output.push(1);
            push_string(output, review.role_id())?;
            push_string(output, review.session_ref().as_str())?;
            push_string(output, review.prompt())?;
        }
    }
    output.push(node.script_review_rule().map_or(0, script_review_rule_tag));
    if let Some(prompt) = node.approval_prompt() {
        push_string(output, prompt)?;
    }
    Ok(())
}

fn encode_edge_definition(
    output: &mut Vec<u8>,
    edge: &crate::EdgeDefinition,
) -> Result<(), StoreFault> {
    push_string(output, edge.id().as_str())?;
    push_string(output, edge.source_node_id().as_str())?;
    push_string(output, edge.source_port())?;
    push_string(output, edge.target_node_id().as_str())?;
    push_string(output, edge.target_port())?;
    output.push(edge_action_tag(edge.action()));
    output.push(u8::from(edge.payload().include_upstream_result()));
    match edge.dependency() {
        None => output.push(0),
        Some(dependency) => {
            output.push(1);
            push_string(output, dependency.dependency_task_id())?;
            push_string(output, dependency.task_id())?;
        }
    }
    Ok(())
}

pub(crate) fn graph_patch_draft_fingerprint(
    base_graph_id: &str,
    base_workflow_plan_id: &str,
    operations: &[crate::application::team_runtime::GraphPatchDraftOperation],
) -> Result<crate::run::event::OpaqueId, StoreFault> {
    use crate::application::team_runtime::GraphPatchDraftOperation;
    use sha2::{Digest, Sha256};
    let mut bytes = Vec::new();
    push_string(&mut bytes, base_graph_id)?;
    push_string(&mut bytes, base_workflow_plan_id)?;
    for operation in operations {
        let operation = match operation {
            GraphPatchDraftOperation::Graph(operation) => operation,
            GraphPatchDraftOperation::AddNode(node) | GraphPatchDraftOperation::ReplaceNode(node) => {
                // Only omitted bindings use these request-only tags; explicit nodes keep their bytes.
                bytes.push(
                    if matches!(operation, GraphPatchDraftOperation::AddNode(_)) {
                        12
                    } else {
                        13
                    },
                );
                push_string(&mut bytes, node.id.as_str())?;
                push_string(&mut bytes, &node.title)?;
                encode_rework_limits(&mut bytes, &node.rework_limits)?;
                push_string(&mut bytes, &node.role_id)?;
                push_string(&mut bytes, &node.prompt)?;
                match &node.assignment {
                    crate::application::team_runtime::NodeAssignmentDraft::Work {
                        task_id,
                        output_artifact_kind,
                    } => {
                        bytes.push(0);
                        push_string(&mut bytes, task_id)?;
                        push_optional_string(&mut bytes, output_artifact_kind.as_deref())?;
                    }
                    crate::application::team_runtime::NodeAssignmentDraft::Review => bytes.push(1),
                }
                continue;
            }
            GraphPatchDraftOperation::AddEdge(edge) | GraphPatchDraftOperation::ReplaceEdge(edge) => {
                let explicit = edge.action.is_some()
                    && edge.source_port.is_some()
                    && edge.target_port.is_some();
                bytes.push(match (operation, edge.action, explicit) {
                    (GraphPatchDraftOperation::AddEdge(_), None, _) => 10,
                    (GraphPatchDraftOperation::ReplaceEdge(_), None, _) => 11,
                    (GraphPatchDraftOperation::AddEdge(_), Some(_), true) => 3,
                    (GraphPatchDraftOperation::ReplaceEdge(_), Some(_), true) => 4,
                    (GraphPatchDraftOperation::AddEdge(_), Some(_), false) => 8,
                    _ => 9,
                });
                push_string(&mut bytes, edge.id.as_str())?;
                push_string(&mut bytes, edge.source_node_id.as_str())?;
                if explicit {
                    push_string(
                        &mut bytes,
                        edge.source_port.as_deref().expect("explicit ports"),
                    )?;
                } else {
                    push_optional_string(&mut bytes, edge.source_port.as_deref())?;
                }
                push_string(&mut bytes, edge.target_node_id.as_str())?;
                if explicit {
                    push_string(
                        &mut bytes,
                        edge.target_port.as_deref().expect("explicit ports"),
                    )?;
                } else {
                    push_optional_string(&mut bytes, edge.target_port.as_deref())?;
                }
                if let Some(action) = edge.action {
                    bytes.push(edge_action_tag(action));
                }
                bytes.push(u8::from(edge.payload.include_upstream_result()));
                match &edge.dependency {
                    None => bytes.push(0),
                    Some(dependency) => match (
                        dependency.dependency_task_id.as_deref(),
                        dependency.task_id.as_deref(),
                    ) {
                        (Some(source), Some(target)) => {
                            bytes.push(1);
                            push_string(&mut bytes, source)?;
                            push_string(&mut bytes, target)?;
                        }
                        (source, target) => {
                            bytes.push(2);
                            push_optional_string(&mut bytes, source)?;
                            push_optional_string(&mut bytes, target)?;
                        }
                    },
                }
                continue;
            }
        };
        match operation {
            crate::GraphPatchOperation::AddNode(node) => {
                bytes.push(0);
                encode_node_definition(&mut bytes, node)?;
            }
            crate::GraphPatchOperation::ReplaceNode(node) => {
                bytes.push(1);
                encode_node_definition(&mut bytes, node)?;
            }
            crate::GraphPatchOperation::RemoveNode(id) => {
                bytes.push(2);
                push_string(&mut bytes, id.as_str())?;
            }
            crate::GraphPatchOperation::AddEdge(edge) => {
                bytes.push(3);
                encode_edge_definition(&mut bytes, edge)?;
            }
            crate::GraphPatchOperation::ReplaceEdge(edge) => {
                bytes.push(4);
                encode_edge_definition(&mut bytes, edge)?;
            }
            crate::GraphPatchOperation::RemoveEdge(id) => {
                bytes.push(5);
                push_string(&mut bytes, id.as_str())?;
            }
            crate::GraphPatchOperation::SetReworkLimit {
                source_node_id,
                source_port,
                max_reworks,
            } => {
                bytes.push(14);
                push_string(&mut bytes, source_node_id.as_str())?;
                push_string(&mut bytes, source_port)?;
                bytes.extend_from_slice(&max_reworks.to_le_bytes());
            }
            crate::GraphPatchOperation::SetNodePosition { node_id, position } => {
                bytes.push(6);
                push_string(&mut bytes, node_id.as_str())?;
                bytes.extend_from_slice(&position.x().to_le_bytes());
                bytes.extend_from_slice(&position.y().to_le_bytes());
            }
            crate::GraphPatchOperation::SetMetadata { key, value } => {
                bytes.push(7);
                push_string(&mut bytes, key.as_str())?;
                match value {
                    MetadataValue::Enabled(value) => {
                        bytes.push(0);
                        bytes.push(u8::from(*value));
                    }
                    MetadataValue::Revision(value) => {
                        bytes.push(1);
                        bytes.extend_from_slice(&value.to_le_bytes());
                    }
                    MetadataValue::OpaqueId(value) => {
                        bytes.push(2);
                        push_string(&mut bytes, value.as_str())?;
                    }
                }
            }
        }
    }
    crate::run::event::OpaqueId::try_new(format!("sgpatch-{:x}", Sha256::digest(bytes)))
        .map_err(|_| StoreFault::InvalidFacts)
}

pub(in crate::store) fn decode_historical_definition(
    schema: u8,
    bytes: &[u8],
) -> Result<crate::GraphDefinition, StoreFault> {
    if !matches!(schema, 25 | 26 | 27) {
        return Err(StoreFault::CorruptRecord);
    }
    let mut reader = Reader::with_schema(bytes, schema);
    let definition = reader.graph_definition()?;
    reader.finish()?;
    Ok(definition)
}

struct Reader<'a> {
    remaining: &'a [u8],
    schema25: bool,
    schema: u8,
}

impl<'a> Reader<'a> {
    const fn with_schema(content: &'a [u8], schema: u8) -> Self {
        Self {
            remaining: content,
            schema25: schema == 25,
            schema,
        }
    }

    fn finish(self) -> Result<(), StoreFault> {
        self.remaining
            .is_empty()
            .then_some(())
            .ok_or(StoreFault::CorruptRecord)
    }

    fn schema25_group(&mut self) -> Result<bool, StoreFault> {
        if !self.schema25 {
            return Ok(false);
        }
        match self.byte()? {
            0 => Ok(false),
            1 => {
                self.string()?;
                self.bool()?;
                self.bool()?;
                self.u32()?;
                Ok(true)
            }
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn rework_limits(
        &mut self,
        kind: NodeKind,
    ) -> Result<(BTreeMap<String, u32>, Option<u32>), StoreFault> {
        if self.schema < 28 {
            let old = NonZeroU32::new(self.u32()?)
                .ok_or(StoreFault::InvalidFacts)?
                .get();
            return Ok((
                kind.source_ports()
                    .iter()
                    .filter(|port| kind.accepts_edge_action(port.as_str(), EdgeAction::Rework))
                    .map(|port| (port.as_str().to_owned(), 3))
                    .collect(),
                Some(old),
            ));
        }
        let mut limits = BTreeMap::new();
        for _ in 0..self.count()? {
            let port = self.string()?;
            let max = self.u32()?;
            if limits.insert(port, max).is_some() {
                return Err(StoreFault::InvalidFacts);
            }
        }
        Ok((limits, None))
    }

    fn graph_definition(&mut self) -> Result<crate::GraphDefinition, StoreFault> {
        let graph_id = self.string()?;
        let workflow_plan_id = self.string()?;
        let run_id = GraphRunId::new(self.string()?);
        let title = self.string()?;
        let nodes = (0..self.count()?)
            .map(|_| {
                let id = NodeId::new(self.string()?);
                let kind = self.node_kind()?;
                let title = self.string()?;
                let (rework_limits, _) = self.rework_limits(kind)?;
                let is_control = self.bool()?;
                let trigger = match self.byte()? {
                    0 => None,
                    1 => Some(StartTrigger::Webhook {
                        path: self.string()?,
                    }),
                    2 => Some(StartTrigger::Cron {
                        expression: self.string()?,
                    }),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let work = match self.byte()? {
                    0 => None,
                    1 => {
                        let work = WorkAssignment::typed(
                            self.string()?,
                            self.string()?,
                            crate::ExecutorPolicy::team_role_session(
                                self.string()?,
                                crate::RoleSessionRef::try_new(self.string()?)
                                    .map_err(|_| StoreFault::InvalidFacts)?,
                            ),
                            self.optional_string()?,
                        );
                        if self.schema25 {
                            self.optional_string()?;
                        }
                        Some(work)
                    }
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let review = match self.byte()? {
                    0 => None,
                    1 => Some(crate::ReviewAssignment::with_executor(
                        crate::ExecutorPolicy::team_role_session(
                            self.string()?,
                            crate::RoleSessionRef::try_new(self.string()?)
                                .map_err(|_| StoreFault::InvalidFacts)?,
                        ),
                        self.string()?,
                    )),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let group = self.schema25_group()?;
                let script_review_rule = if self.schema >= 27 { self.optional_script_review_rule()? } else { None };
                if let Some(rule) = script_review_rule {
                    if kind != NodeKind::ScriptReview || !is_control || trigger.is_some()
                        || work.is_some() || review.is_some() || group
                    {
                        return Err(StoreFault::InvalidFacts);
                    }
                    return Ok(NodeDefinition::script_review(id, title, rule)
                        .with_rework_limits(rework_limits));
                }
                let node = match (kind, is_control) {
                    (NodeKind::Start, false) if work.is_none() && review.is_none() && !group => {
                        NodeDefinition::start(id, title, trigger)
                    }
                    (NodeKind::Work, false) if trigger.is_none() && review.is_none() && !group => {
                        NodeDefinition::work(id, title, work.ok_or(StoreFault::InvalidFacts)?)
                    }
                    (NodeKind::Review, false) if trigger.is_none() && work.is_none() && !group => {
                        NodeDefinition::review(id, title, review.ok_or(StoreFault::InvalidFacts)?)
                    }
                    (NodeKind::Join, false)
                        if trigger.is_none()
                            && work.is_none()
                            && review.is_none()
                            && group == self.schema25 =>
                    {
                        NodeDefinition::join(id, title)
                    }
                    (
                        NodeKind::Start
                        | NodeKind::Review
                        | NodeKind::HumanDecision
                        | NodeKind::ScriptReview
                        | NodeKind::Join
                        | NodeKind::End,
                        true,
                    ) if trigger.is_none() && work.is_none() && review.is_none() && !group => {
                        NodeDefinition::control(id, kind, title)
                    }
                    _ => return Err(StoreFault::InvalidFacts),
                };
                Ok(node.with_rework_limits(rework_limits))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let edges = (0..self.count()?)
            .map(|_| {
                Ok(crate::EdgeDefinition::new(
                    crate::EdgeId::new(self.string()?),
                    NodeId::new(self.string()?),
                    self.string()?,
                    NodeId::new(self.string()?),
                    self.string()?,
                    self.edge_action()?,
                )
                .with_payload(crate::EdgePayloadPolicy::new(self.bool()?))
                .with_dependency_opt(match self.byte()? {
                    0 => None,
                    1 => Some(crate::DependencyMetadata::new(
                        self.string()?,
                        self.string()?,
                    )),
                    _ => return Err(StoreFault::CorruptRecord),
                }))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        crate::GraphDefinition::from_durable(
            graph_id,
            workflow_plan_id,
            run_id,
            title,
            nodes,
            edges,
        )
            .map_err(|_| StoreFault::InvalidFacts)
    }

    fn optional_script_review_rule(
        &mut self,
    ) -> Result<Option<crate::ScriptReviewRule>, StoreFault> {
        match self.byte()? {
            0 => Ok(None),
            1 => Ok(Some(crate::ScriptReviewRule::PassThrough)),
            2 => Ok(Some(crate::ScriptReviewRule::AssertAllUpstreamCompleted)),
            3 => Ok(Some(crate::ScriptReviewRule::AssertNoBlockingGate)),
            4 => Ok(Some(crate::ScriptReviewRule::AssertArtifactExists)),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn node_kind(&mut self) -> Result<NodeKind, StoreFault> {
        match self.byte()? {
            0 => Ok(NodeKind::Start),
            1 => Ok(NodeKind::Work),
            2 => Ok(NodeKind::Review),
            3 => Ok(NodeKind::HumanDecision),
            4 => Ok(NodeKind::ScriptReview),
            5 => Ok(NodeKind::Join),
            6 => Ok(NodeKind::End),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn edge_action(&mut self) -> Result<EdgeAction, StoreFault> {
        match self.byte()? {
            0 => Ok(EdgeAction::Activate),
            1 => Ok(EdgeAction::Rework),
            2 => Ok(EdgeAction::Gate),
            3 => Ok(EdgeAction::Finish),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn optional_string(&mut self) -> Result<Option<String>, StoreFault> {
        match self.byte()? {
            0 => Ok(None),
            1 => self.string().map(Some),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn bool(&mut self) -> Result<bool, StoreFault> {
        match self.byte()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn string(&mut self) -> Result<String, StoreFault> {
        let length = usize::try_from(self.u32()?).map_err(|_| StoreFault::CorruptRecord)?;
        std::str::from_utf8(self.take(length)?)
            .map(str::to_owned)
            .map_err(|_| StoreFault::CorruptRecord)
    }

    fn count(&mut self) -> Result<usize, StoreFault> {
        let count = usize::try_from(self.u32()?).map_err(|_| StoreFault::CorruptRecord)?;
        if count > MAX_COLLECTION_ENTRIES {
            return Err(StoreFault::CorruptRecord);
        }
        Ok(count)
    }

    fn byte(&mut self) -> Result<u8, StoreFault> {
        Ok(*self
            .take(1)?
            .first()
            .expect("one requested byte must exist"))
    }

    fn u32(&mut self) -> Result<u32, StoreFault> {
        Ok(u32::from_le_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
        ))
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], StoreFault> {
        if self.remaining.len() < count {
            return Err(StoreFault::CorruptRecord);
        }
        let (value, remaining) = self.remaining.split_at(count);
        self.remaining = remaining;
        Ok(value)
    }
}

fn push_count(output: &mut Vec<u8>, count: usize) -> Result<(), StoreFault> {
    if count > MAX_COLLECTION_ENTRIES {
        return Err(StoreFault::RecordTooLarge);
    }
    output.extend_from_slice(
        &u32::try_from(count)
            .map_err(|_| StoreFault::RecordTooLarge)?
            .to_le_bytes(),
    );
    Ok(())
}

fn push_string(output: &mut Vec<u8>, value: &str) -> Result<(), StoreFault> {
    output.extend_from_slice(
        &u32::try_from(value.len())
            .map_err(|_| StoreFault::RecordTooLarge)?
            .to_le_bytes(),
    );
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn push_optional_string(output: &mut Vec<u8>, value: Option<&str>) -> Result<(), StoreFault> {
    match value {
        Some(value) => {
            output.push(1);
            push_string(output, value)
        }
        None => {
            output.push(0);
            Ok(())
        }
    }
}

fn node_kind_tag(kind: NodeKind) -> u8 {
    match kind {
        NodeKind::Start => 0,
        NodeKind::Work => 1,
        NodeKind::Review => 2,
        NodeKind::HumanDecision => 3,
        NodeKind::ScriptReview => 4,
        NodeKind::Join => 5,
        NodeKind::End => 6,
    }
}

fn edge_action_tag(action: EdgeAction) -> u8 {
    match action {
        EdgeAction::Activate => 0,
        EdgeAction::Rework => 1,
        EdgeAction::Gate => 2,
        EdgeAction::Finish => 3,
    }
}

fn script_review_rule_tag(rule: crate::ScriptReviewRule) -> u8 {
    match rule {
        crate::ScriptReviewRule::PassThrough => 1,
        crate::ScriptReviewRule::AssertAllUpstreamCompleted => 2,
        crate::ScriptReviewRule::AssertNoBlockingGate => 3,
        crate::ScriptReviewRule::AssertArtifactExists => 4,
    }
}
