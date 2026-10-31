use std::{fmt, path::Path};

#[cfg(windows)]
use std::os::windows::io::BorrowedHandle;

#[cfg(windows)]
pub use platform::PrivateSecurityDescriptor;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrivateMode {
    Directory,
    File,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PrivateStorageError;

impl fmt::Display for PrivateStorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("private storage permission setup failed")
    }
}

impl std::error::Error for PrivateStorageError {}

pub fn provision_private_directory(path: &Path) -> Result<(), PrivateStorageError> {
    platform::provision_private_directory(path)
}

pub fn set_private_mode(path: &Path, mode: PrivateMode) -> Result<(), PrivateStorageError> {
    platform::set_private_mode(path, mode)
}

#[cfg(windows)]
pub fn set_private_mode_handle(
    handle: BorrowedHandle<'_>,
    mode: PrivateMode,
) -> Result<(), PrivateStorageError> {
    platform::set_private_mode_handle(handle, mode)
}

#[cfg(windows)]
pub fn verify_private_mode_handle(
    handle: BorrowedHandle<'_>,
    mode: PrivateMode,
) -> Result<(), PrivateStorageError> {
    platform::verify_private_mode_handle(handle, mode)
}

#[cfg(windows)]
mod platform {
    use std::{
        ffi::{OsStr, c_void},
        fs, io,
        mem::{offset_of, size_of},
        os::windows::{
            ffi::OsStrExt,
            fs::OpenOptionsExt,
            io::{AsHandle, AsRawHandle, BorrowedHandle},
        },
        path::{Path, PathBuf},
        ptr::{addr_of, null_mut},
    };

    use windows_sys::Win32::{
        Foundation as F,
        Security::{self as S, Authorization as A},
        Storage::FileSystem as FS,
        System::Threading as T,
    };

    use super::{PrivateMode, PrivateStorageError};

    const DIRECTORY_SDDL: &str = "D:P(A;OICI;FA;;;OW)";
    const FILE_SDDL: &str = "D:P(A;;FA;;;OW)";
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

    fn failure(
        stage: &'static str,
        check: &'static str,
        error: Option<io::Error>,
    ) -> PrivateStorageError {
        if std::env::var("MATCHACLAW_TRACE").as_deref() == Ok("1") {
            let code = error.as_ref().and_then(io::Error::raw_os_error);
            eprintln!(
                "{}",
                serde_json::json!({
                    "prefix": "session-trace",
                    "source": "foundation",
                    "stage": stage,
                    "check": check,
                    "rawWin32Status": code.map(|code| code as u32),
                    "ioKind": error.as_ref().map(|error| format!("{:?}", error.kind())),
                    "errorCode": code,
                })
            );
        }
        PrivateStorageError
    }

    struct Token(F::HANDLE);

    impl Drop for Token {
        fn drop(&mut self) {
            // SAFETY: Token owns a non-null token handle returned by OpenProcessToken.
            unsafe { F::CloseHandle(self.0) };
        }
    }

    pub struct PrivateSecurityDescriptor(S::PSECURITY_DESCRIPTOR);

    impl PrivateSecurityDescriptor {
        pub fn owner_only(mode: PrivateMode) -> Result<Self, PrivateStorageError> {
            let sddl = match mode {
                PrivateMode::Directory => DIRECTORY_SDDL,
                PrivateMode::File => FILE_SDDL,
            };
            let encoded = wide(OsStr::new(sddl))?;
            let mut descriptor = null_mut();
            if unsafe {
                A::ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    encoded.as_ptr(),
                    A::SDDL_REVISION_1,
                    &mut descriptor,
                    null_mut(),
                )
            } == 0
            {
                return Err(failure(
                    "storage.private.descriptor",
                    "ConvertStringSecurityDescriptorToSecurityDescriptorW",
                    Some(io::Error::last_os_error()),
                ));
            }
            if descriptor.is_null() {
                return Err(failure(
                    "storage.private.descriptor",
                    "descriptor_null",
                    None,
                ));
            }
            Ok(Self(descriptor))
        }

        pub fn attributes(&self) -> S::SECURITY_ATTRIBUTES {
            S::SECURITY_ATTRIBUTES {
                nLength: size_of::<S::SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.0,
                bInheritHandle: 0,
            }
        }

        fn dacl(&self) -> Result<*mut S::ACL, PrivateStorageError> {
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl = null_mut();
            if unsafe {
                S::GetSecurityDescriptorDacl(self.0, &mut present, &mut dacl, &mut defaulted)
            } == 0
            {
                return Err(failure(
                    "storage.private.descriptor",
                    "GetSecurityDescriptorDacl",
                    Some(io::Error::last_os_error()),
                ));
            }
            if present == 0 {
                return Err(failure("storage.private.descriptor", "dacl_absent", None));
            }
            if dacl.is_null() {
                return Err(failure("storage.private.descriptor", "dacl_null", None));
            }
            Ok(dacl)
        }
    }

    impl Drop for PrivateSecurityDescriptor {
        fn drop(&mut self) {
            // SAFETY: The descriptor is allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW or GetSecurityInfo.
            unsafe { F::LocalFree(self.0) };
        }
    }

    pub(super) fn provision_private_directory(path: &Path) -> Result<(), PrivateStorageError> {
        if !path.is_absolute() {
            return Err(failure(
                "storage.private.provision",
                "path_not_absolute",
                None,
            ));
        }
        if provision_components(path)? {
            return Ok(());
        }
        set_private_mode(path, PrivateMode::Directory)
    }

    pub(super) fn set_private_mode(
        path: &Path,
        mode: PrivateMode,
    ) -> Result<(), PrivateStorageError> {
        let target = open_target(path, FS::WRITE_DAC)?;
        set_private_mode_handle(target.as_handle(), mode)
    }

    pub(super) fn set_private_mode_handle(
        handle: BorrowedHandle<'_>,
        mode: PrivateMode,
    ) -> Result<(), PrivateStorageError> {
        if target_private_mode_matches(handle, mode)? && mode == PrivateMode::File {
            return Ok(());
        }
        let descriptor = PrivateSecurityDescriptor::owner_only(mode)?;
        let status = unsafe {
            A::SetSecurityInfo(
                handle.as_raw_handle() as F::HANDLE,
                A::SE_FILE_OBJECT,
                S::PROTECTED_DACL_SECURITY_INFORMATION | S::DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                descriptor.dacl()?,
                null_mut(),
            )
        };
        if status != F::ERROR_SUCCESS {
            return Err(failure(
                "storage.private.set_mode",
                "SetSecurityInfo",
                Some(io::Error::from_raw_os_error(status as i32)),
            ));
        }
        verify_private_mode_handle(handle, mode)
    }

    fn provision_components(path: &Path) -> Result<bool, PrivateStorageError> {
        let mut ancestors: Vec<PathBuf> = path
            .ancestors()
            .filter(|ancestor| !ancestor.as_os_str().is_empty())
            .map(PathBuf::from)
            .collect();
        ancestors.reverse();
        let mut create_missing = false;
        let mut target_created = false;
        for candidate in ancestors {
            let created = match fs::symlink_metadata(&candidate) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() || !metadata.is_dir() {
                        return Err(failure(
                            "storage.private.provision",
                            "ancestor_not_plain_directory",
                            None,
                        ));
                    }
                    false
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    create_missing = true;
                    create_private_directory(&candidate)?
                }
                Err(error) => {
                    return Err(failure(
                        "storage.private.provision",
                        "symlink_metadata",
                        Some(error),
                    ));
                }
            };
            if create_missing {
                verify_private_mode(&candidate, PrivateMode::Directory)?;
            }
            if candidate == path {
                target_created = created;
            }
        }
        Ok(target_created)
    }

    fn create_private_directory(path: &Path) -> Result<bool, PrivateStorageError> {
        let descriptor = PrivateSecurityDescriptor::owner_only(PrivateMode::Directory)?;
        let mut attributes = descriptor.attributes();
        let name = wide(path.as_os_str())?;
        if unsafe { FS::CreateDirectoryW(name.as_ptr(), &mut attributes) } != 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(F::ERROR_ALREADY_EXISTS as i32) {
            validate_target(path, PrivateMode::Directory).map(|()| false)
        } else {
            Err(failure(
                "storage.private.create_directory",
                "CreateDirectoryW",
                Some(error),
            ))
        }
    }

    fn validate_target(path: &Path, mode: PrivateMode) -> Result<(), PrivateStorageError> {
        let target = open_target(path, 0)?;
        validate_target_handle(target.as_handle(), mode)
    }

    fn open_target(path: &Path, additional_access: u32) -> Result<fs::File, PrivateStorageError> {
        // Keep validation and security changes on one object, without following or replacing it.
        fs::OpenOptions::new()
            .access_mode(FS::FILE_READ_ATTRIBUTES | FS::READ_CONTROL | additional_access)
            .share_mode(FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE)
            .custom_flags(FS::FILE_FLAG_BACKUP_SEMANTICS | FS::FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|error| failure("storage.private.open", "OpenOptions::open", Some(error)))
    }

    fn validate_target_handle(
        handle: BorrowedHandle<'_>,
        mode: PrivateMode,
    ) -> Result<(), PrivateStorageError> {
        let mut attributes = FS::FILE_ATTRIBUTE_TAG_INFO::default();
        if unsafe {
            FS::GetFileInformationByHandleEx(
                handle.as_raw_handle() as F::HANDLE,
                FS::FileAttributeTagInfo,
                (&mut attributes as *mut FS::FILE_ATTRIBUTE_TAG_INFO).cast(),
                size_of::<FS::FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        } == 0
        {
            return Err(failure(
                "storage.private.validate_target",
                "GetFileInformationByHandleEx",
                Some(io::Error::last_os_error()),
            ));
        }
        if attributes.FileAttributes & FS::FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(failure(
                "storage.private.validate_target",
                "target_reparse_point",
                None,
            ));
        }
        let is_directory = attributes.FileAttributes & FS::FILE_ATTRIBUTE_DIRECTORY != 0;
        if is_directory != (mode == PrivateMode::Directory) {
            return Err(failure(
                "storage.private.validate_target",
                "target_type_mismatch",
                None,
            ));
        }
        Ok(())
    }

    fn verify_private_mode(path: &Path, mode: PrivateMode) -> Result<(), PrivateStorageError> {
        let target = open_target(path, 0)?;
        verify_private_mode_handle(target.as_handle(), mode)
    }

    pub(super) fn verify_private_mode_handle(
        handle: BorrowedHandle<'_>,
        mode: PrivateMode,
    ) -> Result<(), PrivateStorageError> {
        if target_private_mode_matches(handle, mode)? {
            Ok(())
        } else {
            Err(failure(
                "storage.private.verify",
                "private_mode_mismatch",
                None,
            ))
        }
    }

    fn target_private_mode_matches(
        handle: BorrowedHandle<'_>,
        mode: PrivateMode,
    ) -> Result<bool, PrivateStorageError> {
        validate_target_handle(handle, mode)?;
        let mut owner = null_mut();
        let mut dacl = null_mut();
        let mut descriptor = null_mut();
        let status = unsafe {
            A::GetSecurityInfo(
                handle.as_raw_handle() as F::HANDLE,
                A::SE_FILE_OBJECT,
                S::OWNER_SECURITY_INFORMATION | S::DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != F::ERROR_SUCCESS {
            if !descriptor.is_null() {
                // SAFETY: Descriptor ownership is returned by GetSecurityInfo.
                unsafe { F::LocalFree(descriptor) };
            }
            return Err(failure(
                "storage.private.verify",
                "GetSecurityInfo",
                Some(io::Error::from_raw_os_error(status as i32)),
            ));
        }
        if descriptor.is_null() {
            return Err(failure("storage.private.verify", "descriptor_null", None));
        }
        let descriptor = PrivateSecurityDescriptor(descriptor);
        if unsafe { S::IsValidSecurityDescriptor(descriptor.0) } == 0 {
            return Err(failure(
                "storage.private.verify",
                "descriptor_invalid",
                None,
            ));
        }
        if owner.is_null() {
            return Err(failure("storage.private.verify", "owner_null", None));
        }
        if unsafe { S::IsValidSid(owner) } == 0 {
            return Err(failure("storage.private.verify", "owner_sid_invalid", None));
        }
        if !owner_is_current_user(owner)? {
            return Err(failure(
                "storage.private.verify",
                "EqualSid_current_user",
                None,
            ));
        }
        let mut control = 0_u16;
        let mut revision = 0_u32;
        if unsafe { S::GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) }
            == 0
        {
            return Err(failure(
                "storage.private.verify",
                "GetSecurityDescriptorControl",
                Some(io::Error::last_os_error()),
            ));
        }
        if dacl.is_null() {
            failure("storage.private.verify", "dacl_null", None);
            return Ok(false);
        }
        if unsafe { S::IsValidAcl(dacl) } == 0 {
            return Err(failure("storage.private.verify", "dacl_invalid", None));
        }
        if unsafe { (*dacl).AceCount } != 1 {
            failure("storage.private.verify", "ace_count_not_one", None);
            return Ok(false);
        }

        let mut raw_ace: *mut c_void = null_mut();
        if unsafe { S::GetAce(dacl, 0, &mut raw_ace) } == 0 {
            return Err(failure(
                "storage.private.verify",
                "GetAce",
                Some(io::Error::last_os_error()),
            ));
        }
        if raw_ace.is_null() {
            return Err(failure("storage.private.verify", "ace_null", None));
        }
        // SAFETY: GetAce returned an ACE header within the validated ACL.
        let header = unsafe { &*raw_ace.cast::<S::ACE_HEADER>() };
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE {
            failure("storage.private.verify", "ace_type_not_allow", None);
            return Ok(false);
        }
        let sid_offset = offset_of!(S::ACCESS_ALLOWED_ACE, SidStart);
        if usize::from(header.AceSize) < sid_offset + 8 {
            return Err(failure("storage.private.verify", "ace_size_invalid", None));
        }
        // SAFETY: The ACE type and minimum SID header size were checked before reading them.
        let ace = unsafe { &*raw_ace.cast::<S::ACCESS_ALLOWED_ACE>() };
        let sid = addr_of!(ace.SidStart) as S::PSID;
        let sub_authority_count = unsafe { *sid.cast::<u8>().add(1) };
        if usize::from(header.AceSize) != sid_offset + 8 + usize::from(sub_authority_count) * 4 {
            return Err(failure(
                "storage.private.verify",
                "ace_sid_size_invalid",
                None,
            ));
        }
        if unsafe { S::IsValidSid(sid) } == 0 {
            return Err(failure("storage.private.verify", "ace_sid_invalid", None));
        }
        if control & S::SE_DACL_PROTECTED == 0 {
            failure("storage.private.verify", "dacl_not_protected", None);
            return Ok(false);
        }
        if ace.Mask != FS::FILE_ALL_ACCESS {
            failure("storage.private.verify", "ace_mask_not_full_access", None);
            return Ok(false);
        }
        if !ace_inheritance_matches(u32::from(ace.Header.AceFlags), mode) {
            failure("storage.private.verify", "ace_inheritance_mismatch", None);
            return Ok(false);
        }
        if unsafe { S::EqualSid(owner, sid) } == 0
            && unsafe { S::IsWellKnownSid(sid, S::WinCreatorOwnerRightsSid) } == 0
        {
            failure("storage.private.verify", "ace_sid_not_owner", None);
            return Ok(false);
        }
        Ok(true)
    }

    fn ace_inheritance_matches(flags: S::ACE_FLAGS, mode: PrivateMode) -> bool {
        match mode {
            PrivateMode::Directory => flags == S::OBJECT_INHERIT_ACE | S::CONTAINER_INHERIT_ACE,
            // Files cannot propagate ACEs; inheritance provenance does not change their access.
            PrivateMode::File => {
                flags & !(S::OBJECT_INHERIT_ACE | S::CONTAINER_INHERIT_ACE | S::INHERITED_ACE) == 0
            }
        }
    }

    fn owner_is_current_user(owner: S::PSID) -> Result<bool, PrivateStorageError> {
        let mut raw = null_mut();
        if unsafe { T::OpenProcessToken(T::GetCurrentProcess(), S::TOKEN_QUERY, &mut raw) } == 0 {
            return Err(failure(
                "storage.private.token",
                "OpenProcessToken",
                Some(io::Error::last_os_error()),
            ));
        }
        let token = Token(raw);
        let mut required = 0_u32;
        unsafe { S::GetTokenInformation(token.0, S::TokenUser, null_mut(), 0, &mut required) };
        if required < size_of::<S::TOKEN_USER>() as u32 {
            return Err(failure(
                "storage.private.token",
                "GetTokenInformation_required_size",
                Some(io::Error::last_os_error()),
            ));
        }
        let mut buffer = vec![0_u8; required as usize];
        if unsafe {
            S::GetTokenInformation(
                token.0,
                S::TokenUser,
                buffer.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(failure(
                "storage.private.token",
                "GetTokenInformation",
                Some(io::Error::last_os_error()),
            ));
        }
        let user = unsafe { &*(buffer.as_ptr() as *const S::TOKEN_USER) };
        if user.User.Sid.is_null() {
            Err(failure("storage.private.token", "user_sid_null", None))
        } else {
            Ok(unsafe { S::EqualSid(owner, user.User.Sid) } != 0)
        }
    }

    fn wide(value: &OsStr) -> Result<Vec<u16>, PrivateStorageError> {
        if value.encode_wide().any(|unit| unit == 0) {
            return Err(failure("storage.private.wide", "embedded_nul", None));
        }
        Ok(value.encode_wide().chain([0]).collect())
    }
}

#[cfg(unix)]
mod platform {
    use std::{fs, os::unix::fs::PermissionsExt, path::Path};

    use super::{PrivateMode, PrivateStorageError};

    pub(super) fn provision_private_directory(path: &Path) -> Result<(), PrivateStorageError> {
        if let Ok(metadata) = fs::symlink_metadata(path) {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(PrivateStorageError);
            }
        } else {
            fs::create_dir_all(path).map_err(|_| PrivateStorageError)?;
        }
        set_private_mode(path, PrivateMode::Directory)
    }

    pub(super) fn set_private_mode(
        path: &Path,
        mode: PrivateMode,
    ) -> Result<(), PrivateStorageError> {
        let mode = match mode {
            PrivateMode::Directory => 0o700,
            PrivateMode::File => 0o600,
        };
        let mut permissions = fs::metadata(path)
            .map_err(|_| PrivateStorageError)?
            .permissions();
        permissions.set_mode(mode);
        fs::set_permissions(path, permissions).map_err(|_| PrivateStorageError)
    }
}

#[cfg(all(not(windows), not(unix)))]
mod platform {
    use std::{fs, path::Path};

    use super::{PrivateMode, PrivateStorageError};

    pub(super) fn provision_private_directory(path: &Path) -> Result<(), PrivateStorageError> {
        if let Ok(metadata) = fs::symlink_metadata(path) {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(PrivateStorageError);
            }
        } else {
            fs::create_dir_all(path).map_err(|_| PrivateStorageError)?;
        }
        Ok(())
    }

    pub(super) fn set_private_mode(
        _path: &Path,
        _mode: PrivateMode,
    ) -> Result<(), PrivateStorageError> {
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::{PrivateMode, provision_private_directory, set_private_mode};

    #[test]
    fn provision_private_directory_hardens_existing_directory() {
        let root = TestRoot::new("foundation-private-directory");
        let directory = root.path().join("private");
        fs::create_dir(&directory).unwrap();

        provision_private_directory(&directory).unwrap();
        set_private_mode(&directory, PrivateMode::Directory).unwrap();
    }

    #[test]
    fn set_private_mode_hardens_existing_file() {
        let root = TestRoot::new("foundation-private-file");
        let directory = root.path().join("private");
        provision_private_directory(&directory).unwrap();
        let file = directory.join("secret");
        fs::write(&file, b"secret").unwrap();

        set_private_mode(&file, PrivateMode::File).unwrap();
    }

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(name: &str) -> Self {
            static NEXT_ID: AtomicU64 = AtomicU64::new(0);
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("matcha-{name}-{}-{id}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
