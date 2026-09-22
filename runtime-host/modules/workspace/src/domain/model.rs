#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceDirectoryRoot {
    path: String,
}

impl WorkspaceDirectoryRoot {
    pub fn new(path: String) -> Self {
        Self { path }
    }

    pub fn as_str(&self) -> &str {
        &self.path
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceTextReceipt {
    name: String,
    content: String,
    size: u64,
}

impl WorkspaceTextReceipt {
    pub fn new(name: String, content: String, size: u64) -> Self {
        Self {
            name,
            content,
            size,
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub const fn size(&self) -> u64 {
        self.size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceWriteReceipt {
    name: String,
    size: u64,
}

impl WorkspaceWriteReceipt {
    pub fn new(name: String, size: u64) -> Self {
        Self { name, size }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub const fn size(&self) -> u64 {
        self.size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceBinaryReceipt {
    name: String,
    content: Vec<u8>,
    size: u64,
}

impl WorkspaceBinaryReceipt {
    pub fn new(name: String, content: Vec<u8>, size: u64) -> Self {
        Self {
            name,
            content,
            size,
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn content(&self) -> &[u8] {
        &self.content
    }

    pub const fn size(&self) -> u64 {
        self.size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceStatReceipt {
    name: String,
    is_directory: bool,
    size: u64,
    mtime_ms: u64,
}

impl WorkspaceStatReceipt {
    pub fn new(name: String, is_directory: bool, size: u64, mtime_ms: u64) -> Self {
        Self {
            name,
            is_directory,
            size,
            mtime_ms,
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub const fn is_directory(&self) -> bool {
        self.is_directory
    }

    pub const fn size(&self) -> u64 {
        self.size
    }

    pub const fn mtime_ms(&self) -> u64 {
        self.mtime_ms
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceDirectoryReceipt {
    entries: Vec<WorkspaceDirectoryEntry>,
}

impl WorkspaceDirectoryReceipt {
    pub fn new(entries: Vec<WorkspaceDirectoryEntry>) -> Self {
        Self { entries }
    }

    pub fn entries(&self) -> &[WorkspaceDirectoryEntry] {
        &self.entries
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceDirectoryEntry {
    relative_path: String,
    display: String,
    is_directory: bool,
    size: u64,
}

impl WorkspaceDirectoryEntry {
    pub fn new(relative_path: String, display: String, is_directory: bool, size: u64) -> Self {
        Self {
            relative_path,
            display,
            is_directory,
            size,
        }
    }

    pub fn relative_path(&self) -> &str {
        &self.relative_path
    }

    pub fn display(&self) -> &str {
        &self.display
    }

    pub const fn is_directory(&self) -> bool {
        self.is_directory
    }

    pub const fn size(&self) -> u64 {
        self.size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspaceMediaPath {
    Relative {
        key: String,
        relative_path: String,
        mime_type: String,
    },
    Gateway {
        key: String,
        gateway_url: String,
        mime_type: String,
        agent_id: String,
    },
}

impl WorkspaceMediaPath {
    pub fn relative(key: String, relative_path: String, mime_type: String) -> Self {
        Self::Relative {
            key,
            relative_path,
            mime_type,
        }
    }

    pub fn gateway(key: String, gateway_url: String, mime_type: String, agent_id: String) -> Self {
        Self::Gateway {
            key,
            gateway_url,
            mime_type,
            agent_id,
        }
    }

    pub fn key(&self) -> &str {
        match self {
            Self::Relative { key, .. } | Self::Gateway { key, .. } => key,
        }
    }

    pub fn relative_path(&self) -> &str {
        match self {
            Self::Relative { relative_path, .. } => relative_path,
            Self::Gateway { .. } => "",
        }
    }

    pub fn gateway_url(&self) -> &str {
        match self {
            Self::Relative { .. } => "",
            Self::Gateway { gateway_url, .. } => gateway_url,
        }
    }

    pub fn mime_type(&self) -> &str {
        match self {
            Self::Relative { mime_type, .. } | Self::Gateway { mime_type, .. } => mime_type,
        }
    }

    pub fn agent_id(&self) -> &str {
        match self {
            Self::Relative { .. } => "",
            Self::Gateway { agent_id, .. } => agent_id,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceMediaReceipt {
    reference: String,
    name: String,
    mime_type: String,
    size: u64,
    preview: Option<String>,
}

impl WorkspaceMediaReceipt {
    pub fn new(
        reference: String,
        name: String,
        mime_type: String,
        size: u64,
        preview: Option<String>,
    ) -> Self {
        Self {
            reference,
            name,
            mime_type,
            size,
            preview,
        }
    }

    pub fn reference(&self) -> &str {
        &self.reference
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn mime_type(&self) -> &str {
        &self.mime_type
    }

    pub const fn size(&self) -> u64 {
        self.size
    }

    pub fn preview(&self) -> Option<&str> {
        self.preview.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedWorkspaceMedia {
    content: Vec<u8>,
}

impl ResolvedWorkspaceMedia {
    pub fn new(content: Vec<u8>) -> Self {
        Self { content }
    }

    pub fn content(&self) -> &[u8] {
        &self.content
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceMediaThumbnail {
    preview: Option<String>,
    file_size: u64,
}

impl WorkspaceMediaThumbnail {
    pub fn new(preview: Option<String>, file_size: u64) -> Self {
        Self { preview, file_size }
    }

    pub fn preview(&self) -> Option<&str> {
        self.preview.as_deref()
    }

    pub const fn file_size(&self) -> u64 {
        self.file_size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceMediaThumbnailEntry {
    key: String,
    thumbnail: WorkspaceMediaThumbnail,
}

impl WorkspaceMediaThumbnailEntry {
    pub fn new(key: String, thumbnail: WorkspaceMediaThumbnail) -> Self {
        Self { key, thumbnail }
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn thumbnail(&self) -> &WorkspaceMediaThumbnail {
        &self.thumbnail
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceDirectoryFailure {
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceReadFailure {
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
    Binary,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceBinaryFailure {
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceStatFailure {
    InvalidPath,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceListFailure {
    InvalidPath,
    Unavailable,
    NotDirectory,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceWriteFailure {
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceMediaFailure {
    InvalidPath,
    InvalidReference,
    Unavailable,
    NotFile,
    TooLarge,
}
