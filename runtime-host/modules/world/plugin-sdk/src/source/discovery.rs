use std::collections::BTreeSet;

use super::{RecordedSource, invalid};
#[cfg(feature = "packaging")]
use crate::protocol::sources::SourcePage;
use crate::protocol::{
    sources::{
        self, KeyBasis, KeyDeclaration, PluginResource, RecordCell, SchemaObservation,
        SourceFailure, SourcePlanReason, SourceRow, SourceSchemaRequest,
    },
    value,
};

pub(super) fn validate_schema(resource: &PluginResource) -> Result<(), SourceFailure> {
    if resource.id.is_empty()
        || resource.id.len() > 256
        || resource.fields.is_empty()
        || resource.fields.len() > 4096
    {
        return Err(invalid("schema", SourcePlanReason::UnknownResource));
    }
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    for field in &resource.fields {
        if !ids.insert(&field.id)
            || !names.insert(&field.name)
            || field.name.is_empty()
            || !field.readable
            || field.writable
        {
            return Err(invalid("schema.fields", SourcePlanReason::UnknownField));
        }
        value::validate_value_type(&field.value_type)
            .map_err(|_| invalid("schema.fields.valueType", SourcePlanReason::InvalidValue))?;
    }
    if resource.key.is_empty()
        || resource.key.iter().collect::<BTreeSet<_>>().len() != resource.key.len()
        || resource.key.iter().any(|id| {
            !resource.fields.iter().any(|field| {
                &field.id == id && field.readable && !field.nullable && !field.optional
            })
        })
    {
        return Err(invalid("schema.key", SourcePlanReason::InvalidKey));
    }
    Ok(())
}

fn row_key(resource: &PluginResource, row: &SourceRow) -> Result<String, SourceFailure> {
    let cells = resource
        .key
        .iter()
        .map(|id| {
            row.fields
                .iter()
                .find(|field| &field.id == id)
                .map(|field| field.value.clone())
                .ok_or_else(|| invalid("snapshot.key", SourcePlanReason::InvalidKey))
        })
        .collect::<Result<Vec<_>, _>>()?;
    sources::native_key(&cells)
}

pub(super) fn validate_row(
    resource: &PluginResource,
    row: &SourceRow,
    incarnation: &str,
) -> Result<(), SourceFailure> {
    if row.incarnation != incarnation || incarnation.is_empty() {
        return Err(invalid(
            "snapshot.incarnation",
            SourcePlanReason::InvalidValue,
        ));
    }
    let mut ids = BTreeSet::new();
    for field in &row.fields {
        let declared = resource
            .fields
            .iter()
            .find(|declared| declared.id == field.id)
            .ok_or_else(|| invalid("snapshot.fields", SourcePlanReason::UnknownField))?;
        if !ids.insert(&field.id) || field.name != declared.name {
            return Err(invalid("snapshot.fields", SourcePlanReason::UnknownField));
        }
        match &field.value {
            RecordCell::Known { value } => {
                value::validate_value(&declared.value_type, declared.nullable, value).map_err(
                    |_| invalid("snapshot.fields.value", SourcePlanReason::InvalidValue),
                )?;
                if field.formula.as_ref().is_some_and(|formula| {
                    !formula.cache_current || formula.cached.as_ref() != Some(value)
                }) {
                    return Err(invalid(
                        "snapshot.fields.formula",
                        SourcePlanReason::InvalidValue,
                    ));
                }
            }
            RecordCell::Missing if !declared.optional => {
                return Err(invalid(
                    "snapshot.fields.value",
                    SourcePlanReason::InvalidValue,
                ));
            }
            _ => {}
        }
    }
    if resource
        .fields
        .iter()
        .any(|field| !field.optional && !ids.contains(&field.id))
    {
        return Err(invalid("snapshot.fields", SourcePlanReason::UnknownField));
    }
    if row.native_key != row_key(resource, row)? {
        return Err(invalid("snapshot.key", SourcePlanReason::InvalidKey));
    }
    Ok(())
}

#[cfg(feature = "packaging")]
pub(crate) fn prepare_snapshot(
    resource: &PluginResource,
    mut page: SourcePage,
) -> Result<SourcePage, SourceFailure> {
    validate_schema(resource)?;
    for row in &mut page.rows {
        row.native_key = row_key(resource, row)?;
        validate_row(resource, row, &page.basis.incarnation)?;
    }
    Ok(page)
}

impl RecordedSource {
    fn observation(
        &self,
        request: &SourceSchemaRequest,
    ) -> Result<SchemaObservation, SourceFailure> {
        if request.resource != self.resource.id {
            return Err(invalid("resource", SourcePlanReason::UnknownResource));
        }
        Ok(SchemaObservation {
            incarnation: self.page.basis.incarnation.clone(),
            namespace: self.resource.id.clone(),
            fields: self.resource.fields.clone(),
            keys: vec![KeyDeclaration {
                fields: self.resource.key.clone(),
                basis: KeyBasis::DeclaredPrimary,
            }],
            complete: true,
        })
    }

    pub fn discover(
        &self,
        request: SourceSchemaRequest,
    ) -> Result<SchemaObservation, SourceFailure> {
        let observation = self.observation(&request)?;
        let mut keys = BTreeSet::new();
        for row in &self.page.rows {
            validate_row(&self.resource, row, &self.page.basis.incarnation)?;
            if !keys.insert(&row.native_key) {
                return Err(invalid("snapshot.key", SourcePlanReason::InvalidKey));
            }
        }
        Ok(observation)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub async fn discover_cancellable(
        &self,
        request: SourceSchemaRequest,
        cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<SchemaObservation, SourceFailure> {
        let observation = self.observation(&request)?;
        let mut keys = BTreeSet::new();
        for row in &self.page.rows {
            if *cancellation.borrow() {
                return Err(SourceFailure::Cancelled);
            }
            validate_row(&self.resource, row, &self.page.basis.incarnation)?;
            if !keys.insert(&row.native_key) {
                return Err(invalid("snapshot.key", SourcePlanReason::InvalidKey));
            }
            tokio::task::yield_now().await;
        }
        if *cancellation.borrow() {
            return Err(SourceFailure::Cancelled);
        }
        Ok(observation)
    }
}
