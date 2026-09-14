use std::{
    fmt,
    path::{Component, Path},
};

const MAX_PACKAGE_PATH_BYTES: usize = 240;

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
pub struct PackageRelativePath(String);

impl PackageRelativePath {
    pub fn parse(value: impl Into<String>) -> Result<Self, ()> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_PACKAGE_PATH_BYTES
            || value.contains('\\')
            || value.contains('\0')
            || value.starts_with('/')
            || Path::new(&value).is_absolute()
            || value.split('/').any(|component| {
                component.is_empty()
                    || component == "."
                    || component == ".."
                    || is_windows_drive(component)
            })
            || Path::new(&value)
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(());
        }
        Ok(Self(value))
    }

    pub fn skill_manifest() -> Self {
        Self("SKILL.md".to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for PackageRelativePath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("PackageRelativePath")
            .field(&self.0)
            .finish()
    }
}

fn is_windows_drive(component: &str) -> bool {
    let bytes = component.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}
