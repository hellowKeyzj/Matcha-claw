use std::{
    fmt, fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use crate::{lifecycle::state_dir::CanonicalStateDir, workspace::TrustedWorkspaceDirectory};

const MANIFEST: &str = "SKILL.md";
const MAX_PATH_BYTES: usize = 4 * 1024;
const MAX_CONTENT_BYTES: u64 = 48 * 1024;
const MAX_SKILL_KEY_BYTES: usize = 96;

#[derive(Clone, Eq, PartialEq)]
pub struct SkillReadmeRequest {
    skill_key: String,
    file_path: Option<PathBuf>,
    base_dir: Option<PathBuf>,
}

impl SkillReadmeRequest {
    pub fn try_new(
        skill_key: String,
        file_path: Option<String>,
        base_dir: Option<String>,
    ) -> Result<Self, SkillReadmeError> {
        let skill_key = normalize_skill_key(skill_key)?;
        let file_path = file_path
            .map(normalize_absolute_path)
            .transpose()?
            .map(PathBuf::from);
        if file_path.as_deref().is_some_and(|path| !is_manifest(path)) {
            return Err(SkillReadmeError::Rejected);
        }
        let base_dir = base_dir
            .map(normalize_absolute_path)
            .transpose()?
            .map(PathBuf::from);
        Ok(Self {
            skill_key,
            file_path,
            base_dir,
        })
    }

    pub fn skill_key(&self) -> &str {
        &self.skill_key
    }

    pub fn uses_source_path(&self) -> bool {
        self.file_path.is_some() || self.base_dir.is_some()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct SkillReadmeReceipt {
    skill_key: String,
    content: String,
    file_path: String,
}

impl SkillReadmeReceipt {
    pub fn skill_key(&self) -> &str {
        &self.skill_key
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub fn file_path(&self) -> &str {
        &self.file_path
    }
}

impl fmt::Debug for SkillReadmeReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SkillReadmeReceipt([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillReadmeError {
    Rejected,
    Unknown,
}

impl fmt::Display for SkillReadmeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Rejected => "skill readme request rejected",
            Self::Unknown => "skill readme is unavailable",
        })
    }
}

impl std::error::Error for SkillReadmeError {}

pub struct SkillReadmeStore {
    state_dir: CanonicalStateDir,
}

impl SkillReadmeStore {
    pub fn new(state_dir: CanonicalStateDir) -> Self {
        Self { state_dir }
    }

    pub fn read(
        &self,
        request: SkillReadmeRequest,
        workspace_roots: &[TrustedWorkspaceDirectory],
    ) -> Result<SkillReadmeReceipt, SkillReadmeError> {
        let managed_root = self.state_dir.as_path().join("skills");
        let mut roots = Vec::with_capacity(workspace_roots.len() + 1);
        if let Some(root) = canonical_root(&managed_root)? {
            roots.push(root);
        }
        for workspace in workspace_roots {
            if let Some(root) = canonical_root(Path::new(workspace.as_str()))? {
                if !roots.iter().any(|known| known == &root) {
                    roots.push(root);
                }
            }
        }

        let candidate = request
            .file_path
            .clone()
            .or_else(|| {
                request
                    .base_dir
                    .clone()
                    .map(|base_dir| base_dir.join(MANIFEST))
            })
            .unwrap_or_else(|| managed_root.join(request.skill_key()).join(MANIFEST));
        let candidate = read_manifest(candidate, &roots)?;
        let file_path = candidate
            .to_str()
            .ok_or(SkillReadmeError::Unknown)?
            .to_owned();
        Ok(SkillReadmeReceipt {
            skill_key: request.skill_key,
            content: fs::read_to_string(&candidate).map_err(|_| SkillReadmeError::Unknown)?,
            file_path,
        })
    }
}

impl fmt::Debug for SkillReadmeStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SkillReadmeStore([REDACTED])")
    }
}

fn normalize_skill_key(value: String) -> Result<String, SkillReadmeError> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty()
        || value.len() > MAX_SKILL_KEY_BYTES
        || !value
            .bytes()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_alphanumeric() || (index > 0 && byte == b'-'))
        || value.ends_with('-')
    {
        return Err(SkillReadmeError::Rejected);
    }
    Ok(value)
}

fn normalize_absolute_path(value: String) -> Result<String, SkillReadmeError> {
    let value = value.trim().to_owned();
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.contains('\0')
        || !Path::new(&value).is_absolute()
    {
        return Err(SkillReadmeError::Rejected);
    }
    Ok(value)
}

fn is_manifest(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(MANIFEST))
}

fn canonical_root(path: &Path) -> Result<Option<PathBuf>, SkillReadmeError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(SkillReadmeError::Unknown),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(SkillReadmeError::Rejected);
    }
    if contains_symlink(path)? {
        return Err(SkillReadmeError::Rejected);
    }
    fs::canonicalize(path)
        .map(Some)
        .map_err(|_| SkillReadmeError::Unknown)
}

fn read_manifest(path: PathBuf, roots: &[PathBuf]) -> Result<PathBuf, SkillReadmeError> {
    if !is_manifest(&path) || contains_symlink(&path)? {
        return Err(SkillReadmeError::Rejected);
    }
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(SkillReadmeError::Rejected);
        }
        Err(_) => return Err(SkillReadmeError::Unknown),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(SkillReadmeError::Rejected);
    }
    if metadata.len() > MAX_CONTENT_BYTES {
        return Err(SkillReadmeError::Rejected);
    }
    let canonical = fs::canonicalize(path).map_err(|_| SkillReadmeError::Unknown)?;
    if !roots
        .iter()
        .any(|root| canonical.starts_with(root) && canonical != *root)
    {
        return Err(SkillReadmeError::Rejected);
    }
    Ok(canonical)
}

fn contains_symlink(path: &Path) -> Result<bool, SkillReadmeError> {
    let mut current = path;
    loop {
        match fs::symlink_metadata(current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Ok(true),
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err(SkillReadmeError::Unknown),
        }
        let Some(parent) = current.parent() else {
            return Ok(false);
        };
        if parent == current {
            return Ok(false);
        }
        current = parent;
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;
    use crate::workspace::OpenClawWorkspaceAccess;
    use serde_json::json;

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct Root {
        path: PathBuf,
        state_dir: CanonicalStateDir,
    }

    impl Root {
        fn new() -> Self {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock must follow Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "matchaclaw-openclaw-readme-{}-{timestamp}-{}",
                std::process::id(),
                NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            let state_dir = CanonicalStateDir::provision(path.join("state")).unwrap();
            fs::create_dir_all(state_dir.as_path().join("skills/calendar")).unwrap();
            Self { path, state_dir }
        }
    }

    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn request(file_path: Option<String>, base_dir: Option<String>) -> SkillReadmeRequest {
        SkillReadmeRequest::try_new("Calendar".into(), file_path, base_dir).unwrap()
    }

    fn write_manifest(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn reads_managed_manifest_without_projecting_storage_root() {
        let root = Root::new();
        write_manifest(
            &root.path.join("state/skills/calendar/SKILL.md"),
            "# Calendar",
        );
        let receipt = SkillReadmeStore::new(root.state_dir.clone())
            .read(request(None, None), &[])
            .unwrap();
        assert_eq!(receipt.skill_key(), "calendar");
        assert_eq!(receipt.content(), "# Calendar");
        assert!(Path::new(receipt.file_path()).ends_with(Path::new("calendar").join(MANIFEST)));
        assert!(!format!("{receipt:?}").contains("Calendar"));
    }

    #[test]
    fn reads_a_manifest_from_a_configured_workspace_root() {
        let root = Root::new();
        let workspace = root.path.join("workspace");
        write_manifest(&workspace.join("SKILL.md"), "# Workspace");
        fs::write(
            root.path.join("state/openclaw.json"),
            serde_json::to_vec(&json!({
                "agents": { "defaults": { "workspace": workspace } }
            }))
            .unwrap(),
        )
        .unwrap();
        let trusted = OpenClawWorkspaceAccess::new(root.state_dir.clone())
            .maintenance_workspace_directories()
            .unwrap();
        let receipt = SkillReadmeStore::new(root.state_dir.clone())
            .read(
                request(None, Some(workspace.to_string_lossy().into_owned())),
                &trusted,
            )
            .unwrap();
        assert_eq!(receipt.content(), "# Workspace");
    }

    #[test]
    fn rejects_malformed_paths_and_oversized_or_missing_manifests() {
        assert!(matches!(
            SkillReadmeRequest::try_new("calendar".into(), Some("relative/SKILL.md".into()), None),
            Err(SkillReadmeError::Rejected)
        ));
        assert!(matches!(
            SkillReadmeRequest::try_new(
                "calendar".into(),
                Some("C:/skills/README.md".into()),
                None
            ),
            Err(SkillReadmeError::Rejected)
        ));

        let root = Root::new();
        assert!(matches!(
            SkillReadmeStore::new(root.state_dir.clone()).read(request(None, None), &[]),
            Err(SkillReadmeError::Rejected)
        ));
        write_manifest(
            &root.path.join("state/skills/calendar/SKILL.md"),
            &"x".repeat((MAX_CONTENT_BYTES + 1) as usize),
        );
        assert!(matches!(
            SkillReadmeStore::new(root.state_dir.clone()).read(request(None, None), &[]),
            Err(SkillReadmeError::Rejected)
        ));
    }

    #[test]
    fn rejects_paths_outside_trusted_roots_and_manifest_symlinks() {
        let root = Root::new();
        let outside = root.path.join("outside");
        write_manifest(&outside.join("SKILL.md"), "# Outside");
        assert!(matches!(
            SkillReadmeStore::new(root.state_dir.clone()).read(
                request(
                    Some(outside.join("SKILL.md").to_string_lossy().into_owned()),
                    None
                ),
                &[],
            ),
            Err(SkillReadmeError::Rejected)
        ));

        let managed = root.path.join("state/skills/calendar/SKILL.md");
        let _ = fs::remove_file(&managed);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside.join("SKILL.md"), &managed).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&outside.join("SKILL.md"), &managed).is_err() {
            return;
        }
        assert!(matches!(
            SkillReadmeStore::new(root.state_dir.clone()).read(request(None, None), &[]),
            Err(SkillReadmeError::Rejected)
        ));
    }
}
