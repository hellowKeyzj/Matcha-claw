mod discovery;
pub use crate::protocol::slots::discover_port;
#[cfg(feature = "packaging")]
pub(crate) use discovery::prepare_snapshot;

use crate::protocol::{
    api::{PackageConfigView, package_config_digest},
    bindings::MethodPort,
    failure::FieldPath,
    ids::Digest,
    schema,
    sources::{self, SourceFailure, SourcePage, SourcePlanReason, SourceReadPlan},
    value::Value,
    wire,
};

const MAX_SNAPSHOT_BYTES: usize = 524_288;
const MAX_ROWS: usize = 4096;

pub fn read_port() -> Result<MethodPort, schema::SchemaFailure> {
    crate::protocol::slots::slot_port(crate::protocol::bindings::SlotKind::Connector)
}

/// An immutable, explicitly configured recorded source; no filesystem, credentials or live effects.
#[derive(Clone)]
pub struct RecordedSource {
    resource: sources::PluginResource,
    page: SourcePage,
    config_digest: Digest,
}

impl RecordedSource {
    pub fn from_config(config: &PackageConfigView) -> Result<Self, SourceFailure> {
        if package_config_digest(&config.fields).map_err(|_| SourceFailure::ProtocolViolation)?
            != config.digest
        {
            return Err(SourceFailure::ProtocolViolation);
        }
        // This bounded driver transfers its complete immutable config during the handshake.
        wire::encode(config, crate::protocol::process::MAX_HANDSHAKE_BYTES / 2)
            .map_err(|_| SourceFailure::ResponseLimit)?;
        if config.fields.len() != 2
            || config
                .fields
                .iter()
                .any(|field| field.name != "schema" && field.name != "snapshot")
        {
            return Err(invalid("config", SourcePlanReason::InvalidValue));
        }
        let text = |name: &str| -> Result<&str, SourceFailure> {
            match config
                .fields
                .iter()
                .find(|field| field.name == name)
                .map(|field| &field.value)
            {
                Some(Value::Text { value }) => Ok(value),
                _ => Err(invalid(name, SourcePlanReason::InvalidValue)),
            }
        };
        let resource: sources::PluginResource =
            wire::decode(text("schema")?.as_bytes(), MAX_SNAPSHOT_BYTES)
                .map_err(|_| invalid("schema", SourcePlanReason::InvalidValue))?;
        discovery::validate_schema(&resource)?;
        let page: SourcePage = wire::decode(text("snapshot")?.as_bytes(), MAX_SNAPSHOT_BYTES)
            .map_err(|_| invalid("snapshot", SourcePlanReason::InvalidValue))?;
        if resource.id.is_empty()
            || page.rows.len() > MAX_ROWS
            || page.basis.incarnation.is_empty()
            || !page.complete
            || page.continuation.is_some()
            || page.basis.guarantee != sources::SourceGuarantee::RecordedReplay
            || page.basis.gap.is_some()
            || page.basis.schema.world != page.basis.binding.world
            || page.basis.identity_rule.world != page.basis.binding.world
            || page
                .basis
                .field_definitions
                .iter()
                .any(|field| field.world != page.basis.binding.world)
            || page.basis.position.as_ref().is_some_and(|position| {
                position.source_id != page.basis.source_id
                    || position.incarnation != page.basis.incarnation
            })
        {
            return Err(invalid("snapshot", SourcePlanReason::InvalidValue));
        }
        let mut keys = std::collections::BTreeSet::new();
        for row in &page.rows {
            discovery::validate_row(&resource, row, &page.basis.incarnation)?;
            if !keys.insert(&row.native_key) {
                return Err(invalid("snapshot", SourcePlanReason::InvalidKey));
            }
        }
        Ok(Self {
            resource,
            page,
            config_digest: config.digest.clone(),
        })
    }

    fn selection(&self, request: &SourceReadPlan) -> Result<(usize, usize, String), SourceFailure> {
        if request.resource != self.resource.id {
            return Err(invalid("resource", SourcePlanReason::UnknownResource));
        }
        if request.binding != self.page.basis.binding {
            return Err(invalid("binding", SourcePlanReason::InvalidValue));
        }
        if request.predicate.is_some() {
            return Err(invalid("predicate", SourcePlanReason::UnsupportedPredicate));
        }
        if !request.order.is_empty() {
            return Err(invalid("order", SourcePlanReason::UnsupportedOrdering));
        }
        if request.as_of.is_some() {
            return Err(invalid("asOf", SourcePlanReason::UnsupportedHistory));
        }
        if request.limit == 0 || request.limit as usize > MAX_ROWS {
            return Err(invalid("limit", SourcePlanReason::UnsupportedLimit));
        }
        let mut fields = std::collections::BTreeSet::new();
        for field in &request.fields {
            if !fields.insert(field)
                || !self
                    .resource
                    .fields
                    .iter()
                    .any(|candidate| candidate.id.as_str() == field)
            {
                return Err(invalid("fields", SourcePlanReason::UnknownField));
            }
        }
        let selection = wire::encode(
            &(
                &request.binding,
                &request.resource,
                &request.row_symbol,
                &request.fields,
                request.limit,
            ),
            MAX_SNAPSHOT_BYTES,
        )
        .map_err(|_| SourceFailure::ResponseLimit)?;
        let prefix = format!(
            "{}:{}:",
            self.config_digest.as_str(),
            schema::hash(&selection)
                .map_err(|_| SourceFailure::InternalFault)?
                .as_str()
        );
        let offset = match &request.continuation {
            None => 0,
            Some(token) => {
                let digits = token
                    .strip_prefix(&prefix)
                    .ok_or_else(|| invalid("continuation", SourcePlanReason::InvalidValue))?;
                let offset: usize = digits
                    .parse()
                    .map_err(|_| invalid("continuation", SourcePlanReason::InvalidValue))?;
                if offset.to_string() != digits || offset >= self.page.rows.len() {
                    return Err(invalid("continuation", SourcePlanReason::InvalidValue));
                }
                offset
            }
        };
        Ok((
            offset,
            (offset + request.limit as usize).min(self.page.rows.len()),
            prefix,
        ))
    }

    fn project_row(&self, index: usize, fields: &[String]) -> sources::SourceRow {
        let mut row = self.page.rows[index].clone();
        if !fields.is_empty() {
            row.fields
                .retain(|field| fields.iter().any(|selected| selected == field.id.as_str()));
        }
        row
    }

    fn page(&self, rows: Vec<sources::SourceRow>, end: usize, prefix: String) -> SourcePage {
        let complete = end == self.page.rows.len();
        SourcePage {
            rows,
            basis: self.page.basis.clone(),
            continuation: (!complete).then(|| format!("{prefix}{end}")),
            complete,
        }
    }

    pub fn read(&self, request: SourceReadPlan) -> Result<SourcePage, SourceFailure> {
        let (start, end, prefix) = self.selection(&request)?;
        Ok(self.page(
            (start..end)
                .map(|index| self.project_row(index, &request.fields))
                .collect(),
            end,
            prefix,
        ))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub async fn read_cancellable(
        &self,
        request: SourceReadPlan,
        cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<SourcePage, SourceFailure> {
        let (start, end, prefix) = self.selection(&request)?;
        let mut rows = Vec::with_capacity(end - start);
        for index in start..end {
            if *cancellation.borrow() {
                return Err(SourceFailure::Cancelled);
            }
            rows.push(self.project_row(index, &request.fields));
            tokio::task::yield_now().await;
        }
        if *cancellation.borrow() {
            return Err(SourceFailure::Cancelled);
        }
        Ok(self.page(rows, end, prefix))
    }
}

impl crate::methods::Connector for RecordedSource {
    fn read(&mut self, request: SourceReadPlan) -> Result<SourcePage, SourceFailure> {
        RecordedSource::read(self, request)
    }
    fn discover(
        &mut self,
        request: sources::SourceSchemaRequest,
    ) -> Result<sources::SchemaObservation, SourceFailure> {
        RecordedSource::discover(self, request)
    }
}

fn invalid(field: &str, reason: SourcePlanReason) -> SourceFailure {
    SourceFailure::InvalidPlan {
        field: FieldPath(vec![field.into()]),
        reason,
    }
}
