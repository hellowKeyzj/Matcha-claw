use std::{
    cmp::Ordering,
    ffi::{OsStr, OsString},
    io,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
};

use windows_sys::Win32::Globalization as G;

use super::{Launch, io_failure};
use crate::rpc;

pub(super) struct CommandLine {
    pub(super) application: Vec<u16>,
    pub(super) arguments: Vec<u16>,
    pub(super) directory: Vec<u16>,
    pub(super) environment: Vec<u16>,
}

impl CommandLine {
    pub(super) fn prepare(launch: Launch) -> rpc::Result<Self> {
        let executable = executable(&launch)?;
        let mut arguments = Vec::new();
        quote(executable.as_os_str(), &mut arguments)?;
        for argument in &launch.args {
            arguments.push(b' ' as u16);
            quote(OsStr::new(argument), &mut arguments)?;
        }
        arguments.push(0);
        let mut variables: Vec<(Vec<u16>, Vec<u16>)> = Vec::with_capacity(launch.env.len());
        for (key, value) in launch.env {
            if key.is_empty() || key.contains('=') {
                return Err(invalid(
                    "process_environment_key",
                    "CLI environment key is invalid",
                ));
            }
            let key = wide(OsStr::new(&key))?;
            let value = wide(OsStr::new(&value))?;
            let mut index = 0;
            while index < variables.len() {
                match compare(&key, &variables[index].0)? {
                    Ordering::Less => break,
                    Ordering::Equal => {
                        return Err(invalid(
                            "process_environment_duplicate",
                            "CLI environment has case-insensitive duplicate keys",
                        ));
                    }
                    Ordering::Greater => index += 1,
                }
            }
            variables.insert(index, (key, value));
        }
        let mut environment = Vec::new();
        for (key, value) in variables {
            environment.extend_from_slice(&key[..key.len() - 1]);
            environment.push(b'=' as u16);
            environment.extend(value);
        }
        if environment.is_empty() {
            environment.push(0);
        }
        environment.push(0);
        Ok(Self {
            application: wide(executable.as_os_str())?,
            arguments,
            directory: wide(launch.cwd.as_os_str())?,
            environment,
        })
    }
}

fn executable(launch: &Launch) -> rpc::Result<PathBuf> {
    if launch.command.as_os_str().is_empty() {
        return Err(invalid("process_command_empty", "CLI executable is empty"));
    }
    // CreateProcessW runs real executable images, not implicit cmd.exe shims.
    if launch.command.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
    }) {
        return Err(invalid(
            "process_command_script",
            "CLI command must select an executable, not a shell script",
        ));
    }
    let image = |path: PathBuf| {
        if path.extension().is_none() {
            path.with_extension("exe")
        } else {
            path
        }
    };
    if launch.command.is_absolute() {
        return Ok(image(launch.command.clone()));
    }
    if launch.command.components().count() > 1 {
        return Ok(image(launch.cwd.join(&launch.command)));
    }
    let path = launch
        .env
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| OsString::from(value));
    for directory in std::iter::once(launch.cwd.clone())
        .chain(path.as_ref().into_iter().flat_map(std::env::split_paths))
    {
        let directory = if directory.is_absolute() {
            directory
        } else {
            launch.cwd.join(directory)
        };
        let candidate = image(directory.join(Path::new(&launch.command)));
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(io_failure(
        "process_executable_not_found",
        "CLI executable was not found in its launch environment",
        io::Error::from(io::ErrorKind::NotFound),
    ))
}

fn wide(value: &OsStr) -> rpc::Result<Vec<u16>> {
    let mut units: Vec<u16> = value.encode_wide().collect();
    if units.contains(&0) {
        return Err(invalid(
            "process_launch_nul",
            "CLI launch input contains a NUL byte",
        ));
    }
    units.push(0);
    Ok(units)
}

fn compare(left: &[u16], right: &[u16]) -> rpc::Result<Ordering> {
    let length = |units: &[u16]| {
        i32::try_from(units.len() - 1).map_err(|_| {
            invalid(
                "process_environment_key_length",
                "CLI environment key is too long",
            )
        })
    };
    // SAFETY: validated UTF-16 buffers remain alive for their supplied lengths.
    match unsafe {
        G::CompareStringOrdinal(
            left.as_ptr(),
            length(left)?,
            right.as_ptr(),
            length(right)?,
            1,
        )
    } {
        G::CSTR_LESS_THAN => Ok(Ordering::Less),
        G::CSTR_EQUAL => Ok(Ordering::Equal),
        G::CSTR_GREATER_THAN => Ok(Ordering::Greater),
        _ => Err(io_failure(
            "process_environment_compare",
            "CLI environment keys could not be compared",
            io::Error::last_os_error(),
        )),
    }
}

fn quote(argument: &OsStr, output: &mut Vec<u16>) -> rpc::Result<()> {
    let units = wide(argument)?;
    // Always quote: standard Windows CRT escaping, including trailing backslashes.
    output.push(b'"' as u16);
    let mut slashes = 0;
    for unit in &units[..units.len() - 1] {
        if *unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        output.extend(std::iter::repeat_n(
            b'\\' as u16,
            slashes * if *unit == b'"' as u16 { 2 } else { 1 },
        ));
        if *unit == b'"' as u16 {
            output.push(b'\\' as u16);
        }
        output.push(*unit);
        slashes = 0;
    }
    output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    output.push(b'"' as u16);
    Ok(())
}

fn invalid(kind: &'static str, message: &'static str) -> rpc::Error {
    rpc::Error::new(-32602, kind, message)
}
