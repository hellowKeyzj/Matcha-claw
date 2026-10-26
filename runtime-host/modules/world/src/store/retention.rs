use std::{collections::BTreeSet, sync::Mutex};

use tokio_postgres::types::ToSql;
use world_protocol::{
    commit::{CommitFailure, ConstraintCode},
    failure::FailureStage,
    identity::SubjectRef,
    ids::{
        DefinitionId, DefinitionRef, EvidenceRef, MappingRef, ParseArtifactId, ReleaseId,
        ResourceRef, SchemaRef, ScopeId,
    },
    materials::SourceVersionRef,
    provenance::ReadDependency,
    releases::BranchRef,
    sources::SourceBasis,
};

use super::{StoreError, WorldTransaction, archive, schema};

/// Domain owners decode their own retained records. Store accepts only existing typed references.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetentionRoots {
    pub scopes: Vec<ScopeId>,
    pub resources: Vec<ResourceRef>,
    pub definitions: Vec<DefinitionRef>,
    pub evidence: Vec<EvidenceRef>,
    pub dependencies: Vec<ReadDependency>,
    pub sources: Vec<SourceBasis>,
    pub releases: Vec<ReleaseId>,
    pub branches: Vec<BranchRef>,
    pub source_versions: Vec<SourceVersionRef>,
    pub parse_artifacts: Vec<ParseArtifactId>,
    pub schemas: Vec<SchemaRef>,
    pub mappings: Vec<MappingRef>,
}

pub(super) fn reference_error(cause: impl std::error::Error + Send + Sync + 'static) -> StoreError {
    let mut source: &(dyn std::error::Error + 'static) = &cause;
    let storage_failure = loop {
        if let Some(error) = source.downcast_ref::<StoreError>() {
            break Some((error.reason.clone(), error.stage));
        }
        match source.source() {
            Some(next) => source = next,
            None => break None,
        }
    };
    let (reason, stage) = storage_failure.unwrap_or((
        CommitFailure::ConstraintConflict {
            constraint: ConstraintCode::ForeignReference,
        },
        FailureStage::Validate,
    ));
    StoreError::caused_by(reason, stage, cause)
}
fn invalid() -> StoreError {
    StoreError::new(CommitFailure::InvalidBatch, FailureStage::Validate)
}

struct ForeignKey {
    source: String,
    target: String,
    join: String,
}

/// Transaction-local row marks, not a second durable resource or retention ledger.
pub(super) struct RetentionSet {
    pub names: Vec<String>,
    foreign_keys: Vec<ForeignKey>,
    definitions: Mutex<(BTreeSet<DefinitionRef>, BTreeSet<DefinitionId>)>,
    restore: bool,
}

impl RetentionSet {
    pub async fn new(tx: &WorldTransaction<'_>) -> Result<Self, StoreError> {
        Self::create(tx, false).await
    }

    pub async fn for_restore(tx: &WorldTransaction<'_>) -> Result<Self, StoreError> {
        Self::create(tx, true).await
    }

    async fn create(tx: &WorldTransaction<'_>, restore: bool) -> Result<Self, StoreError> {
        tx.require_exclusive_storage()?;
        let names = archive::catalog(&tx.transaction).await?;
        tx.transaction.batch_execute("CREATE TEMP TABLE world_delete_keep(table_name text NOT NULL,row_id tid NOT NULL,PRIMARY KEY(table_name,row_id)) ON COMMIT DROP").await
            .map_err(|error| StoreError::database(error, FailureStage::Execute))?;
        let rows = tx.transaction.query(
            "SELECT s.relname AS source,t.relname AS target,string_agg(format('s.%I=t.%I',sa.attname,ta.attname),' AND ' ORDER BY k.ordinality) AS join_sql FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid JOIN pg_namespace sn ON sn.oid=s.relnamespace JOIN pg_class t ON t.oid=c.confrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY AS k(source_key,target_key,ordinality) JOIN pg_attribute sa ON sa.attrelid=s.oid AND sa.attnum=k.source_key JOIN pg_attribute ta ON ta.attrelid=t.oid AND ta.attnum=k.target_key WHERE c.contype='f' AND sn.nspname='public' AND tn.nspname='public' AND s.relname=ANY($1) AND t.relname=ANY($2) GROUP BY c.oid,s.relname,t.relname ORDER BY s.relname,t.relname,c.oid",
            &[&schema::tables(), &names],
        ).await.map_err(|error| StoreError::database(error, FailureStage::Read))?;
        let foreign_keys = rows
            .into_iter()
            .map(|row| ForeignKey {
                source: row.get("source"),
                target: row.get("target"),
                join: row.get("join_sql"),
            })
            .collect();
        Ok(Self {
            names,
            foreign_keys,
            definitions: Mutex::new(Default::default()),
            restore,
        })
    }

    /// Table and predicate are private checked-in call sites; values always remain parameters.
    pub async fn seed(
        &self,
        tx: &WorldTransaction<'_>,
        table: &'static str,
        predicate: &'static str,
        values: &[&(dyn ToSql + Sync)],
    ) -> Result<u64, StoreError> {
        if !self.names.iter().any(|name| name == table) {
            return Err(invalid());
        }
        let tenant = tx.world().tenant_id.as_str();
        let world = tx.world().world_id.as_str();
        let mut parameters: Vec<&(dyn ToSql + Sync)> = vec![&tenant, &world];
        parameters.extend_from_slice(values);
        let sql = format!(
            "INSERT INTO pg_temp.world_delete_keep SELECT '{table}',t.ctid FROM public.{table} t WHERE t.tenant_id=$1 AND t.world_id=$2 AND ({predicate}) ON CONFLICT DO NOTHING"
        );
        tx.transaction
            .execute(&sql, &parameters)
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Execute))
    }

    pub async fn kept(
        &self,
        tx: &WorldTransaction<'_>,
        table: &'static str,
        columns: &'static str,
    ) -> Result<Vec<tokio_postgres::Row>, StoreError> {
        if !self.names.iter().any(|name| name == table) {
            return Err(invalid());
        }
        tx.transaction.query(&format!("SELECT {columns} FROM public.{table} t JOIN pg_temp.world_delete_keep k ON k.table_name='{table}' AND k.row_id=t.ctid WHERE t.tenant_id=$1 AND t.world_id=$2"),
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str()]).await.map_err(|error| StoreError::database(error, FailureStage::Read))
    }

    async fn children(
        &self,
        tx: &WorldTransaction<'_>,
        parent: &'static str,
        child: &'static str,
        join: &'static str,
    ) -> Result<u64, StoreError> {
        let sql = format!(
            "INSERT INTO pg_temp.world_delete_keep SELECT '{child}',c.ctid FROM public.{parent} p JOIN pg_temp.world_delete_keep k ON k.table_name='{parent}' AND k.row_id=p.ctid JOIN public.{child} c ON {join} WHERE p.tenant_id=$1 AND p.world_id=$2 ON CONFLICT DO NOTHING"
        );
        tx.transaction
            .execute(
                &sql,
                &[
                    &tx.world().tenant_id.as_str(),
                    &tx.world().world_id.as_str(),
                ],
            )
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Execute))
    }

    /// Retained safety rows are roots. Included rows propagate only after being marked.
    pub async fn close_foreign_keys(&self, tx: &WorldTransaction<'_>) -> Result<(), StoreError> {
        loop {
            let mut added = 0;
            for fk in &self.foreign_keys {
                let keep = if self.names.contains(&fk.source) {
                    format!(
                        "JOIN pg_temp.world_delete_keep k ON k.table_name='{}' AND k.row_id=s.ctid",
                        fk.source
                    )
                } else {
                    String::new()
                };
                if self.restore && fk.source == "world_runtime_head" && fk.target == "world_release_head" {
                    continue;
                }
                let sql = format!(
                    "INSERT INTO pg_temp.world_delete_keep SELECT '{}',t.ctid FROM public.{} s {keep} JOIN public.{} t ON {} WHERE s.tenant_id=$1 AND s.world_id=$2 ON CONFLICT DO NOTHING",
                    fk.target, fk.source, fk.target, fk.join
                );
                added += tx
                    .transaction
                    .execute(
                        &sql,
                        &[
                            &tx.world().tenant_id.as_str(),
                            &tx.world().world_id.as_str(),
                        ],
                    )
                    .await
                    .map_err(|error| StoreError::database(error, FailureStage::Execute))?;
            }
            // Canonical ownership children, never a blanket reverse-FK traversal.
            for (parent, child, join) in [
                (
                    "world_release",
                    "world_release_definition",
                    "(c.tenant_id,c.world_id,c.release_id)=(p.tenant_id,p.world_id,p.release_id)",
                ),
                (
                    "world_artifact_manifest",
                    "world_compile_dependency",
                    "(c.tenant_id,c.world_id,c.artifact_id)=(p.tenant_id,p.world_id,p.artifact_id)",
                ),
                (
                    "world_branch",
                    "world_branch_revision",
                    "(c.tenant_id,c.world_id,c.branch_id)=(p.tenant_id,p.world_id,p.branch_id)",
                ),
                (
                    "world_branch",
                    "world_branch_head",
                    "(c.tenant_id,c.world_id,c.branch_id)=(p.tenant_id,p.world_id,p.branch_id)",
                ),
                (
                    "world_candidate",
                    "world_candidate_revision",
                    "(c.tenant_id,c.world_id,c.candidate_id)=(p.tenant_id,p.world_id,p.candidate_id)",
                ),
                (
                    "world_candidate",
                    "world_candidate_head",
                    "(c.tenant_id,c.world_id,c.candidate_id)=(p.tenant_id,p.world_id,p.candidate_id)",
                ),
                (
                    "world_branch_revision",
                    "world_branch_derivation_revision",
                    "(c.tenant_id,c.world_id,c.branch_id,c.branch_revision)=(p.tenant_id,p.world_id,p.branch_id,p.revision)",
                ),
                (
                    "world_branch_derivation_revision",
                    "world_branch_derivation_head",
                    "(c.tenant_id,c.world_id,c.branch_id,c.branch_revision,c.assertion_id,c.revision)=(p.tenant_id,p.world_id,p.branch_id,p.branch_revision,p.assertion_id,p.revision)",
                ),
                (
                    "world_branch_revision",
                    "world_change_set",
                    "(c.tenant_id,c.world_id,c.branch_id,c.branch_revision)=(p.tenant_id,p.world_id,p.branch_id,p.revision)",
                ),
                (
                    "world_change_set",
                    "world_candidate_revision",
                    "(c.tenant_id,c.world_id,c.change_set_id,c.revision)=(p.tenant_id,p.world_id,p.change_set_id,p.revision)",
                ),
                (
                    "world_object_identity",
                    "world_identity_revision",
                    "c.tenant_id=p.tenant_id AND c.world_id=p.world_id AND c.subject_kind='object' AND c.subject_id=p.object_id AND c.revision=p.revision",
                ),
                (
                    "world_relation_identity",
                    "world_identity_revision",
                    "c.tenant_id=p.tenant_id AND c.world_id=p.world_id AND c.subject_kind='relation' AND c.subject_id=p.relation_id AND c.revision=p.revision",
                ),
                (
                    "world_object_identity",
                    "world_identity_influence",
                    "c.tenant_id=p.tenant_id AND c.world_id=p.world_id AND c.subject_kind='object' AND c.subject_id=p.object_id",
                ),
                (
                    "world_relation_identity",
                    "world_identity_influence",
                    "c.tenant_id=p.tenant_id AND c.world_id=p.world_id AND c.subject_kind='relation' AND c.subject_id=p.relation_id",
                ),
                (
                    "world_object_identity",
                    "world_identity_resolution_member",
                    "c.tenant_id=p.tenant_id AND c.world_id=p.world_id AND ((c.source_kind='object' AND c.source_id=p.object_id) OR (c.target_kind='object' AND c.target_id=p.object_id))",
                ),
                (
                    "world_relation_identity",
                    "world_identity_resolution_member",
                    "c.tenant_id=p.tenant_id AND c.world_id=p.world_id AND ((c.source_kind='relation' AND c.source_id=p.relation_id) OR (c.target_kind='relation' AND c.target_id=p.relation_id))",
                ),
                (
                    "world_identity_resolution",
                    "world_identity_resolution_member",
                    "(c.tenant_id,c.world_id,c.operation_id,c.revision)=(p.tenant_id,p.world_id,p.operation_id,p.revision)",
                ),
                (
                    "world_alias_range",
                    "world_source_alias_current",
                    "(c.tenant_id,c.world_id,c.source_id,c.namespace,c.native_key)=(p.tenant_id,p.world_id,p.source_id,p.namespace,p.native_key)",
                ),
                (
                    "world_alias_range",
                    "world_source_alias_revision",
                    "(c.tenant_id,c.world_id,c.source_id,c.namespace,c.native_key)=(p.tenant_id,p.world_id,p.source_id,p.namespace,p.native_key)",
                ),
                (
                    "world_branch_revision",
                    "world_branch_identity_reservation",
                    "(c.tenant_id,c.world_id,c.branch_id,c.branch_revision)=(p.tenant_id,p.world_id,p.branch_id,p.revision)",
                ),
                (
                    "world_branch_identity_reservation",
                    "world_branch_identity_promotion",
                    "(c.tenant_id,c.world_id,c.reservation_digest)=(p.tenant_id,p.world_id,p.reservation_digest)",
                ),
                (
                    "world_definition_revision",
                    "world_definition_dependency",
                    "(c.tenant_id,c.world_id,c.definition_id,c.revision)=(p.tenant_id,p.world_id,p.definition_id,p.revision)",
                ),
                (
                    "world_definition_revision",
                    "world_definition_lineage",
                    "(c.tenant_id,c.world_id,c.definition_id,c.revision)=(p.tenant_id,p.world_id,p.definition_id,p.revision)",
                ),
                (
                    "world_definition_revision",
                    "world_definition_evidence_head",
                    "(c.tenant_id,c.world_id,c.definition_id,c.definition_revision)=(p.tenant_id,p.world_id,p.definition_id,p.revision)",
                ),
                (
                    "world_definition_evidence_revision",
                    "world_definition_evidence",
                    "(c.tenant_id,c.world_id,c.definition_id,c.definition_revision,c.binding_revision)=(p.tenant_id,p.world_id,p.definition_id,p.definition_revision,p.revision)",
                ),
                (
                    "world_assertion_revision",
                    "world_assertion_role",
                    "(c.tenant_id,c.world_id,c.assertion_id,c.revision)=(p.tenant_id,p.world_id,p.assertion_id,p.revision)",
                ),
                (
                    "world_assertion_revision",
                    "world_assertion_evidence",
                    "(c.tenant_id,c.world_id,c.assertion_id,c.revision)=(p.tenant_id,p.world_id,p.assertion_id,p.revision)",
                ),
                (
                    "world_evidence_revision",
                    "world_evidence_derived_from",
                    "(c.tenant_id,c.world_id,c.evidence_id,c.revision)=(p.tenant_id,p.world_id,p.evidence_id,p.revision)",
                ),
                (
                    "world_support_revision",
                    "world_support_premise",
                    "(c.tenant_id,c.world_id,c.support_id,c.support_revision)=(p.tenant_id,p.world_id,p.support_id,p.revision)",
                ),
                (
                    "world_watch",
                    "world_watch_field",
                    "(c.tenant_id,c.world_id,c.watch_id)=(p.tenant_id,p.world_id,p.watch_id)",
                ),
                (
                    "world_watch",
                    "world_watch_range",
                    "(c.tenant_id,c.world_id,c.watch_id)=(p.tenant_id,p.world_id,p.watch_id)",
                ),
            ] {
                if self.restore
                    && (!super::archive::history_table(child)
                        || matches!((parent, child),
                            ("world_branch", "world_branch_revision")
                            | ("world_candidate", "world_candidate_revision")))
                {
                    continue;
                }
                added += self.children(tx, parent, child, join).await?;
            }
            if added == 0 {
                return Ok(());
            }
        }
    }

    pub fn restoring(&self) -> bool {
        self.restore
    }

    pub fn definition_references(&self) -> (Vec<DefinitionRef>, Vec<DefinitionId>) {
        let references = self
            .definitions
            .lock()
            .expect("retention references poisoned");
        (
            references.0.iter().cloned().collect(),
            references.1.iter().cloned().collect(),
        )
    }

    async fn definition(
        &self,
        tx: &WorldTransaction<'_>,
        reference: &DefinitionRef,
    ) -> Result<(), StoreError> {
        if &reference.world != tx.world() {
            return Err(invalid());
        }
        self.definitions
            .lock()
            .expect("retention references poisoned")
            .0
            .insert(reference.clone());
        self.seed(
            tx,
            "world_definition_revision",
            "definition_id=$3 AND revision=$4",
            &[&reference.id.as_str(), &number(reference.revision.0)?],
        )
        .await?;
        Ok(())
    }

    pub async fn roots(
        &self,
        tx: &WorldTransaction<'_>,
        roots: RetentionRoots,
    ) -> Result<(), StoreError> {
        for scope in roots.scopes {
            self.seed(
                tx,
                "world_scope_revision",
                "scope_id=$3 AND revision=1",
                &[&scope.as_str()],
            )
            .await?;
        }
        for resource in roots.resources {
            self.resource(tx, resource).await?;
        }
        for reference in roots.definitions {
            self.definition(tx, &reference).await?;
        }
        for reference in roots.evidence {
            if &reference.world != tx.world() {
                return Err(invalid());
            }
            self.seed(
                tx,
                "world_evidence_revision",
                "evidence_id=$3 AND revision=$4",
                &[&reference.id.as_str(), &number(reference.revision.0)?],
            )
            .await?;
        }
        for id in roots.releases {
            self.seed(tx, "world_release", "release_id=$3", &[&id.as_str()])
                .await?;
        }
        for reference in roots.branches {
            if &reference.world != tx.world() {
                return Err(invalid());
            }
            self.seed(
                tx,
                "world_branch_revision",
                "branch_id=$3 AND revision=$4",
                &[&reference.id.as_str(), &number(reference.revision.0)?],
            )
            .await?;
        }
        for reference in roots.source_versions {
            if &reference.world != tx.world() {
                return Err(invalid());
            }
            self.seed(
                tx,
                "world_source_version",
                "source_id=$3 AND version_id=$4",
                &[
                    &reference.source_id.as_str(),
                    &reference.version_id.as_str(),
                ],
            )
            .await?;
        }
        for id in roots.parse_artifacts {
            self.seed(
                tx,
                "world_parse_artifact",
                "artifact_id=$3",
                &[&id.as_str()],
            )
            .await?;
        }
        for reference in roots.schemas {
            if &reference.world != tx.world() {
                return Err(invalid());
            }
            self.seed(
                tx,
                "world_source_schema_revision",
                "schema_id=$3 AND revision=$4",
                &[&reference.id.as_str(), &number(reference.revision.0)?],
            )
            .await?;
        }
        for reference in roots.mappings {
            if &reference.world != tx.world() {
                return Err(invalid());
            }
            self.seed(
                tx,
                "world_schema_mapping_revision",
                "mapping_id=$3 AND revision=$4",
                &[&reference.id.as_str(), &number(reference.revision.0)?],
            )
            .await?;
        }
        for dependency in &roots.dependencies {
            self.dependency(tx, dependency).await?;
        }
        if !roots.sources.is_empty() || !roots.dependencies.is_empty() {
            let material = crate::sources::sync::retained_source_materials(
                tx,
                &roots.sources,
                &roots.dependencies,
            )
            .await
            .map_err(reference_error)?;
            Box::pin(self.roots(tx, material)).await?;
        }
        Ok(())
    }

    async fn dependency(
        &self,
        tx: &WorldTransaction<'_>,
        dependency: &ReadDependency,
    ) -> Result<(), StoreError> {
        match dependency {
            ReadDependency::Assertion { reference } => {
                if &reference.world != tx.world() {
                    return Err(invalid());
                }
                self.seed(
                    tx,
                    "world_assertion_revision",
                    "assertion_id=$3 AND revision=$4",
                    &[&reference.id.as_str(), &number(reference.revision.0)?],
                )
                .await?;
            }
            ReadDependency::Evidence { reference } => {
                if &reference.world != tx.world() {
                    return Err(invalid());
                }
                self.seed(
                    tx,
                    "world_evidence_revision",
                    "evidence_id=$3 AND revision=$4",
                    &[&reference.id.as_str(), &number(reference.revision.0)?],
                )
                .await?;
            }
            ReadDependency::Definition { reference } => {
                self.definition(tx, reference).await?;
            }
            ReadDependency::Watch { id, .. } => {
                self.seed(tx, "world_watch", "watch_id=$3", &[&id.as_str()])
                    .await?;
            }
            ReadDependency::Identity { subject, revision } => {
                let (kind, id) = subject_key(subject);
                self.seed(
                    tx,
                    "world_identity_revision",
                    "subject_kind=$3 AND subject_id=$4 AND revision=$5",
                    &[&kind, &id, &number(revision.0)?],
                )
                .await?;
                self.resource(
                    tx,
                    match subject {
                        SubjectRef::Object { id } => ResourceRef::Object { id: id.clone() },
                        SubjectRef::Relation { id } => ResourceRef::Relation { id: id.clone() },
                    },
                )
                .await?;
            }
            ReadDependency::AliasRange { digest, .. } => {
                self.seed(
                    tx,
                    "world_alias_range",
                    "range_digest=$3",
                    &[&digest.as_str()],
                )
                .await?;
            }
            ReadDependency::Source { binding, .. } => {
                self.definition(tx, binding).await?;
                self.seed(
                    tx,
                    "world_source_binding_revision",
                    "binding_id=$3 AND revision=$4",
                    &[&binding.id.as_str(), &number(binding.revision.0)?],
                )
                .await?;
            }
            ReadDependency::SourceMapping {
                mapping, binding, ..
            } => {
                if &mapping.world != tx.world() || &binding.world != tx.world() {
                    return Err(invalid());
                }
                self.seed(
                    tx,
                    "world_schema_mapping_revision",
                    "mapping_id=$3 AND revision=$4",
                    &[&mapping.id.as_str(), &number(mapping.revision.0)?],
                )
                .await?;
                self.definition(tx, binding).await?;
            }
            ReadDependency::SourceField { schema, .. } => {
                if &schema.world != tx.world() {
                    return Err(invalid());
                }
                self.seed(
                    tx,
                    "world_source_schema_revision",
                    "schema_id=$3 AND revision=$4",
                    &[&schema.id.as_str(), &number(schema.revision.0)?],
                )
                .await?;
            }
            ReadDependency::TimeBoundary { .. } => {}
        }
        Ok(())
    }

    async fn resource(
        &self,
        tx: &WorldTransaction<'_>,
        resource: ResourceRef,
    ) -> Result<(), StoreError> {
        let (table, predicate, id) = match resource {
            ResourceRef::Object { id } => ("world_object_identity", "object_id=$3", id.to_string()),
            ResourceRef::Relation { id } => {
                ("world_relation_identity", "relation_id=$3", id.to_string())
            }
            ResourceRef::Definition { id } => {
                self.definitions
                    .lock()
                    .expect("retention references poisoned")
                    .1
                    .insert(id.clone());
                (
                    "world_definition_revision",
                    "definition_id=$3",
                    id.to_string(),
                )
            }
            ResourceRef::Assertion { id } => (
                "world_assertion_revision",
                "assertion_id=$3",
                id.to_string(),
            ),
            ResourceRef::Evidence { id } => {
                ("world_evidence_revision", "evidence_id=$3", id.to_string())
            }
            ResourceRef::Support { id } => {
                ("world_support_revision", "support_id=$3", id.to_string())
            }
            ResourceRef::Watch { id } => ("world_watch", "watch_id=$3", id.to_string()),
            ResourceRef::Head { .. } if self.restore => return Ok(()),
            ResourceRef::Head { channel } => {
                ("world_release_head", "channel=$3", channel.to_string())
            }
            ResourceRef::Source { id } => ("world_source_version", "source_id=$3", id.to_string()),
            ResourceRef::ChangeSet { id } => {
                ("world_change_set", "change_set_id=$3", id.to_string())
            }
            ResourceRef::Branch { id } => ("world_branch", "branch_id=$3", id.to_string()),
            // These domains are retained in full, not archive-replaced business rows.
            ResourceRef::State { .. }
            | ResourceRef::Binding { .. }
            | ResourceRef::Operation { .. }
            | ResourceRef::Package { .. }
            | ResourceRef::Task { .. }
            | ResourceRef::Case { .. }
            | ResourceRef::TestCase { .. }
            | ResourceRef::Suite { .. }
            | ResourceRef::Evaluation { .. } => return Ok(()),
        };
        self.seed(tx, table, predicate, &[&id]).await?;
        Ok(())
    }

    pub async fn delete_unmarked(&self, tx: &WorldTransaction<'_>) -> Result<(), StoreError> {
        for table in self.names.iter().rev() {
            let sql = format!(
                "DELETE FROM public.{table} t WHERE tenant_id=$1 AND world_id=$2 AND NOT EXISTS(SELECT 1 FROM pg_temp.world_delete_keep k WHERE k.table_name='{table}' AND k.row_id=t.ctid)"
            );
            tx.transaction
                .execute(
                    &sql,
                    &[
                        &tx.world().tenant_id.as_str(),
                        &tx.world().world_id.as_str(),
                    ],
                )
                .await
                .map_err(|error| StoreError::database(error, FailureStage::Execute))?;
        }
        Ok(())
    }
}

fn subject_key(subject: &SubjectRef) -> (&'static str, &str) {
    match subject {
        SubjectRef::Object { id } => ("object", id.as_str()),
        SubjectRef::Relation { id } => ("relation", id.as_str()),
    }
}
fn number(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid())
}
