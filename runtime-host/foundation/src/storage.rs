use std::{fmt, path::Path};

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
mod platform {
    use std::{
        ffi::{OsStr, c_void},
        fs, io,
        mem::size_of,
        os::windows::ffi::OsStrExt,
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

    struct Token(F::HANDLE);

    impl Drop for Token {
        fn drop(&mut self) {
            // SAFETY: Token owns a non-null token handle returned by OpenProcessToken.
            unsafe { F::CloseHandle(self.0) };
        }
    }

    struct SecurityDescriptor(S::PSECURITY_DESCRIPTOR);

    impl SecurityDescriptor {
        fn owner_only(mode: PrivateMode) -> Result<Self, PrivateStorageError> {
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
                || descriptor.is_null()
            {
                return Err(PrivateStorageError);
            }
            Ok(Self(descriptor))
        }

        fn attributes(&self) -> S::SECURITY_ATTRIBUTES {
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
                || present == 0
                || dacl.is_null()
            {
                return Err(PrivateStorageError);
            }
            Ok(dacl)
        }
    }

    impl Drop for SecurityDescriptor {
        fn drop(&mut self) {
            // SAFETY: The descriptor is allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW or GetNamedSecurityInfoW.
            unsafe { F::LocalFree(self.0) };
        }
    }

    pub(super) fn provision_private_directory(path: &Path) -> Result<(), PrivateStorageError> {
        if !path.is_absolute() {
            return Err(PrivateStorageError);
        }
        provision_components(path)?;
        set_private_mode(path, PrivateMode::Directory)
    }

    pub(super) fn set_private_mode(
        path: &Path,
        mode: PrivateMode,
    ) -> Result<(), PrivateStorageError> {
        validate_target(path, mode)?;
        ensure_current_user_owns_path(path)?;
        let descriptor = SecurityDescriptor::owner_only(mode)?;
        let name = wide(path.as_os_str())?;
        let status = unsafe {
            A::SetNamedSecurityInfoW(
                name.as_ptr(),
                A::SE_FILE_OBJECT,
                S::PROTECTED_DACL_SECURITY_INFORMATION | S::DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                descriptor.dacl()?,
                null_mut(),
            )
        };
        if status != F::ERROR_SUCCESS {
            return Err(PrivateStorageError);
        }
        verify_private_mode(path, mode)
    }

    fn provision_components(path: &Path) -> Result<(), PrivateStorageError> {
        let mut ancestors: Vec<PathBuf> = path
            .ancestors()
            .filter(|ancestor| !ancestor.as_os_str().is_empty())
            .map(PathBuf::from)
            .collect();
        ancestors.reverse();
        let mut create_missing = false;
        for candidate in ancestors {
            match fs::symlink_metadata(&candidate) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() || !metadata.is_dir() {
                        return Err(PrivateStorageError);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    create_missing = true;
                    create_private_directory(&candidate)?;
                }
                Err(_) => return Err(PrivateStorageError),
            }
            if create_missing {
                verify_private_mode(&candidate, PrivateMode::Directory)?;
            }
        }
        Ok(())
    }

    fn create_private_directory(path: &Path) -> Result<(), PrivateStorageError> {
        let descriptor = SecurityDescriptor::owner_only(PrivateMode::Directory)?;
        let mut attributes = descriptor.attributes();
        let name = wide(path.as_os_str())?;
        if unsafe { FS::CreateDirectoryW(name.as_ptr(), &mut attributes) } != 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(F::ERROR_ALREADY_EXISTS as i32) {
            validate_target(path, PrivateMode::Directory)
        } else {
            Err(PrivateStorageError)
        }
    }

    fn validate_target(path: &Path, mode: PrivateMode) -> Result<(), PrivateStorageError> {
        let metadata = fs::symlink_metadata(path).map_err(|_| PrivateStorageError)?;
        if metadata.file_type().is_symlink() {
            return Err(PrivateStorageError);
        }
        match mode {
            PrivateMode::Directory if metadata.is_dir() => Ok(()),
            PrivateMode::File if metadata.is_file() => Ok(()),
            _ => Err(PrivateStorageError),
        }
    }

    fn ensure_current_user_owns_path(path: &Path) -> Result<(), PrivateStorageError> {
        let mut owner = null_mut();
        let mut descriptor = null_mut();
        let name = wide(path.as_os_str())?;
        let status = unsafe {
            A::GetNamedSecurityInfoW(
                name.as_ptr(),
                A::SE_FILE_OBJECT,
                S::OWNER_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        };
        if status != F::ERROR_SUCCESS || descriptor.is_null() || !owner_is_current_user(owner)? {
            if !descriptor.is_null() {
                // SAFETY: Descriptor ownership is returned by GetNamedSecurityInfoW.
                unsafe { F::LocalFree(descriptor) };
            }
            return Err(PrivateStorageError);
        }
        // SAFETY: Descriptor ownership is returned by GetNamedSecurityInfoW.
        unsafe { F::LocalFree(descriptor) };
        Ok(())
    }

    fn verify_private_mode(path: &Path, mode: PrivateMode) -> Result<(), PrivateStorageError> {
        let mut owner = null_mut();
        let mut dacl = null_mut();
        let mut descriptor = null_mut();
        let name = wide(path.as_os_str())?;
        let status = unsafe {
            A::GetNamedSecurityInfoW(
                name.as_ptr(),
                A::SE_FILE_OBJECT,
                S::OWNER_SECURITY_INFORMATION | S::DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != F::ERROR_SUCCESS || descriptor.is_null() {
            return Err(PrivateStorageError);
        }
        let descriptor = SecurityDescriptor(descriptor);
        if !owner_is_current_user(owner)? {
            return Err(PrivateStorageError);
        }
        let mut control = 0_u16;
        let mut revision = 0_u32;
        if owner.is_null()
            || dacl.is_null()
            || unsafe { S::GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) }
                == 0
            || control & S::SE_DACL_PROTECTED == 0
            || unsafe { (*dacl).AceCount } != 1
        {
            return Err(PrivateStorageError);
        }

        let mut raw_ace: *mut c_void = null_mut();
        if unsafe { S::GetAce(dacl, 0, &mut raw_ace) } == 0 || raw_ace.is_null() {
            return Err(PrivateStorageError);
        }
        // SAFETY: GetAce returned the sole ACE from an OS-validated ACL.
        let ace = unsafe { &*(raw_ace as *const S::ACCESS_ALLOWED_ACE) };
        let sid = addr_of!(ace.SidStart) as S::PSID;
        if ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE
            || ace.Mask != FS::FILE_ALL_ACCESS
            || !ace_inheritance_matches(u32::from(ace.Header.AceFlags), mode)
            || (unsafe { S::EqualSid(owner, sid) } == 0
                && unsafe { S::IsWellKnownSid(sid, S::WinCreatorOwnerRightsSid) } == 0)
        {
            return Err(PrivateStorageError);
        }
        Ok(())
    }

    fn ace_inheritance_matches(flags: S::ACE_FLAGS, mode: PrivateMode) -> bool {
        match mode {
            PrivateMode::Directory => {
                flags & (S::OBJECT_INHERIT_ACE | S::CONTAINER_INHERIT_ACE)
                    == (S::OBJECT_INHERIT_ACE | S::CONTAINER_INHERIT_ACE)
            }
            PrivateMode::File => flags & (S::OBJECT_INHERIT_ACE | S::CONTAINER_INHERIT_ACE) == 0,
        }
    }

    fn owner_is_current_user(owner: S::PSID) -> Result<bool, PrivateStorageError> {
        let mut raw = null_mut();
        if unsafe { T::OpenProcessToken(T::GetCurrentProcess(), S::TOKEN_QUERY, &mut raw) } == 0 {
            return Err(PrivateStorageError);
        }
        let token = Token(raw);
        let mut required = 0_u32;
        unsafe { S::GetTokenInformation(token.0, S::TokenUser, null_mut(), 0, &mut required) };
        if required < size_of::<S::TOKEN_USER>() as u32 {
            return Err(PrivateStorageError);
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
            return Err(PrivateStorageError);
        }
        let user = unsafe { &*(buffer.as_ptr() as *const S::TOKEN_USER) };
        if user.User.Sid.is_null() {
            Err(PrivateStorageError)
        } else {
            Ok(unsafe { S::EqualSid(owner, user.User.Sid) } != 0)
        }
    }

    fn wide(value: &OsStr) -> Result<Vec<u16>, PrivateStorageError> {
        if value.encode_wide().any(|unit| unit == 0) {
            return Err(PrivateStorageError);
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
