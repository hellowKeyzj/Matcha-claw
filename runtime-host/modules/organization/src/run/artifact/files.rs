const MAX_PATH_BYTES: usize = 4096;

#[derive(Clone, Eq, PartialEq)]
pub struct RunFilePath(String);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunFilePathError {
    InvalidPath,
}

impl RunFilePath {
    pub fn try_new(value: impl Into<String>) -> Result<Self, RunFilePathError> {
        let value = value.into();
        if value.trim().is_empty()
            || value.len() > MAX_PATH_BYTES
            || value.starts_with(['/', '\\'])
            || value.chars().any(|character| character.is_control()
                || matches!(character, ':' | '*' | '?'))
            || value.split(['/', '\\']).any(|part| part.is_empty() || matches!(part, "." | ".."))
        {
            return Err(RunFilePathError::InvalidPath);
        }
        Ok(Self(value.replace('\\', "/")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl std::fmt::Debug for RunFilePath {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("RunFilePath(<redacted>)")
    }
}

pub fn normalize_delivery_files(files: Vec<String>) -> Result<Vec<String>, RunFilePathError> {
    let mut normalized = Vec::with_capacity(files.len());
    let mut seen = std::collections::BTreeSet::new();
    for file in files {
        let file = RunFilePath::try_new(file)?.into_string();
        if seen.insert(file.clone()) {
            normalized.push(file);
        }
    }
    Ok(normalized)
}
