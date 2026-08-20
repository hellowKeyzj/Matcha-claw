use std::fmt;

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct Command {
    slug: String,
    version: Option<String>,
    force: bool,
}

impl Command {
    pub(crate) fn new(slug: String, version: Option<String>, force: bool) -> Self {
        Self {
            slug,
            version,
            force,
        }
    }

    pub(crate) fn into_parts(self) -> (String, Option<String>, bool) {
        (self.slug, self.version, self.force)
    }
}

impl fmt::Debug for Command {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SkillInstallCommand([REDACTED])")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Accepted {
        slug: String,
        version: Option<String>,
    },
    Rejected,
    Unknown,
}

impl Outcome {
    pub(crate) fn accepted(slug: String, version: Option<String>) -> Self {
        Self::Accepted { slug, version }
    }
}
