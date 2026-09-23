use std::{fs, io::ErrorKind, path::Path};

pub(super) fn preflight(path: &Path) -> Result<(), ()> {
    if !super::directory_exists(path)? {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|_| ())? {
        let path = entry.map_err(|_| ())?.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| ())?;
        if super::is_link(&metadata) {
            return Err(());
        }
        if metadata.is_dir() {
            preflight(&path)?;
        } else if !metadata.is_file() {
            return Err(());
        }
    }
    Ok(())
}

pub(super) fn remove(path: &Path, directory: bool) -> Result<(), ()> {
    platform::remove(path, directory)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        path::PathBuf,
    };
    use windows_sys::Win32::Storage::FileSystem as F;

    fn open(path: &Path, delete: bool) -> Result<Option<OwnedHandle>, ()> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let access = F::FILE_READ_ATTRIBUTES | if delete { 0x00010000 } else { 0 };
        // Without FILE_SHARE_DELETE, no ancestor can be renamed into a junction while held.
        let raw = unsafe {
            F::CreateFileW(
                wide.as_ptr(),
                access,
                F::FILE_SHARE_READ | F::FILE_SHARE_WRITE,
                std::ptr::null(),
                F::OPEN_EXISTING,
                F::FILE_FLAG_BACKUP_SEMANTICS | F::FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if raw == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return match std::io::Error::last_os_error().kind() {
                ErrorKind::NotFound => Ok(None),
                _ => Err(()),
            };
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut info: F::BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { F::GetFileInformationByHandle(handle.as_raw_handle(), &mut info) } == 0
            || info.dwFileAttributes & F::FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(());
        }
        Ok(Some(handle))
    }

    pub(super) fn remove(path: &Path, directory: bool) -> Result<(), ()> {
        let mut ancestors = Vec::new();
        let mut current = PathBuf::new();
        for component in path.parent().ok_or(())?.components() {
            current.push(component.as_os_str());
            if !current.is_absolute() {
                continue;
            }
            let Some(handle) = open(&current, false)? else {
                return Ok(());
            };
            ancestors.push(handle);
        }
        remove_locked(path, directory)
    }

    fn remove_locked(path: &Path, directory: bool) -> Result<(), ()> {
        let Some(handle) = open(path, true)? else {
            return Ok(());
        };
        if directory {
            for entry in fs::read_dir(path).map_err(|_| ())? {
                let entry = entry.map_err(|_| ())?;
                let kind = entry.file_type().map_err(|_| ())?;
                if !kind.is_dir() && !kind.is_file() {
                    return Err(());
                }
                remove_locked(&entry.path(), kind.is_dir())?;
            }
        }
        let disposition = F::FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            F::SetFileInformationByHandle(
                handle.as_raw_handle(),
                F::FileDispositionInfo,
                (&disposition as *const F::FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of_val(&disposition) as u32,
            )
        } == 0
        {
            return Err(());
        }
        Ok(())
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::{
        ffi::{CStr, CString},
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::ffi::OsStrExt,
        },
        path::Component,
    };

    fn open_directory(parent: i32, name: &CStr) -> Result<Option<OwnedFd>, ()> {
        let raw = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if raw < 0 {
            return if std::io::Error::last_os_error().kind() == ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(())
            };
        }
        Ok(Some(unsafe { OwnedFd::from_raw_fd(raw) }))
    }

    pub(super) fn remove(path: &Path, directory: bool) -> Result<(), ()> {
        let mut parent = open_directory(libc::AT_FDCWD, c"/")?.ok_or(())?;
        for component in path.parent().ok_or(())?.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => {
                    let name = CString::new(name.as_bytes()).map_err(|_| ())?;
                    let Some(next) = open_directory(parent.as_raw_fd(), &name)? else {
                        return Ok(());
                    };
                    parent = next;
                }
                _ => return Err(()),
            }
        }
        let name = CString::new(path.file_name().ok_or(())?.as_bytes()).map_err(|_| ())?;
        remove_at(parent.as_raw_fd(), &name, directory)
    }

    fn remove_at(parent: i32, name: &CStr, directory: bool) -> Result<(), ()> {
        if directory {
            let Some(child) = open_directory(parent, name)? else {
                return Ok(());
            };
            let duplicate = unsafe { libc::dup(child.as_raw_fd()) };
            if duplicate < 0 {
                return Err(());
            }
            let stream = unsafe { libc::fdopendir(duplicate) };
            if stream.is_null() {
                unsafe {
                    libc::close(duplicate);
                }
                return Err(());
            }
            let result = (|| {
                loop {
                    let entry = unsafe { libc::readdir(stream) };
                    if entry.is_null() {
                        break;
                    }
                    let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
                    if name == c"." || name == c".." {
                        continue;
                    }
                    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
                    if unsafe {
                        libc::fstatat(
                            child.as_raw_fd(),
                            name.as_ptr(),
                            &mut stat,
                            libc::AT_SYMLINK_NOFOLLOW,
                        )
                    } != 0
                    {
                        return Err(());
                    }
                    let kind = stat.st_mode & libc::S_IFMT;
                    if kind != libc::S_IFDIR && kind != libc::S_IFREG {
                        return Err(());
                    }
                    remove_at(child.as_raw_fd(), name, kind == libc::S_IFDIR)?;
                }
                Ok(())
            })();
            unsafe {
                libc::closedir(stream);
            }
            result?;
        }
        // unlinkat never follows the leaf; all ancestor traversal is descriptor-relative.
        if unsafe {
            libc::unlinkat(
                parent,
                name.as_ptr(),
                if directory { libc::AT_REMOVEDIR } else { 0 },
            )
        } != 0
            && std::io::Error::last_os_error().kind() != ErrorKind::NotFound
        {
            return Err(());
        }
        Ok(())
    }
}
