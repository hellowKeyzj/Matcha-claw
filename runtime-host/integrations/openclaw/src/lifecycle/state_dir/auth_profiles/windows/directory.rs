use std::{
    ffi::OsStr,
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    },
    ptr::{null, null_mut},
};

use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as NFS},
    Win32::{Foundation as F, Storage::FileSystem as FS, System::IO::IO_STATUS_BLOCK},
};

use super::super::super::{AgentId, StateDirError};
use crate::lifecycle::state_dir::{
    StateDirHandle,
    windows::security::{self, ensure_owner_only},
};

const AGENTS: &str = "agents";
const AGENT: &str = "agent";

pub(super) fn auth_directory(
    state_dir: &StateDirHandle,
    agent: &AgentId,
    create_missing: bool,
) -> Result<Option<OwnedHandle>, StateDirError> {
    let Some(agents) = open_or_create(state_dir.raw_handle(), AGENTS, create_missing)? else {
        return Ok(None);
    };
    let Some(agent_directory) = open_or_create(
        agents.as_raw_handle() as F::HANDLE,
        agent.as_str(),
        create_missing,
    )?
    else {
        return Ok(None);
    };
    open_or_create(
        agent_directory.as_raw_handle() as F::HANDLE,
        AGENT,
        create_missing,
    )
}

fn open_or_create(
    parent: F::HANDLE,
    name: &str,
    create_missing: bool,
) -> Result<Option<OwnedHandle>, StateDirError> {
    match open_existing(parent, name) {
        Ok(Some(directory)) => {
            ensure_owner_only(directory.as_raw_handle() as F::HANDLE)?;
            verify(directory.as_raw_handle() as F::HANDLE)?;
            Ok(Some(directory))
        }
        Ok(None) if create_missing => create(parent, name).map(Some),
        Ok(None) => Ok(None),
        Err(()) => Err(StateDirError),
    }
}

fn open_existing(parent: F::HANDLE, name: &str) -> Result<Option<OwnedHandle>, ()> {
    let name = relative_name(name).map_err(|_| ())?;
    let mut object_name = unicode_string(&name);
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent,
        ObjectName: &mut object_name,
        Attributes: F::OBJ_CASE_INSENSITIVE | F::OBJ_DONT_REPARSE,
        SecurityDescriptor: null_mut(),
        SecurityQualityOfService: null(),
    };
    open(
        &attributes,
        FS::FILE_READ_ATTRIBUTES
            | FS::READ_CONTROL
            | FS::WRITE_DAC
            | FS::FILE_ADD_FILE
            | FS::SYNCHRONIZE,
        FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE,
        NFS::FILE_OPEN,
        NFS::FILE_DIRECTORY_FILE | NFS::FILE_OPEN_REPARSE_POINT | NFS::FILE_SYNCHRONOUS_IO_NONALERT,
    )
}

fn create(parent: F::HANDLE, name: &str) -> Result<OwnedHandle, StateDirError> {
    let security = security::SecurityDescriptor::owner_only()?;
    let name = relative_name(name)?;
    let mut object_name = unicode_string(&name);
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent,
        ObjectName: &mut object_name,
        Attributes: F::OBJ_CASE_INSENSITIVE | F::OBJ_DONT_REPARSE,
        SecurityDescriptor: security.attributes().lpSecurityDescriptor.cast(),
        SecurityQualityOfService: null(),
    };
    let directory = open(
        &attributes,
        FS::FILE_READ_ATTRIBUTES
            | FS::READ_CONTROL
            | FS::WRITE_DAC
            | FS::FILE_ADD_FILE
            | FS::SYNCHRONIZE,
        FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE,
        NFS::FILE_CREATE,
        NFS::FILE_DIRECTORY_FILE | NFS::FILE_OPEN_REPARSE_POINT | NFS::FILE_SYNCHRONOUS_IO_NONALERT,
    )
    .map_err(|_| StateDirError)?
    .ok_or(StateDirError)?;
    verify(directory.as_raw_handle() as F::HANDLE)?;
    Ok(directory)
}

fn open(
    attributes: &OBJECT_ATTRIBUTES,
    access: u32,
    share: u32,
    disposition: u32,
    options: u32,
) -> Result<Option<OwnedHandle>, ()> {
    let mut status = IO_STATUS_BLOCK::default();
    let mut handle = null_mut();
    let result = unsafe {
        NFS::NtCreateFile(
            &mut handle,
            access,
            attributes,
            &mut status,
            null(),
            FS::FILE_ATTRIBUTE_DIRECTORY,
            share,
            disposition,
            options,
            null(),
            0,
        )
    };
    if result == F::STATUS_OBJECT_NAME_NOT_FOUND {
        return Ok(None);
    }
    if result < 0 {
        return Err(());
    }
    // SAFETY: NtCreateFile returned a newly owned handle.
    Ok(Some(unsafe {
        OwnedHandle::from_raw_handle(handle as RawHandle)
    }))
}

fn verify(handle: F::HANDLE) -> Result<(), StateDirError> {
    let mut attributes = FS::FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        FS::GetFileInformationByHandleEx(
            handle,
            FS::FileAttributeTagInfo,
            (&mut attributes as *mut FS::FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FS::FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
        || attributes.FileAttributes & FS::FILE_ATTRIBUTE_REPARSE_POINT != 0
        || attributes.FileAttributes & FS::FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err(StateDirError);
    }
    security::verify_owner_only(handle)
}

fn relative_name(value: &str) -> Result<Vec<u16>, StateDirError> {
    if value.is_empty() || value.contains(['\\', '/']) || value == "." || value == ".." {
        return Err(StateDirError);
    }
    let encoded: Vec<u16> = OsStr::new(value).encode_wide().collect();
    (!encoded.is_empty() && encoded.len() <= usize::from(u16::MAX / 2))
        .then_some(encoded)
        .ok_or(StateDirError)
}

fn unicode_string(value: &[u16]) -> F::UNICODE_STRING {
    F::UNICODE_STRING {
        Length: std::mem::size_of_val(value) as u16,
        MaximumLength: std::mem::size_of_val(value) as u16,
        Buffer: value.as_ptr().cast_mut(),
    }
}
