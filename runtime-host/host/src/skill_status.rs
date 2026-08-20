#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Available(Catalog),
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Catalog {
    pub(crate) entries: Vec<Entry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Entry {
    pub(crate) key: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) enabled: bool,
    pub(crate) selectable: bool,
    pub(crate) installed: bool,
    pub(crate) eligible: bool,
    pub(crate) blocked_by_allowlist: bool,
    pub(crate) blocked_by_agent_filter: bool,
    pub(crate) unavailable_reason: Option<UnavailableReason>,
    pub(crate) missing_categories: Vec<RequirementCategory>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UnavailableReason {
    Disabled,
    Blocked,
    MissingRequirements,
    Ineligible,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequirementCategory {
    Binaries,
    AnyBinaries,
    Environment,
    Configuration,
    OperatingSystem,
}
