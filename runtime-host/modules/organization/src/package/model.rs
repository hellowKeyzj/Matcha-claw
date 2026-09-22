use std::fmt;

#[derive(Clone, Eq, PartialEq)]
pub struct TeamSkillPackage {
    name: String,
    version: String,
    description: String,
    skill_markdown: String,
    workflow_markdown: String,
    bind_markdown: Option<String>,
    roles: Vec<PackageRole>,
    dependencies: Vec<Dependency>,
}

impl fmt::Debug for TeamSkillPackage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamSkillPackage([redacted])")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct TeamSkillPackageInput {
    pub name: String,
    pub version: String,
    pub description: String,
    pub skill_markdown: String,
    pub workflow_markdown: String,
    pub bind_markdown: Option<String>,
    pub roles: Vec<PackageRole>,
    pub dependencies: Vec<Dependency>,
}

impl TeamSkillPackage {
    pub fn try_new(input: TeamSkillPackageInput) -> Result<Self, InvalidTeamSkillPackage> {
        let TeamSkillPackageInput {
            name,
            version,
            description,
            skill_markdown,
            workflow_markdown,
            bind_markdown,
            roles,
            dependencies,
        } = input;
        if name.trim().is_empty() {
            return Err(InvalidTeamSkillPackage::MissingName);
        }
        if version.trim().is_empty() {
            return Err(InvalidTeamSkillPackage::MissingVersion);
        }
        if roles.is_empty() {
            return Err(InvalidTeamSkillPackage::MissingRoles);
        }
        if roles
            .iter()
            .enumerate()
            .any(|(index, role)| roles[..index].iter().any(|other| other.id() == role.id()))
        {
            return Err(InvalidTeamSkillPackage::DuplicateRole);
        }

        Ok(Self {
            name,
            version,
            description,
            skill_markdown,
            workflow_markdown,
            bind_markdown,
            roles,
            dependencies,
        })
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
    pub fn skill_markdown(&self) -> &str {
        &self.skill_markdown
    }
    pub fn workflow_markdown(&self) -> &str {
        &self.workflow_markdown
    }
    pub fn bind_markdown(&self) -> Option<&str> {
        self.bind_markdown.as_deref()
    }
    pub fn roles(&self) -> &[PackageRole] {
        &self.roles
    }
    pub fn dependencies(&self) -> &[Dependency] {
        &self.dependencies
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct PackageRole {
    id: String,
    purpose: String,
    skills: Vec<String>,
    tools: Vec<String>,
    agents_markdown: String,
}

impl PackageRole {
    pub fn try_new(
        id: impl Into<String>,
        purpose: impl Into<String>,
        skills: Vec<String>,
        tools: Vec<String>,
        agents_markdown: impl Into<String>,
    ) -> Result<Self, InvalidTeamSkillPackage> {
        let id = id.into();
        if !is_role_file_name(&id) {
            return Err(InvalidTeamSkillPackage::InvalidRoleId);
        }
        if id == "leader" {
            return Err(InvalidTeamSkillPackage::ReservedRoleId);
        }
        let purpose = purpose.into();
        if purpose.trim().is_empty() {
            return Err(InvalidTeamSkillPackage::MissingRolePurpose);
        }
        Ok(Self {
            id,
            purpose,
            skills: normalize_names(skills),
            tools: normalize_names(tools),
            agents_markdown: agents_markdown.into(),
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn purpose(&self) -> &str {
        &self.purpose
    }
    pub fn skills(&self) -> &[String] {
        &self.skills
    }
    pub fn tools(&self) -> &[String] {
        &self.tools
    }
    pub fn agents_markdown(&self) -> &str {
        &self.agents_markdown
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DependencyKind {
    Skill,
    Tool,
}

#[derive(Clone, Eq, PartialEq)]
pub struct Dependency {
    kind: DependencyKind,
    name: String,
    required: bool,
    purpose: String,
    source: Option<String>,
}

impl Dependency {
    pub fn try_new(
        kind: DependencyKind,
        name: impl Into<String>,
        required: bool,
        purpose: impl Into<String>,
        source: Option<String>,
    ) -> Result<Self, InvalidTeamSkillPackage> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(InvalidTeamSkillPackage::MissingDependencyName);
        }
        let purpose = purpose.into();
        if purpose.trim().is_empty() {
            return Err(InvalidTeamSkillPackage::MissingDependencyPurpose);
        }
        let source = source.and_then(|value| (!value.trim().is_empty()).then_some(value));
        Ok(Self {
            kind,
            name,
            required,
            purpose,
            source,
        })
    }

    pub fn kind(&self) -> DependencyKind {
        self.kind
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn required(&self) -> bool {
        self.required
    }
    pub fn purpose(&self) -> &str {
        &self.purpose
    }
    pub fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidTeamSkillPackage {
    MissingName,
    MissingVersion,
    MissingRoles,
    DuplicateRole,
    InvalidRoleId,
    ReservedRoleId,
    MissingRolePurpose,
    MissingDependencyName,
    MissingDependencyPurpose,
}

impl fmt::Display for InvalidTeamSkillPackage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::MissingName => "TeamSkill package name is required",
            Self::MissingVersion => "TeamSkill package version is required",
            Self::MissingRoles => "TeamSkill package requires at least one role",
            Self::DuplicateRole => "TeamSkill package contains a duplicate role",
            Self::InvalidRoleId => "TeamSkill role ID must be a single safe file name",
            Self::ReservedRoleId => "TeamSkill role ID is reserved",
            Self::MissingRolePurpose => "TeamSkill role purpose is required",
            Self::MissingDependencyName => "TeamSkill dependency name is required",
            Self::MissingDependencyPurpose => "TeamSkill dependency purpose is required",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for InvalidTeamSkillPackage {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamSkillPackageError {
    Unavailable,
    Invalid,
}

impl fmt::Display for TeamSkillPackageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "TeamSkill package is unavailable",
            Self::Invalid => "TeamSkill package is invalid",
        })
    }
}

impl std::error::Error for TeamSkillPackageError {}

fn is_role_file_name(value: &str) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value != "."
        && value != ".."
        && !value.contains(['/', '\\', ':'])
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn normalize_names(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .filter_map(|value| (!value.trim().is_empty()).then_some(value))
        .collect()
}
