use std::collections::BTreeMap;

use world_protocol::{
    api::{ConfigValue, ConfigurePackage, PackageConfigView, package_config_digest},
    authorization::AccessMode,
    failure::FieldPath,
    ids::*,
    operation::{CancellationState, OperationReceipt, OperationResult},
    package::{ConfigFailure, ConfigMutability, ConfigSchema, InstalledRecord, PackageFailure},
};

use super::{
    PackageError,
    inventory::{InstallContext, Inventory, encode},
    payload::digest,
};
use crate::{authorization, owner, store::OutboxEvent};

impl Inventory {
    /// Publishes a new public configuration revision, never mutates an existing activation's config.
    pub(crate) async fn configure_package(
        &self,
        context: &InstallContext,
        command: &ConfigurePackage,
    ) -> Result<OperationReceipt, owner::Error> {
        let _mutation = self.mutation.lock().await;
        self.require_world(&context.accepted.world)?;
        let operation = context.accepted.operation_id.clone();
        let key = digest(operation.as_str().as_bytes());
        let input = digest(
            &serde_json::to_vec(command)
                .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?,
        );
        let batch = Self::commit_request(
            context,
            CommitId::try_new(format!("package-config-{}", &key.as_str()[7..]))
                .expect("digest identifier"),
            input,
        )?;
        let command = command.clone();
        let admission = context.admission.clone();
        let committed = self.store.transact(batch, move |tx| Box::pin(async move {
            let at = tx.now().await?;
            super::authority::require_access(tx, &admission, std::slice::from_ref(&command.install_id), AccessMode::Manage).await?;
            authorization::recheck(tx, &admission, &at).await?;
            let current = owner::read_operation(tx, &operation).await?;
            if current.cancellation != CancellationState::NotRequested {
                return Err(PackageError::new(PackageFailure::Cancelled).into());
            }
            let world = tx.world().clone();
            // Activation takes SHARE of this row before publishing its exact graph.
            let row = tx.query_opt("SELECT phase,pending_removal,body FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 FOR UPDATE",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &command.install_id.as_str()]).await?
                .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
            if row.get::<_, String>("phase") != "installed" || row.get::<_, bool>("pending_removal") {
                return Err(PackageError::new(PackageFailure::InstallConflict).into());
            }
            let record: InstalledRecord = serde_json::from_value(row.get("body"))
                .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?;
            if record.world != world || record.install_id != command.install_id {
                return Err(PackageError::new(PackageFailure::InstallConflict).into());
            }
            let row = tx.query_opt("SELECT h.revision,r.body,r.config_digest FROM world_extension_config_head h JOIN world_extension_config_revision r USING(tenant_id,world_id,install_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.install_id=$3 FOR UPDATE OF h",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &command.install_id.as_str()]).await?
                .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
            let expected = i64::try_from(command.expected_revision.0).map_err(|_| PackageError::new(PackageFailure::InstallConflict))?;
            if row.get::<_, i64>("revision") != expected { return Err(PackageError::new(PackageFailure::InstallConflict).into()); }
            let previous: Vec<ConfigValue> = serde_json::from_value(row.get("body"))
                .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?;
            if package_config_digest(&previous).map_err(|cause| PackageError::caused(PackageFailure::SchemaInvalid, cause))?.as_str() != row.get::<_, String>("config_digest") {
                return Err(PackageError::new(PackageFailure::InternalFault).into());
            }
            let fields = validate_fields(&record.manifest.config, &command.fields, true)?;
            let activated = crate::extensions::bindings::has_install_activation(tx, &command.install_id).await
                .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?;
            if activated {
                for schema in record.manifest.config.fields.iter().filter(|field| field.mutable_at == ConfigMutability::Install) {
                    let old = previous.iter().find(|field| field.name == schema.name).map(|field| &field.value);
                    let new = fields.iter().find(|field| field.name == schema.name).map(|field| &field.value);
                    if old != new { return Err(invalid(Some(&schema.name), ConfigFailure::Immutable).into()); }
                }
            }
            let revision = Revision(command.expected_revision.0.checked_add(1).filter(|value| *value <= i64::MAX as u64)
                .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?);
            let config = PackageConfigView { install_id: command.install_id.clone(), revision, digest: package_config_digest(&fields)
                .map_err(|cause| PackageError::caused(PackageFailure::SchemaInvalid, cause))?, fields };
            tx.execute("INSERT INTO world_extension_config_revision(tenant_id,world_id,install_id,revision,config_digest,body) VALUES($1,$2,$3,$4,$5,$6)",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &config.install_id.as_str(), &(revision.0 as i64), &config.digest.as_str(), &encode(&config.fields)?]).await?;
            let changed = tx.execute("UPDATE world_extension_config_head SET revision=$4 WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 AND revision=$5",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &config.install_id.as_str(), &(revision.0 as i64), &expected]).await?;
            if changed != 1 { return Err(PackageError::new(PackageFailure::InstallConflict).into()); }
            let receipt = owner::complete_operation(tx, &current.accepted, OperationResult::Package { install_id: config.install_id.clone(), revision }, &at).await?;
            tx.emit(OutboxEvent { event_id: EventId::try_new(format!("package-config-{}", &key.as_str()[7..])).expect("digest identifier"),
                aggregate_kind: "package_config".into(), aggregate_id: config.install_id.to_string(), aggregate_revision: revision.0,
                event_kind: "world.package.configured".into(), payload: encode(&config)?, causation_id: None, origin: "world.package".into() }).await?;
            Ok::<_, owner::Error>(receipt)
        })).await;
        self.settle_result(context, committed, None).await
    }
}

/// ConfigSchema is the public namespace. Credentials are supplied only by private source IPC.
pub(super) fn validate_fields(
    schema: &ConfigSchema,
    fields: &[ConfigValue],
    required: bool,
) -> Result<Vec<ConfigValue>, PackageError> {
    let mut values = BTreeMap::new();
    for field in fields {
        let declared = schema
            .fields
            .iter()
            .find(|declared| declared.name == field.name)
            .ok_or_else(|| invalid(None, ConfigFailure::UnknownField))?;
        if values
            .insert(field.name.clone(), field.value.clone())
            .is_some()
        {
            return Err(invalid(Some(&declared.name), ConfigFailure::DuplicateField));
        }
        crate::definitions::validate_value(&declared.value_type, false, &field.value)
            .map_err(|_| invalid(Some(&declared.name), ConfigFailure::TypeMismatch))?;
    }
    for field in &schema.fields {
        if !values.contains_key(&field.name) {
            if let Some(value) = &field.default {
                values.insert(field.name.clone(), value.clone());
            } else if required && field.required {
                return Err(invalid(Some(&field.name), ConfigFailure::RequiredField));
            }
        }
    }
    Ok(values
        .into_iter()
        .map(|(name, value)| ConfigValue { name, value })
        .collect())
}

fn invalid(name: Option<&str>, reason: ConfigFailure) -> PackageError {
    let mut path = vec!["config".into()];
    if let Some(name) = name {
        path.push(name.to_owned());
    }
    PackageError::new(PackageFailure::ConfigInvalid {
        field: FieldPath(path),
        reason,
    })
}
