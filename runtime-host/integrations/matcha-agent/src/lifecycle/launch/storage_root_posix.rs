use std::{
    ffi::CString,
    io,
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path},
};

pub(super) fn provision(storage_root: &Path) -> Result<(), ()> {
    let mut components = storage_root.components();
    if components.next() != Some(Component::RootDir) {
        return Err(());
    }

    let names = components
        .map(|component| match component {
            Component::Normal(name) => CString::new(name.as_bytes()).map_err(|_| ()),
            _ => Err(()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if names.is_empty() {
        return Err(());
    }
    let root = CString::new("/").expect("root path contains no NUL");
    let mut directory = open_directory_at(libc::AT_FDCWD, &root)?;
    verify_directory(directory.as_raw_fd())?;

    for (index, name) in names.iter().enumerate() {
        if index + 1 == names.len() {
            create_directory_at(&directory, name)?;
        }
        directory = open_directory_at(directory.as_raw_fd(), name)?;
        verify_directory(directory.as_raw_fd())?;
    }

    Ok(())
}

fn create_directory_at(parent: &OwnedFd, name: &CString) -> Result<(), ()> {
    if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o755) } == 0 {
        return Ok(());
    }
    if io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
        Ok(())
    } else {
        Err(())
    }
}

fn open_directory_at(parent: libc::c_int, name: &CString) -> Result<OwnedFd, ()> {
    let descriptor = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor == -1 {
        return Err(());
    }
    // SAFETY: openat returned a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn verify_directory(descriptor: libc::c_int) -> Result<(), ()> {
    let mut metadata = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } == -1 {
        return Err(());
    }
    // SAFETY: fstat initialized metadata after reporting success.
    let metadata = unsafe { metadata.assume_init() };
    if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(());
    }
    Ok(())
}
