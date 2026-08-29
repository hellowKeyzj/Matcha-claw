use std::{
    collections::BTreeMap,
    fmt, fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    Dependency, DependencyKind, TeamSkillPackage, TeamSkillPackageError, TeamSkillPackageReader,
    TeamSkillPackageRoot,
    materialization::{
        ManualTeamMaterializationFacts, ManualTeamRoleSelection, TeamMaterializationFacts,
        TeamSkillMaterializationFacts,
    },
};
use crate::{IdempotencyKey, RuntimeEndpointReference, TeamId};

/// Opaque, stable identity for one locally authorized TeamSkill package root.
///
/// The canonical root never crosses this boundary. The identity is derived only
/// inside the package owner and is safe to persist or return to Delivery.
#[derive(Clone, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct TeamSkillSelectionId(String);

impl TeamSkillSelectionId {
    pub fn parse(value: impl Into<String>) -> Result<Self, TeamSkillSelectionError> {
        let value = value.into();
        let Some(digest) = value.strip_prefix("teamskill:v1:") else {
            return Err(TeamSkillSelectionError::InvalidSelection);
        };
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(TeamSkillSelectionError::InvalidSelection);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for TeamSkillSelectionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamSkillSelectionId([REDACTED])")
    }
}

/// The only owner that resolves a raw package root. Callers retain only the
/// opaque selection identity returned by `authorize`.
///
/// Durable, owner-private selection registry.
///
/// Persistence stores only the canonical root necessary to re-open a previously
/// authorized selection. Its serialized form is private to this Domain owner;
/// Delivery continues to receive only `TeamSkillSelectionId`.
pub struct TeamSkillSelectionResolver {
    path: PathBuf,
    selections: BTreeMap<TeamSkillSelectionId, TeamSkillPackageRoot>,
}

impl TeamSkillSelectionResolver {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, TeamSkillSelectionError> {
        let path = path.as_ref().to_path_buf();
        let selections = match fs::read_to_string(&path) {
            Ok(document) => decode_registry(&document)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(_) => return Err(TeamSkillSelectionError::Unavailable),
        };
        Ok(Self { path, selections })
    }

    #[cfg(test)]
    fn temporary() -> Self {
        static NEXT_TEST_REGISTRY: AtomicU64 = AtomicU64::new(0);
        let sequence = NEXT_TEST_REGISTRY.fetch_add(1, Ordering::Relaxed);
        Self {
            path: std::env::temp_dir().join(format!(
                "matchaclaw-team-skill-registry-test-{}-{sequence}.json",
                std::process::id(),
            )),
            selections: BTreeMap::new(),
        }
    }

    pub fn authorize(
        &mut self,
        root: impl AsRef<Path>,
    ) -> Result<TeamSkillSelectionId, TeamSkillSelectionError> {
        let root = TeamSkillPackageRoot::open(root).map_err(TeamSkillSelectionError::from)?;
        let selection_id = selection_id(&root);
        if self.selections.contains_key(&selection_id) {
            return Ok(selection_id);
        }
        self.selections.insert(selection_id.clone(), root);
        if self.persist().is_err() {
            self.selections.remove(&selection_id);
            return Err(TeamSkillSelectionError::Unavailable);
        }
        Ok(selection_id)
    }

    fn persist(&self) -> Result<(), TeamSkillSelectionError> {
        let document = encode_registry(&self.selections)?;
        let parent = self
            .path
            .parent()
            .ok_or(TeamSkillSelectionError::Unavailable)?;
        fs::create_dir_all(parent).map_err(|_| TeamSkillSelectionError::Unavailable)?;
        let temporary = temporary_path(&self.path)?;
        fs::write(&temporary, document).map_err(|_| TeamSkillSelectionError::Unavailable)?;
        replace_registry(&temporary, &self.path)
    }

    pub fn validate(&self, selection_id: &TeamSkillSelectionId) -> TeamSkillPackageValidation {
        match self.read(selection_id) {
            Ok(package) => TeamSkillPackageValidation::Valid {
                package: TeamSkillPackageView::from_package(selection_id.clone(), &package),
            },
            Err(TeamSkillSelectionError::InvalidSelection) => TeamSkillPackageValidation::Invalid,
            Err(TeamSkillSelectionError::Unavailable) => TeamSkillPackageValidation::Unavailable,
        }
    }

    pub fn with_package<T>(
        &self,
        selection_id: &TeamSkillSelectionId,
        consume: impl FnOnce(&TeamSkillPackage) -> T,
    ) -> Result<T, TeamSkillSelectionError> {
        let package = self.read(selection_id)?;
        Ok(consume(&package))
    }

    pub fn dependency_plan(
        &self,
        selection_id: &TeamSkillSelectionId,
        catalog: &TeamSkillDependencyCatalog,
    ) -> TeamSkillDependencyPlanResult {
        let package = match self.read(selection_id) {
            Ok(package) => package,
            Err(TeamSkillSelectionError::InvalidSelection) => {
                return TeamSkillDependencyPlanResult::Invalid;
            }
            Err(TeamSkillSelectionError::Unavailable) => {
                return TeamSkillDependencyPlanResult::Unavailable;
            }
        };
        TeamSkillDependencyPlanResult::Available {
            plan: TeamSkillDependencyPlan::from_package(selection_id.clone(), &package, catalog),
        }
    }

    pub fn compile_team_skill_materialization(
        &self,
        selection_id: &TeamSkillSelectionId,
        team_id: TeamId,
        endpoint: RuntimeEndpointReference,
        idempotency_key: IdempotencyKey,
    ) -> TeamMaterializationCompilationResult {
        let package = match self.read(selection_id) {
            Ok(package) => package,
            Err(TeamSkillSelectionError::InvalidSelection) => {
                return TeamMaterializationCompilationResult::Invalid;
            }
            Err(TeamSkillSelectionError::Unavailable) => {
                return TeamMaterializationCompilationResult::Unavailable;
            }
        };
        match TeamSkillMaterializationFacts::compile(
            selection_id.clone(),
            &package,
            team_id,
            endpoint,
            idempotency_key,
        ) {
            Ok(facts) => TeamMaterializationCompilationResult::Available {
                facts: TeamMaterializationFacts::TeamSkill(facts),
            },
            Err(_) => TeamMaterializationCompilationResult::Invalid,
        }
    }

    pub fn compile_manual_materialization(
        &self,
        team_id: TeamId,
        team_name: impl Into<String>,
        endpoint: RuntimeEndpointReference,
        roles: Vec<ManualTeamRoleSelection>,
        idempotency_key: IdempotencyKey,
    ) -> TeamMaterializationCompilationResult {
        match ManualTeamMaterializationFacts::compile(
            team_id,
            team_name,
            endpoint,
            roles,
            idempotency_key,
        ) {
            Ok(facts) => TeamMaterializationCompilationResult::Available {
                facts: TeamMaterializationFacts::Manual(facts),
            },
            Err(_) => TeamMaterializationCompilationResult::Invalid,
        }
    }

    pub fn execute(
        &mut self,
        command: TeamSkillSelectionCommand,
    ) -> TeamSkillSelectionCommandResult {
        match command {
            TeamSkillSelectionCommand::Authorize { package_root } => {
                TeamSkillSelectionCommandResult::Authorized(TeamSkillAuthorizationResult::from(
                    self.authorize(package_root),
                ))
            }
            TeamSkillSelectionCommand::Validate { selection_id } => {
                TeamSkillSelectionCommandResult::Validated(self.validate(&selection_id))
            }
            TeamSkillSelectionCommand::DependencyPlan {
                selection_id,
                catalog,
            } => TeamSkillSelectionCommandResult::DependencyPlan(
                self.dependency_plan(&selection_id, &catalog),
            ),
            TeamSkillSelectionCommand::CompileMaterialization {
                selection_id,
                team_id,
                endpoint,
                idempotency_key,
            } => TeamSkillSelectionCommandResult::Materialization(
                self.compile_team_skill_materialization(
                    &selection_id,
                    team_id,
                    endpoint,
                    idempotency_key,
                ),
            ),
            TeamSkillSelectionCommand::CompileManualMaterialization {
                team_id,
                team_name,
                endpoint,
                roles,
                idempotency_key,
            } => TeamSkillSelectionCommandResult::Materialization(
                self.compile_manual_materialization(
                    team_id,
                    team_name,
                    endpoint,
                    roles,
                    idempotency_key,
                ),
            ),
        }
    }

    fn read(
        &self,
        selection_id: &TeamSkillSelectionId,
    ) -> Result<TeamSkillPackage, TeamSkillSelectionError> {
        let root = self
            .selections
            .get(selection_id)
            .ok_or(TeamSkillSelectionError::Unavailable)?;
        TeamSkillPackageReader::new(root.clone())
            .read()
            .map_err(TeamSkillSelectionError::from)
    }
}

/// Package-owner commands consumed by a Host adapter. `Authorize` is the only command that
/// accepts the legacy package path; canonicalization and private registry persistence happen
/// before the command returns.
#[derive(Clone, Eq, PartialEq)]
pub enum TeamSkillSelectionCommand {
    Authorize {
        package_root: PathBuf,
    },
    Validate {
        selection_id: TeamSkillSelectionId,
    },
    DependencyPlan {
        selection_id: TeamSkillSelectionId,
        catalog: TeamSkillDependencyCatalog,
    },
    CompileMaterialization {
        selection_id: TeamSkillSelectionId,
        team_id: TeamId,
        endpoint: RuntimeEndpointReference,
        idempotency_key: IdempotencyKey,
    },
    CompileManualMaterialization {
        team_id: TeamId,
        team_name: String,
        endpoint: RuntimeEndpointReference,
        roles: Vec<ManualTeamRoleSelection>,
        idempotency_key: IdempotencyKey,
    },
}

impl fmt::Debug for TeamSkillSelectionCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Authorize { .. } => formatter
                .debug_struct("TeamSkillSelectionCommand::Authorize")
                .field("package_root", &"[REDACTED]")
                .finish(),
            Self::Validate { selection_id } => formatter
                .debug_struct("TeamSkillSelectionCommand::Validate")
                .field("selection_id", selection_id)
                .finish(),
            Self::DependencyPlan {
                selection_id,
                catalog,
            } => formatter
                .debug_struct("TeamSkillSelectionCommand::DependencyPlan")
                .field("selection_id", selection_id)
                .field("catalog", catalog)
                .finish(),
            Self::CompileMaterialization {
                selection_id,
                team_id,
                endpoint,
                idempotency_key,
            } => formatter
                .debug_struct("TeamSkillSelectionCommand::CompileMaterialization")
                .field("selection_id", selection_id)
                .field("team_id", team_id)
                .field("endpoint", endpoint)
                .field("idempotency_key", idempotency_key)
                .finish(),
            Self::CompileManualMaterialization {
                team_id,
                team_name,
                endpoint,
                roles,
                idempotency_key,
            } => formatter
                .debug_struct("TeamSkillSelectionCommand::CompileManualMaterialization")
                .field("team_id", team_id)
                .field("team_name", team_name)
                .field("endpoint", endpoint)
                .field("roles", roles)
                .field("idempotency_key", idempotency_key)
                .finish(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamSkillAuthorizationResult {
    Authorized(TeamSkillSelectionId),
    Invalid,
    Unavailable,
}

impl From<Result<TeamSkillSelectionId, TeamSkillSelectionError>> for TeamSkillAuthorizationResult {
    fn from(result: Result<TeamSkillSelectionId, TeamSkillSelectionError>) -> Self {
        match result {
            Ok(selection_id) => Self::Authorized(selection_id),
            Err(TeamSkillSelectionError::InvalidSelection) => Self::Invalid,
            Err(TeamSkillSelectionError::Unavailable) => Self::Unavailable,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMaterializationCompilationResult {
    Available {
        facts: super::TeamMaterializationFacts,
    },
    Invalid,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamSkillSelectionCommandResult {
    Authorized(TeamSkillAuthorizationResult),
    Validated(TeamSkillPackageValidation),
    DependencyPlan(TeamSkillDependencyPlanResult),
    Materialization(TeamMaterializationCompilationResult),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamSkillSelectionError {
    InvalidSelection,
    Unavailable,
}

impl From<TeamSkillPackageError> for TeamSkillSelectionError {
    fn from(value: TeamSkillPackageError) -> Self {
        match value {
            TeamSkillPackageError::Invalid => Self::InvalidSelection,
            TeamSkillPackageError::Unavailable => Self::Unavailable,
        }
    }
}

pub fn validate_team_skill_package(root: impl AsRef<Path>) -> TeamSkillPackageValidation {
    let root = match TeamSkillPackageRoot::open(root) {
        Ok(root) => root,
        Err(TeamSkillPackageError::Invalid) => return TeamSkillPackageValidation::Invalid,
        Err(TeamSkillPackageError::Unavailable) => return TeamSkillPackageValidation::Unavailable,
    };
    let selection_id = selection_id(&root);
    match TeamSkillPackageReader::new(root).read() {
        Ok(package) => TeamSkillPackageValidation::Valid {
            package: TeamSkillPackageView::from_package(selection_id, &package),
        },
        Err(TeamSkillPackageError::Invalid) => TeamSkillPackageValidation::Invalid,
        Err(TeamSkillPackageError::Unavailable) => TeamSkillPackageValidation::Unavailable,
    }
}

pub fn plan_team_skill_dependencies(root: impl AsRef<Path>) -> TeamSkillDependencyPlanResult {
    let root = match TeamSkillPackageRoot::open(root) {
        Ok(root) => root,
        Err(TeamSkillPackageError::Invalid) => return TeamSkillDependencyPlanResult::Invalid,
        Err(TeamSkillPackageError::Unavailable) => {
            return TeamSkillDependencyPlanResult::Unavailable;
        }
    };
    let selection_id = selection_id(&root);
    match TeamSkillPackageReader::new(root).read() {
        Ok(package) => TeamSkillDependencyPlanResult::Available {
            plan: TeamSkillDependencyPlan::from_package(
                selection_id,
                &package,
                &TeamSkillDependencyCatalog::from_installed_names(std::iter::empty()),
            ),
        },
        Err(TeamSkillPackageError::Invalid) => TeamSkillDependencyPlanResult::Invalid,
        Err(TeamSkillPackageError::Unavailable) => TeamSkillDependencyPlanResult::Unavailable,
    }
}

impl fmt::Display for TeamSkillSelectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidSelection => "TeamSkill selection is invalid",
            Self::Unavailable => "TeamSkill selection is unavailable",
        })
    }
}

impl std::error::Error for TeamSkillSelectionError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum TeamSkillPackageValidation {
    Valid { package: TeamSkillPackageView },
    Invalid,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillPackageView {
    selection_id: TeamSkillSelectionId,
    name: String,
    version: String,
    kind: &'static str,
    description: String,
}

impl TeamSkillPackageView {
    fn from_package(selection_id: TeamSkillSelectionId, package: &TeamSkillPackage) -> Self {
        Self {
            selection_id,
            name: package.name().to_owned(),
            version: package.version().to_owned(),
            kind: "team-skill",
            description: package.description().to_owned(),
        }
    }

    pub fn selection_id(&self) -> &TeamSkillSelectionId {
        &self.selection_id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn description(&self) -> &str {
        &self.description
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TeamSkillDependencyCatalog {
    available: Vec<String>,
}

impl TeamSkillDependencyCatalog {
    pub fn from_installed_names(names: impl IntoIterator<Item = String>) -> Self {
        let mut available = names
            .into_iter()
            .filter_map(|name| normalize_identity(&name))
            .collect::<Vec<_>>();
        available.sort();
        available.dedup();
        Self { available }
    }

    fn contains(&self, name: &str) -> bool {
        normalize_identity(name).is_some_and(|name| self.available.binary_search(&name).is_ok())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum TeamSkillDependencyPlanResult {
    Available { plan: TeamSkillDependencyPlan },
    Invalid,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillDependencyPlan {
    selection_id: TeamSkillSelectionId,
    package_name: String,
    package_version: String,
    items: Vec<TeamSkillDependencyPlanItem>,
    can_proceed: bool,
}

impl TeamSkillDependencyPlan {
    fn from_package(
        selection_id: TeamSkillSelectionId,
        package: &TeamSkillPackage,
        catalog: &TeamSkillDependencyCatalog,
    ) -> Self {
        let items = package
            .dependencies()
            .iter()
            .map(|dependency| TeamSkillDependencyPlanItem::from_dependency(dependency, catalog))
            .collect::<Vec<_>>();
        let can_proceed = items
            .iter()
            .all(|item| !item.required || item.status == TeamSkillDependencyStatus::Available);
        Self {
            selection_id,
            package_name: package.name().to_owned(),
            package_version: package.version().to_owned(),
            items,
            can_proceed,
        }
    }

    pub fn selection_id(&self) -> &TeamSkillSelectionId {
        &self.selection_id
    }

    pub fn items(&self) -> &[TeamSkillDependencyPlanItem] {
        &self.items
    }

    pub const fn can_proceed(&self) -> bool {
        self.can_proceed
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillDependencyPlanItem {
    kind: TeamSkillDependencyKind,
    name: String,
    required: bool,
    purpose: String,
    status: TeamSkillDependencyStatus,
    severity: TeamSkillDependencySeverity,
    installable: bool,
}

impl TeamSkillDependencyPlanItem {
    fn from_dependency(dependency: &Dependency, catalog: &TeamSkillDependencyCatalog) -> Self {
        let available = matches!(dependency.kind(), DependencyKind::Tool)
            && dependency
                .source()
                .is_some_and(|source| normalize_identity(source).as_deref() == Some("builtin"))
            || catalog.contains(dependency.name());
        let status = if available {
            TeamSkillDependencyStatus::Available
        } else {
            TeamSkillDependencyStatus::Missing
        };
        Self {
            kind: match dependency.kind() {
                DependencyKind::Skill => TeamSkillDependencyKind::Skill,
                DependencyKind::Tool => TeamSkillDependencyKind::Tool,
            },
            name: dependency.name().to_owned(),
            required: dependency.required(),
            purpose: dependency.purpose().to_owned(),
            status,
            severity: match (available, dependency.required()) {
                (true, _) => TeamSkillDependencySeverity::Ok,
                (false, true) => TeamSkillDependencySeverity::Blocker,
                (false, false) => TeamSkillDependencySeverity::Warning,
            },
            installable: !available && dependency.source().is_some_and(is_installable_source),
        }
    }

    pub const fn status(&self) -> TeamSkillDependencyStatus {
        self.status
    }

    pub const fn severity(&self) -> TeamSkillDependencySeverity {
        self.severity
    }

    pub const fn installable(&self) -> bool {
        self.installable
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamSkillDependencyKind {
    Skill,
    Tool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamSkillDependencyStatus {
    Available,
    Missing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamSkillDependencySeverity {
    Ok,
    Warning,
    Blocker,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct RegistryDocument {
    selections: BTreeMap<String, String>,
}

fn decode_registry(
    document: &str,
) -> Result<BTreeMap<TeamSkillSelectionId, TeamSkillPackageRoot>, TeamSkillSelectionError> {
    let document: RegistryDocument =
        serde_json::from_str(document).map_err(|_| TeamSkillSelectionError::Unavailable)?;
    document
        .selections
        .into_iter()
        .map(|(stored_identity, root)| {
            let identity = TeamSkillSelectionId::parse(stored_identity)?;
            let root = TeamSkillPackageRoot::open(root).map_err(TeamSkillSelectionError::from)?;
            (identity == selection_id(&root))
                .then_some((identity, root))
                .ok_or(TeamSkillSelectionError::Unavailable)
        })
        .collect()
}

fn encode_registry(
    selections: &BTreeMap<TeamSkillSelectionId, TeamSkillPackageRoot>,
) -> Result<String, TeamSkillSelectionError> {
    let selections = selections
        .iter()
        .map(|(selection_id, root)| {
            (
                selection_id.as_str().to_owned(),
                root.canonical_path().to_string_lossy().into_owned(),
            )
        })
        .collect();
    serde_json::to_string(&RegistryDocument { selections })
        .map_err(|_| TeamSkillSelectionError::Unavailable)
}

fn selection_id(root: &TeamSkillPackageRoot) -> TeamSkillSelectionId {
    let mut digest = Sha256::new();
    digest.update(root.canonical_path().as_os_str().as_encoded_bytes());
    TeamSkillSelectionId(format!("teamskill:v1:{:x}", digest.finalize()))
}

fn temporary_path(path: &Path) -> Result<PathBuf, TeamSkillSelectionError> {
    static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(0);
    let sequence = NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(TeamSkillSelectionError::Unavailable)?;
    Ok(path.with_file_name(format!(
        ".{file_name}.{}.{}.next",
        std::process::id(),
        sequence,
    )))
}

fn replace_registry(temporary: &Path, destination: &Path) -> Result<(), TeamSkillSelectionError> {
    fs::rename(temporary, destination).map_err(|_| TeamSkillSelectionError::Unavailable)
}

fn normalize_identity(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    (!value.is_empty()).then_some(value)
}

fn is_installable_source(source: &str) -> bool {
    let source = source.trim();
    source.to_ascii_lowercase().starts_with("clawhub:")
        || source.starts_with('.')
        || source.starts_with('/')
        || source.starts_with('~')
        || source
            .as_bytes()
            .get(1)
            .is_some_and(|character| *character == b':')
        || source.contains(['/', '\\'])
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use serde_json::{json, to_value};

    use super::*;

    fn registry_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "matchaclaw-team-skill-registry-{name}-{unique}.json"
        ))
    }

    fn package_root(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("matchaclaw-team-skill-selection-{name}-{unique}"));
        fs::create_dir_all(root.join("roles")).unwrap();
        fs::write(root.join("SKILL.md"), "---\nname: research\nversion: 1.0.0\ndescription: Research package\nkind: team-skill\nroles:\n  - id: researcher\n    purpose: Research facts\n---\n# Research\n").unwrap();
        fs::write(root.join("workflow.md"), "# Workflow").unwrap();
        fs::write(root.join("dependencies.yaml"), "skills:\n  - name: web\n    required: true\n    purpose: Search\n    source: clawhub:web\ntools:\n  - name: browser\n    required: false\n    purpose: Browse\n    source: builtin\n").unwrap();
        fs::write(root.join("roles/researcher.md"), "# Researcher").unwrap();
        root
    }

    #[test]
    fn selection_identity_is_stable_and_never_projects_the_root() {
        let root = package_root("stable");
        let mut resolver = TeamSkillSelectionResolver::temporary();
        let first = resolver.authorize(&root).unwrap();
        let second = resolver.authorize(&root).unwrap();
        assert_eq!(first, second);
        assert!(first.as_str().starts_with("teamskill:v1:"));

        let validation = resolver.validate(&first);
        let wire = to_value(validation).unwrap();
        assert_eq!(wire["status"], "valid");
        assert_eq!(wire["package"]["selectionId"], first.as_str());
        assert!(
            !wire
                .to_string()
                .contains(&root.to_string_lossy().to_string())
        );
        assert!(!format!("{first:?}").contains(&root.to_string_lossy().to_string()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reopens_authorized_selection_without_projecting_its_root() {
        let root = package_root("durable");
        let registry = registry_path("durable");
        let selection = TeamSkillSelectionResolver::open(&registry)
            .unwrap()
            .authorize(&root)
            .unwrap();
        let resolver = TeamSkillSelectionResolver::open(&registry).unwrap();

        assert!(matches!(
            resolver.validate(&selection),
            TeamSkillPackageValidation::Valid { .. }
        ));
        assert!(
            std::fs::read_to_string(&registry)
                .unwrap()
                .starts_with("{\"selections\":{")
        );
        fs::remove_file(registry).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validation_and_plan_are_sealed_and_preserve_dependency_decisions() {
        let root = package_root("plan");
        let mut resolver = TeamSkillSelectionResolver::temporary();
        let selection = resolver.authorize(&root).unwrap();
        let catalog = TeamSkillDependencyCatalog::from_installed_names(["web".to_owned()]);

        let validation = to_value(resolver.validate(&selection)).unwrap();
        assert_eq!(
            validation,
            json!({
                "status": "valid",
                "package": {
                    "selectionId": selection.as_str(),
                    "name": "research",
                    "version": "1.0.0",
                    "kind": "team-skill",
                    "description": "Research package",
                },
            })
        );

        let plan = resolver.dependency_plan(&selection, &catalog);
        let wire = to_value(plan).unwrap();
        assert_eq!(
            wire,
            json!({
                "status": "available",
                "plan": {
                    "selectionId": selection.as_str(),
                    "packageName": "research",
                    "packageVersion": "1.0.0",
                    "items": [
                        {
                            "kind": "skill",
                            "name": "web",
                            "required": true,
                            "purpose": "Search",
                            "status": "available",
                            "severity": "ok",
                            "installable": false,
                        },
                        {
                            "kind": "tool",
                            "name": "browser",
                            "required": false,
                            "purpose": "Browse",
                            "status": "available",
                            "severity": "ok",
                            "installable": false,
                        },
                    ],
                    "canProceed": true,
                },
            })
        );
        assert!(!wire.to_string().contains("source"));
        assert!(
            !wire
                .to_string()
                .contains(&root.to_string_lossy().to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selection_rejects_unknown_ids_and_propagates_invalid_packages_without_paths() {
        let root = package_root("invalid");
        let mut resolver = TeamSkillSelectionResolver::temporary();
        let selection = resolver.authorize(&root).unwrap();
        fs::write(root.join("SKILL.md"), "---\nname: research\nversion: 1.0.0\nkind: team-skill\nroles: []\nunknown: true\n---\n").unwrap();

        assert_eq!(
            resolver.validate(&selection),
            TeamSkillPackageValidation::Invalid
        );
        assert_eq!(
            resolver.dependency_plan(&selection, &TeamSkillDependencyCatalog::default()),
            TeamSkillDependencyPlanResult::Invalid,
        );
        let unknown =
            TeamSkillSelectionId::parse(format!("teamskill:v1:{}", "0".repeat(64))).unwrap();
        assert_eq!(
            resolver.validate(&unknown),
            TeamSkillPackageValidation::Unavailable
        );
        assert_eq!(
            TeamSkillSelectionId::parse(format!("teamskill:v1:{}", "A".repeat(64))),
            Err(TeamSkillSelectionError::InvalidSelection),
        );
        assert_eq!(
            TeamSkillSelectionId::parse("C:/private/package"),
            Err(TeamSkillSelectionError::InvalidSelection),
        );
        fs::remove_dir_all(root).unwrap();
    }
}
