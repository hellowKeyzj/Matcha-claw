use std::fmt;

#[cfg(unix)]
use std::os::fd::OwnedFd;
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, OwnedHandle};

/// One private native descriptor whose only intended recipient is the launched child.
///
/// It is intentionally separate from `LaunchSpec`: launch specifications remain immutable,
/// serializable spawn input, while this object owns a one-launch native capability.
pub struct ChildDescriptor {
    #[cfg(unix)]
    descriptor: OwnedFd,
    #[cfg(windows)]
    descriptor: OwnedHandle,
}

impl ChildDescriptor {
    #[cfg(unix)]
    pub fn new(descriptor: OwnedFd) -> Self {
        Self { descriptor }
    }

    #[cfg(windows)]
    pub fn new(descriptor: OwnedHandle) -> std::io::Result<Self> {
        use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation};

        // SAFETY: descriptor remains owned by this value. The process adapter later uses an exact
        // handle allowlist, so this flag alone never widens child handle inheritance.
        if unsafe {
            SetHandleInformation(
                descriptor.as_raw_handle() as _,
                HANDLE_FLAG_INHERIT,
                HANDLE_FLAG_INHERIT,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { descriptor })
    }

    /// Returns the non-secret locator that the caller may project into the exact child
    /// environment. On POSIX the guardian reserves a fixed descriptor number.
    pub fn locator(&self) -> usize {
        #[cfg(unix)]
        {
            crate::process::system::posix::PRIVATE_CHILD_DESCRIPTOR_FD as usize
        }
        #[cfg(windows)]
        {
            self.descriptor.as_raw_handle() as usize
        }
    }

    #[cfg(unix)]
    pub(crate) fn into_owned(self) -> OwnedFd {
        self.descriptor
    }

    #[cfg(windows)]
    pub(crate) fn raw(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.descriptor.as_raw_handle() as _
    }
}

impl fmt::Debug for ChildDescriptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ChildDescriptor(<private>)")
    }
}
