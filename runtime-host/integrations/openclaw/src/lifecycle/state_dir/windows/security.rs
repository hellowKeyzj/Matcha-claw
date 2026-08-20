use std::{
    ffi::{OsStr, c_void},
    mem::size_of,
    os::windows::ffi::OsStrExt,
    ptr::{addr_of, null_mut},
};

use windows_sys::Win32::{
    Foundation as F,
    Security::{self as S, Authorization as A},
    Storage::FileSystem as FS,
    System::Threading as T,
};

use super::super::StateDirError;

const DIRECTORY_SDDL: &str = "D:P(A;OICI;FA;;;OW)";
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

struct Token(F::HANDLE);

impl Drop for Token {
    fn drop(&mut self) {
        unsafe { F::CloseHandle(self.0) };
    }
}

pub(crate) struct SecurityDescriptor(S::PSECURITY_DESCRIPTOR);

impl SecurityDescriptor {
    pub(crate) fn owner_only() -> Result<Self, StateDirError> {
        let encoded = wide(OsStr::new(DIRECTORY_SDDL))?;
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
            return Err(StateDirError);
        }
        Ok(Self(descriptor))
    }

    pub(crate) fn attributes(&self) -> S::SECURITY_ATTRIBUTES {
        S::SECURITY_ATTRIBUTES {
            nLength: size_of::<S::SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        unsafe { F::LocalFree(self.0) };
    }
}

pub(crate) fn ensure_owner_only(handle: F::HANDLE) -> Result<(), StateDirError> {
    let mut owner = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe {
        A::GetSecurityInfo(
            handle,
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
            unsafe { F::LocalFree(descriptor) };
        }
        return Err(StateDirError);
    }
    unsafe { F::LocalFree(descriptor) };

    let security_descriptor = SecurityDescriptor::owner_only()?;
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = null_mut();
    if unsafe {
        S::GetSecurityDescriptorDacl(
            security_descriptor.0,
            &mut present,
            &mut dacl,
            &mut defaulted,
        )
    } == 0
        || present == 0
        || dacl.is_null()
        || unsafe {
            A::SetSecurityInfo(
                handle,
                A::SE_FILE_OBJECT,
                S::PROTECTED_DACL_SECURITY_INFORMATION | S::DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null_mut(),
            )
        } != F::ERROR_SUCCESS
    {
        return Err(StateDirError);
    }
    Ok(())
}

pub(crate) fn verify_owner_only(handle: F::HANDLE) -> Result<(), StateDirError> {
    let mut owner = null_mut();
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe {
        A::GetSecurityInfo(
            handle,
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
        return Err(StateDirError);
    }
    let descriptor = SecurityDescriptor(descriptor);
    if !owner_is_current_user(owner)? {
        return Err(StateDirError);
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
        return Err(StateDirError);
    }

    let mut raw_ace: *mut c_void = null_mut();
    if unsafe { S::GetAce(dacl, 0, &mut raw_ace) } == 0 || raw_ace.is_null() {
        return Err(StateDirError);
    }
    // SAFETY: GetAce returned the sole ACE from an OS-validated ACL.
    let ace = unsafe { &*(raw_ace as *const S::ACCESS_ALLOWED_ACE) };
    let sid = addr_of!(ace.SidStart) as S::PSID;
    if ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE
        || ace.Mask != FS::FILE_ALL_ACCESS
        || (unsafe { S::EqualSid(owner, sid) } == 0
            && unsafe { S::IsWellKnownSid(sid, S::WinCreatorOwnerRightsSid) } == 0)
    {
        return Err(StateDirError);
    }
    Ok(())
}

fn owner_is_current_user(owner: S::PSID) -> Result<bool, StateDirError> {
    let mut raw = null_mut();
    if unsafe { T::OpenProcessToken(T::GetCurrentProcess(), S::TOKEN_QUERY, &mut raw) } == 0 {
        return Err(StateDirError);
    }
    let token = Token(raw);
    let mut required = 0_u32;
    unsafe { S::GetTokenInformation(token.0, S::TokenUser, null_mut(), 0, &mut required) };
    if required < size_of::<S::TOKEN_USER>() as u32 {
        return Err(StateDirError);
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
        return Err(StateDirError);
    }
    let user = unsafe { &*(buffer.as_ptr() as *const S::TOKEN_USER) };
    if user.User.Sid.is_null() {
        Err(StateDirError)
    } else {
        Ok(unsafe { S::EqualSid(owner, user.User.Sid) } != 0)
    }
}

fn wide(value: &OsStr) -> Result<Vec<u16>, StateDirError> {
    if value.encode_wide().any(|unit| unit == 0) {
        return Err(StateDirError);
    }
    Ok(value.encode_wide().chain([0]).collect())
}
