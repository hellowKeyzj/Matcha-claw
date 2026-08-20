use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;

use super::{
    Dependency, DependencyKind, PackageRole, TeamSkillPackage, TeamSkillPackageError,
    TeamSkillPackageInput,
};

const SKILL: &str = "SKILL.md";
const WORKFLOW: &str = "workflow.md";
const DEPENDENCIES: &str = "dependencies.yaml";
const BIND: &str = "bind.md";

#[derive(Clone, Eq, PartialEq)]
pub struct TeamSkillPackageRoot(PathBuf);

impl TeamSkillPackageRoot {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, TeamSkillPackageError> {
        let path = fs::canonicalize(path).map_err(|_| TeamSkillPackageError::Unavailable)?;
        if !path.is_dir() {
            return Err(TeamSkillPackageError::Unavailable);
        }
        Ok(Self(path))
    }

    pub(super) fn canonical_path(&self) -> &Path {
        &self.0
    }
}

#[derive(Clone)]
pub struct TeamSkillPackageReader {
    root: TeamSkillPackageRoot,
}

impl TeamSkillPackageReader {
    pub fn new(root: TeamSkillPackageRoot) -> Self {
        Self { root }
    }

    pub fn read(&self) -> Result<TeamSkillPackage, TeamSkillPackageError> {
        let skill_markdown = self.read_required(SKILL)?;
        let workflow_markdown = self.read_required(WORKFLOW)?;
        let dependencies_yaml = self.read_required(DEPENDENCIES)?;
        let manifest = parse_manifest(&skill_markdown)?;
        let dependencies = parse_dependencies(&dependencies_yaml)?;
        let mut roles = Vec::with_capacity(manifest.roles.len());
        for role in manifest.roles {
            let agents_markdown = self.read_role(&role.id)?;
            roles.push(
                PackageRole::try_new(
                    role.id,
                    role.purpose,
                    role.skills,
                    role.tools,
                    agents_markdown,
                )
                .map_err(|_| TeamSkillPackageError::Invalid)?,
            );
        }

        TeamSkillPackage::try_new(TeamSkillPackageInput {
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            skill_markdown,
            workflow_markdown,
            bind_markdown: self.read_optional(BIND)?,
            roles,
            dependencies,
        })
        .map_err(|_| TeamSkillPackageError::Invalid)
    }

    fn read_role(&self, role_id: &str) -> Result<String, TeamSkillPackageError> {
        if !is_safe_role_id(role_id) {
            return Err(TeamSkillPackageError::Invalid);
        }
        self.read_required_path(&self.root.0.join("roles").join(format!("{role_id}.md")))
    }

    fn read_required(&self, name: &str) -> Result<String, TeamSkillPackageError> {
        self.read_required_path(&self.root.0.join(name))
    }

    fn read_required_path(&self, path: &Path) -> Result<String, TeamSkillPackageError> {
        let path = fs::canonicalize(path).map_err(|_| TeamSkillPackageError::Unavailable)?;
        if !path.is_file() || !path.starts_with(&self.root.0) {
            return Err(TeamSkillPackageError::Unavailable);
        }
        fs::read_to_string(path).map_err(|_| TeamSkillPackageError::Unavailable)
    }

    fn read_optional(&self, name: &str) -> Result<Option<String>, TeamSkillPackageError> {
        let path = self.root.0.join(name);
        match fs::canonicalize(&path) {
            Ok(path) => {
                if !path.is_file() || !path.starts_with(&self.root.0) {
                    return Err(TeamSkillPackageError::Invalid);
                }
                fs::read_to_string(path)
                    .map(Some)
                    .map_err(|_| TeamSkillPackageError::Unavailable)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(TeamSkillPackageError::Unavailable),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    kind: String,
    roles: Vec<ManifestRole>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestRole {
    id: String,
    purpose: String,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    tools: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DependencyDocument {
    skills: Vec<DependencyEntry>,
    tools: Vec<DependencyEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DependencyEntry {
    name: String,
    #[serde(default)]
    required: bool,
    purpose: String,
    #[serde(default)]
    source: Option<String>,
}

fn parse_manifest(markdown: &str) -> Result<Manifest, TeamSkillPackageError> {
    let frontmatter = markdown
        .strip_prefix("---\n")
        .or_else(|| markdown.strip_prefix("---\r\n"))
        .and_then(|rest| {
            rest.split_once("\n---\n")
                .or_else(|| rest.split_once("\r\n---\r\n"))
                .or_else(|| {
                    rest.strip_suffix("\n---")
                        .map(|frontmatter| (frontmatter, ""))
                })
                .or_else(|| {
                    rest.strip_suffix("\r\n---")
                        .map(|frontmatter| (frontmatter, ""))
                })
        })
        .map(|(frontmatter, _)| frontmatter)
        .ok_or(TeamSkillPackageError::Invalid)?;
    let manifest: Manifest =
        serde_yaml::from_str(frontmatter).map_err(|_| TeamSkillPackageError::Invalid)?;
    (manifest.kind == "team-skill")
        .then_some(manifest)
        .ok_or(TeamSkillPackageError::Invalid)
}

fn parse_dependencies(document: &str) -> Result<Vec<Dependency>, TeamSkillPackageError> {
    let document: DependencyDocument =
        serde_yaml::from_str(document).map_err(|_| TeamSkillPackageError::Invalid)?;
    document
        .skills
        .into_iter()
        .map(|entry| dependency(DependencyKind::Skill, entry))
        .chain(
            document
                .tools
                .into_iter()
                .map(|entry| dependency(DependencyKind::Tool, entry)),
        )
        .collect()
}

fn dependency(
    kind: DependencyKind,
    entry: DependencyEntry,
) -> Result<Dependency, TeamSkillPackageError> {
    Dependency::try_new(
        kind,
        entry.name,
        entry.required,
        entry.purpose,
        entry.source,
    )
    .map_err(|_| TeamSkillPackageError::Invalid)
}

fn is_safe_role_id(value: &str) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value != "."
        && value != ".."
        && !value.contains(['/', '\\', ':'])
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn package_root(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("matchaclaw-team-skill-{name}-{unique}"));
        fs::create_dir_all(root.join("roles")).unwrap();
        root
    }

    fn write_package(root: &Path, role_id: &str) {
        fs::write(root.join(SKILL), format!("---\nname: research\nversion: 1.0.0\ndescription: Research\nkind: team-skill\nroles:\n  - id: {role_id}\n    purpose: Research facts\n    skills: [web]\n    tools: [browser]\n---\n# Research\n")).unwrap();
        fs::write(root.join(WORKFLOW), "# Workflow").unwrap();
        fs::write(root.join(DEPENDENCIES), "skills:\n  - name: web\n    required: true\n    purpose: Search\n    source: clawhub:web\ntools:\n  - name: browser\n    required: false\n    purpose: Browse\n").unwrap();
        if is_safe_role_id(role_id) {
            fs::write(root.join("roles").join(format!("{role_id}.md")), "# Role").unwrap();
        }
    }

    #[test]
    fn reads_only_the_fixed_teamskill_package_files_into_strict_dtos() {
        let root = package_root("valid");
        write_package(&root, "researcher");
        fs::write(root.join("bind.md"), "# Bind").unwrap();
        fs::write(root.join("unrelated-secret.txt"), "do-not-read").unwrap();

        let package = TeamSkillPackageReader::new(TeamSkillPackageRoot::open(&root).unwrap())
            .read()
            .unwrap();

        assert_eq!(package.name(), "research");
        assert_eq!(package.roles()[0].id(), "researcher");
        assert_eq!(package.dependencies()[0].kind(), DependencyKind::Skill);
        assert_eq!(package.bind_markdown(), Some("# Bind"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_role_path_escape_without_echoing_the_path() {
        let root = package_root("escape");
        write_package(&root, "../secret");

        let error = TeamSkillPackageReader::new(TeamSkillPackageRoot::open(&root).unwrap())
            .read()
            .unwrap_err();

        assert_eq!(error, TeamSkillPackageError::Invalid);
        assert_eq!(error.to_string(), "TeamSkill package is invalid");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fails_closed_for_unknown_schema_and_missing_fixed_files() {
        let root = package_root("invalid");
        write_package(&root, "researcher");
        fs::write(root.join(SKILL), "---\nname: research\nversion: 1.0.0\nkind: team-skill\nroles: []\nsecret: value\n---\n").unwrap();

        let error = TeamSkillPackageReader::new(TeamSkillPackageRoot::open(&root).unwrap())
            .read()
            .unwrap_err();

        assert_eq!(error, TeamSkillPackageError::Invalid);
        fs::remove_file(root.join(WORKFLOW)).unwrap();
        let error = TeamSkillPackageReader::new(TeamSkillPackageRoot::open(&root).unwrap())
            .read()
            .unwrap_err();
        assert_eq!(error, TeamSkillPackageError::Unavailable);
        fs::remove_dir_all(root).unwrap();
    }
}
