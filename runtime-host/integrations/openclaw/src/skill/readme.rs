use std::{
    fmt, fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use crate::{lifecycle::state_dir::CanonicalStateDir, workspace::TrustedWorkspaceDirectory};

const MANIFEST: &str = "SKILL.md";
const README_CANDIDATES: [&str; 4] = ["SKILL.md", "README.md", "skill.md", "readme.md"];
const MAX_PATH_BYTES: usize = 4 * 1024;
const MAX_CONTENT_BYTES: u64 = 48 * 1024;
const MAX_SKILL_KEY_BYTES: usize = 4096;

#[derive(Clone, Eq, PartialEq)]
pub struct SkillReadmeRequest {
    skill_key: String,
    fallback_slug: Option<String>,
    file_path: Option<PathBuf>,
    base_dir: Option<PathBuf>,
}

impl SkillReadmeRequest {
    pub fn try_new(
        skill_key: String,
        fallback_slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    ) -> Result<Self, SkillReadmeError> {
        let skill_key = normalize_skill_key(skill_key)?;
        let fallback_slug = fallback_slug.map(normalize_skill_key).transpose()?;
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
            fallback_slug,
            file_path,
            base_dir,
        })
    }

    pub fn skill_key(&self) -> &str {
        &self.skill_key
    }

    pub fn fallback_slug(&self) -> Option<&str> {
        self.fallback_slug.as_deref()
    }

    pub fn file_path(&self) -> Option<&Path> {
        self.file_path.as_deref()
    }

    pub fn base_dir(&self) -> Option<&Path> {
        self.base_dir.as_deref()
    }

    pub fn uses_source_path(&self) -> bool {
        self.file_path.is_some() || self.base_dir.is_some()
    }

    fn names(&self) -> Vec<&str> {
        let mut names = vec![self.skill_key.as_str()];
        if let Some(slug) = self.fallback_slug.as_deref() {
            if slug != self.skill_key.as_str() {
                names.push(slug);
            }
        }
        names
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
        let candidate = self.resolve_manifest(&request, workspace_roots)?;
        read_receipt(request.skill_key, candidate)
    }

    pub fn read_readme_target(
        &self,
        request: SkillReadmeRequest,
        workspace_roots: &[TrustedWorkspaceDirectory],
    ) -> Result<SkillReadmeReceipt, SkillReadmeError> {
        let candidate = self.resolve_readme_target(&request, workspace_roots)?;
        read_target_receipt(request.skill_key, candidate)
    }

    pub fn resolve_manifest(
        &self,
        request: &SkillReadmeRequest,
        workspace_roots: &[TrustedWorkspaceDirectory],
    ) -> Result<PathBuf, SkillReadmeError> {
        let managed_root = self.state_dir.as_path().join("skills");
        let roots = trusted_roots(&managed_root, workspace_roots)?;
        if let Some(file_path) = &request.file_path {
            if !is_manifest(file_path) {
                return Err(SkillReadmeError::Rejected);
            }
            return read_manifest(file_path.clone(), &roots);
        }
        if let Some(base_dir) = &request.base_dir {
            return read_manifest(base_dir.join(MANIFEST), &roots);
        }
        for name in request.names() {
            if let Some(candidate) = managed_child(&managed_root, name) {
                if let Ok(path) = read_manifest(candidate.join(MANIFEST), &roots) {
                    return Ok(path);
                }
            }
        }
        match resolve_manifest_by_name(&managed_root, request.names(), &roots) {
            Ok(Some(path)) => Ok(path),
            Ok(None) => Err(SkillReadmeError::Rejected),
            Err(error) => Err(error),
        }
    }

    pub fn resolve_readme_file(
        &self,
        request: &SkillReadmeRequest,
        workspace_roots: &[TrustedWorkspaceDirectory],
    ) -> Result<PathBuf, SkillReadmeError> {
        let managed_root = self.state_dir.as_path().join("skills");
        let roots = trusted_roots(&managed_root, workspace_roots)?;
        if let Some(file_path) = &request.file_path {
            if let Ok(path) = read_readme_candidate(file_path.clone(), &roots) {
                return Ok(path);
            }
        }
        if let Some(base_dir) = &request.base_dir {
            if let Some(directory) = existing_directory(base_dir.clone(), &roots)? {
                return first_readme_candidate(&directory, &roots);
            }
        }
        for name in request.names() {
            if let Some(candidate) = managed_child(&managed_root, name) {
                if let Ok(path) = first_readme_candidate(&candidate, &roots) {
                    return Ok(path);
                }
            }
        }
        match resolve_manifest_by_name(&managed_root, request.names(), &roots) {
            Ok(Some(path)) => Ok(path),
            Ok(None) => Err(SkillReadmeError::Rejected),
            Err(error) => Err(error),
        }
    }

    pub fn resolve_readme_target(
        &self,
        request: &SkillReadmeRequest,
        workspace_roots: &[TrustedWorkspaceDirectory],
    ) -> Result<PathBuf, SkillReadmeError> {
        match self.resolve_readme_file(request, workspace_roots) {
            Ok(path) => Ok(path),
            Err(SkillReadmeError::Rejected) => self.resolve_directory(request, workspace_roots),
            Err(error) => Err(error),
        }
    }

    pub fn resolve_directory(
        &self,
        request: &SkillReadmeRequest,
        workspace_roots: &[TrustedWorkspaceDirectory],
    ) -> Result<PathBuf, SkillReadmeError> {
        let managed_root = self.state_dir.as_path().join("skills");
        let roots = trusted_roots(&managed_root, workspace_roots)?;
        if let Some(base_dir) = &request.base_dir {
            if let Some(directory) = existing_directory(base_dir.clone(), &roots)? {
                return Ok(directory);
            }
        }
        for name in request.names() {
            if let Some(candidate) = managed_child(&managed_root, name) {
                if let Some(path) = existing_directory(candidate, &roots)? {
                    return Ok(path);
                }
            }
        }
        match resolve_directory_by_name(&managed_root, request.names(), &roots) {
            Ok(Some(path)) => Ok(path),
            Ok(None) => Err(SkillReadmeError::Rejected),
            Err(error) => Err(error),
        }
    }
}

impl fmt::Debug for SkillReadmeStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SkillReadmeStore([REDACTED])")
    }
}

fn read_receipt(
    skill_key: String,
    candidate: PathBuf,
) -> Result<SkillReadmeReceipt, SkillReadmeError> {
    let content = fs::read_to_string(&candidate).map_err(|_| SkillReadmeError::Unknown)?;
    receipt(skill_key, candidate, content)
}

fn read_target_receipt(
    skill_key: String,
    candidate: PathBuf,
) -> Result<SkillReadmeReceipt, SkillReadmeError> {
    let content = if candidate.is_file() {
        fs::read_to_string(&candidate).map_err(|_| SkillReadmeError::Unknown)?
    } else {
        String::new()
    };
    receipt(skill_key, candidate, content)
}

fn receipt(
    skill_key: String,
    candidate: PathBuf,
    content: String,
) -> Result<SkillReadmeReceipt, SkillReadmeError> {
    let file_path = candidate
        .to_str()
        .ok_or(SkillReadmeError::Unknown)?
        .to_owned();
    Ok(SkillReadmeReceipt {
        skill_key,
        content,
        file_path,
    })
}

fn normalize_skill_key(value: String) -> Result<String, SkillReadmeError> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_SKILL_KEY_BYTES || value.contains('\0') {
        return Err(SkillReadmeError::Rejected);
    }
    Ok(value.to_owned())
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

fn trusted_roots(
    managed_root: &Path,
    workspace_roots: &[TrustedWorkspaceDirectory],
) -> Result<Vec<PathBuf>, SkillReadmeError> {
    let mut roots = Vec::with_capacity(workspace_roots.len() + 1);
    if let Some(root) = canonical_root(managed_root)? {
        roots.push(root);
    }
    for workspace in workspace_roots {
        if let Some(root) = canonical_root(Path::new(workspace.as_str()))? {
            if !roots.iter().any(|known| known == &root) {
                roots.push(root);
            }
        }
    }
    Ok(roots)
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
    read_file(path, roots)
}

fn read_readme_candidate(path: PathBuf, roots: &[PathBuf]) -> Result<PathBuf, SkillReadmeError> {
    if !is_readme_candidate(&path) || contains_symlink(&path)? {
        return Err(SkillReadmeError::Rejected);
    }
    read_file(path, roots)
}

fn read_file(path: PathBuf, roots: &[PathBuf]) -> Result<PathBuf, SkillReadmeError> {
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
    if !is_inside_roots(&canonical, roots, false) {
        return Err(SkillReadmeError::Rejected);
    }
    Ok(canonical)
}

fn existing_directory(
    path: PathBuf,
    roots: &[PathBuf],
) -> Result<Option<PathBuf>, SkillReadmeError> {
    if contains_symlink(&path)? {
        return Err(SkillReadmeError::Rejected);
    }
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(SkillReadmeError::Unknown),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(SkillReadmeError::Rejected);
    }
    let canonical = fs::canonicalize(path).map_err(|_| SkillReadmeError::Unknown)?;
    if !is_inside_roots(&canonical, roots, true) {
        return Err(SkillReadmeError::Rejected);
    }
    Ok(Some(canonical))
}

fn is_inside_roots(path: &Path, roots: &[PathBuf], allow_root: bool) -> bool {
    roots
        .iter()
        .any(|root| path.starts_with(root) && (allow_root || path != root))
}

fn first_readme_candidate(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, SkillReadmeError> {
    for file_name in README_CANDIDATES {
        if let Ok(path) = read_readme_candidate(path.join(file_name), roots) {
            return Ok(path);
        }
    }
    Err(SkillReadmeError::Rejected)
}

fn is_readme_candidate(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            README_CANDIDATES
                .iter()
                .any(|candidate| name.eq_ignore_ascii_case(candidate))
        })
}

fn managed_child(root: &Path, name: &str) -> Option<PathBuf> {
    let path = Path::new(name.trim());
    (!path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_))))
    .then(|| root.join(path))
}

fn resolve_manifest_by_name(
    managed_root: &Path,
    names: Vec<&str>,
    roots: &[PathBuf],
) -> Result<Option<PathBuf>, SkillReadmeError> {
    let mut expected = names
        .iter()
        .map(|name| name.trim().to_lowercase())
        .collect::<Vec<_>>();
    expected.dedup();
    for manifest in managed_manifests(managed_root, roots)? {
        let content = fs::read_to_string(&manifest).map_err(|_| SkillReadmeError::Unknown)?;
        if manifest_name(&content).is_some_and(|name| expected.contains(&name.to_lowercase())) {
            return Ok(Some(manifest));
        }
    }
    Ok(None)
}

fn resolve_directory_by_name(
    managed_root: &Path,
    names: Vec<&str>,
    roots: &[PathBuf],
) -> Result<Option<PathBuf>, SkillReadmeError> {
    let Some(manifest) = resolve_manifest_by_name(managed_root, names, roots)? else {
        return Ok(None);
    };
    Ok(manifest.parent().map(Path::to_path_buf))
}

fn managed_manifests(
    managed_root: &Path,
    roots: &[PathBuf],
) -> Result<Vec<PathBuf>, SkillReadmeError> {
    let entries = match fs::read_dir(managed_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(SkillReadmeError::Unknown),
    };
    let mut manifests = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| SkillReadmeError::Unknown)?;
        if entry
            .file_type()
            .map_err(|_| SkillReadmeError::Unknown)?
            .is_dir()
        {
            if let Ok(path) = read_manifest(entry.path().join(MANIFEST), roots) {
                manifests.push(path);
            }
        }
    }
    Ok(manifests)
}

fn manifest_name(content: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            return None;
        }
        let Some(value) = line.strip_prefix("name:") else {
            continue;
        };
        let value = value.trim().trim_matches(['\'', '"']);
        if !value.is_empty() {
            return Some(value.to_owned());
        }
    }
    None
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
        SkillReadmeRequest::try_new("calendar".into(), None, file_path, base_dir).unwrap()
    }

    fn request_with_slug(slug: &str) -> SkillReadmeRequest {
        SkillReadmeRequest::try_new("calendar".into(), Some(slug.into()), None, None).unwrap()
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
    fn resolves_open_readme_with_old_candidate_order_and_directory_fallback() {
        let root = Root::new();
        let skill_dir = root.path.join("state/skills/calendar");
        fs::write(skill_dir.join("README.md"), "# Readme").unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# Skill").unwrap();
        let store = SkillReadmeStore::new(root.state_dir.clone());

        let receipt = store.read_readme_target(request(None, None), &[]).unwrap();
        assert_eq!(receipt.content(), "# Skill");
        assert!(Path::new(receipt.file_path()).ends_with(Path::new("calendar").join(MANIFEST)));

        fs::remove_file(skill_dir.join("SKILL.md")).unwrap();
        let receipt = store.read_readme_target(request(None, None), &[]).unwrap();
        assert_eq!(receipt.content(), "# Readme");
        assert!(Path::new(receipt.file_path()).ends_with(Path::new("calendar").join("README.md")));

        fs::remove_file(skill_dir.join("README.md")).unwrap();
        let receipt = store.read_readme_target(request(None, None), &[]).unwrap();
        assert_eq!(receipt.content(), "");
        assert!(Path::new(receipt.file_path()).ends_with("calendar"));
    }

    #[test]
    fn resolves_open_path_by_fallback_slug_and_manifest_name() {
        let root = Root::new();
        fs::remove_dir_all(root.path.join("state/skills/calendar")).unwrap();
        let store = SkillReadmeStore::new(root.state_dir.clone());
        let skill_dir = root.path.join("state/skills/actual-dir");
        write_manifest(
            &skill_dir.join(MANIFEST),
            "---\ndescription: Calendar skill\nname: Calendar\n---\n# Calendar",
        );

        let by_slug = store
            .resolve_directory(&request_with_slug("actual-dir"), &[])
            .unwrap();
        assert!(by_slug.ends_with(Path::new("actual-dir")));

        fs::remove_dir_all(&skill_dir).unwrap();
        write_manifest(
            &skill_dir.join(MANIFEST),
            "---\ndescription: Calendar skill\nname: Calendar\n---\n# Calendar",
        );
        let by_manifest = store.resolve_directory(&request(None, None), &[]).unwrap();
        assert!(by_manifest.ends_with(Path::new("actual-dir")));
    }

    #[test]
    fn rejects_malformed_paths_and_oversized_or_missing_manifests() {
        assert!(matches!(
            SkillReadmeRequest::try_new(
                "calendar".into(),
                None,
                Some("relative/SKILL.md".into()),
                None
            ),
            Err(SkillReadmeError::Rejected)
        ));
        assert!(matches!(
            SkillReadmeRequest::try_new(
                "calendar".into(),
                None,
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
