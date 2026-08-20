use std::{
    cmp::Ordering,
    ffi::{OsStr, OsString, c_void},
    os::windows::ffi::OsStrExt,
};

use windows_sys::Win32::Globalization::{
    CSTR_EQUAL, CSTR_GREATER_THAN, CSTR_LESS_THAN, CompareStringOrdinal,
};

use super::{super::super::LaunchSpec, error::WindowsCustodyError, handle::native};

type Result<T> = std::result::Result<T, WindowsCustodyError>;

pub(super) struct CreateProcessInput {
    pub(super) application: Vec<u16>,
    pub(super) command_line: Vec<u16>,
    pub(super) working_directory: Vec<u16>,
    pub(super) environment: Vec<u16>,
}

impl CreateProcessInput {
    pub(super) fn from_spec(spec: &LaunchSpec) -> Result<Self> {
        Ok(Self {
            application: wide(spec.executable().as_os_str(), "executable contains NUL")?,
            command_line: command_line(spec)?,
            working_directory: wide(
                spec.working_directory().as_os_str(),
                "working directory contains NUL",
            )?,
            environment: environment_block(spec.public_environment())?,
        })
    }
}

pub(super) fn environment_ptr(environment: &[u16]) -> *const c_void {
    environment.as_ptr().cast()
}

fn command_line(spec: &LaunchSpec) -> Result<Vec<u16>> {
    let mut command = Vec::new();
    quote(spec.executable().as_os_str(), &mut command)?;
    for argument in spec.arguments() {
        command.push(u16::from(b' '));
        quote(argument, &mut command)?;
    }
    command.push(0);
    Ok(command)
}

fn quote(argument: &OsStr, command: &mut Vec<u16>) -> Result<()> {
    let units: Vec<u16> = argument.encode_wide().collect();
    if units.contains(&0) {
        return Err(WindowsCustodyError::invalid("command line contains NUL"));
    }

    let quoted = units.is_empty() || units.iter().any(|unit| matches!(*unit, 9 | 32 | 34));
    if quoted {
        command.push(u16::from(b'"'));
    }

    let mut backslashes = 0;
    for unit in units {
        if unit == u16::from(b'\\') {
            backslashes += 1;
            continue;
        }
        command.extend(std::iter::repeat_n(
            u16::from(b'\\'),
            backslashes * if unit == u16::from(b'"') { 2 } else { 1 },
        ));
        if unit == u16::from(b'"') {
            command.push(u16::from(b'\\'));
        }
        command.push(unit);
        backslashes = 0;
    }
    command.extend(std::iter::repeat_n(
        u16::from(b'\\'),
        backslashes * if quoted { 2 } else { 1 },
    ));
    if quoted {
        command.push(u16::from(b'"'));
    }
    Ok(())
}

fn wide(value: &OsStr, error: &'static str) -> Result<Vec<u16>> {
    let mut units: Vec<u16> = value.encode_wide().collect();
    if units.contains(&0) {
        return Err(WindowsCustodyError::invalid(error));
    }
    units.push(0);
    Ok(units)
}

struct EnvironmentVariable {
    key: Vec<u16>,
    value: Vec<u16>,
}

fn environment_block(environment: &[(OsString, OsString)]) -> Result<Vec<u16>> {
    let mut variables = Vec::new();
    variables
        .try_reserve_exact(environment.len())
        .map_err(|_| WindowsCustodyError::invalid("environment allocation failed"))?;
    let mut block_length = 1;
    for (key, value) in environment {
        let variable = EnvironmentVariable {
            key: validate_environment_key(key)?,
            value: validate_environment_value(value)?,
        };
        block_length = checked_environment_block_length(
            block_length,
            variable.key.len(),
            variable.value.len(),
        )?;
        insert_environment_variable(&mut variables, variable)?;
    }
    if variables.is_empty() {
        block_length = 2;
    }

    let mut block = Vec::new();
    block
        .try_reserve_exact(block_length)
        .map_err(|_| WindowsCustodyError::invalid("environment allocation failed"))?;
    for variable in variables {
        block.extend(variable.key);
        block.push(u16::from(b'='));
        block.extend(variable.value);
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

fn checked_environment_block_length(current: usize, key: usize, value: usize) -> Result<usize> {
    current
        .checked_add(key)
        .and_then(|length| length.checked_add(1))
        .and_then(|length| length.checked_add(value))
        .and_then(|length| length.checked_add(1))
        .ok_or_else(|| WindowsCustodyError::invalid("environment block is too large"))
}

fn insert_environment_variable(
    variables: &mut Vec<EnvironmentVariable>,
    variable: EnvironmentVariable,
) -> Result<()> {
    for index in 0..variables.len() {
        match compare_environment_keys(&variable.key, &variables[index].key)? {
            Ordering::Less => {
                variables.insert(index, variable);
                return Ok(());
            }
            Ordering::Equal => {
                return Err(WindowsCustodyError::invalid("duplicate environment key"));
            }
            Ordering::Greater => {}
        }
    }
    variables.push(variable);
    Ok(())
}

fn environment_units(value: &OsStr) -> Result<Vec<u16>> {
    let length = value.encode_wide().count();
    let mut units = Vec::new();
    units
        .try_reserve_exact(length)
        .map_err(|_| WindowsCustodyError::invalid("environment allocation failed"))?;
    units.extend(value.encode_wide());
    Ok(units)
}

fn validate_environment_key(key: &OsStr) -> Result<Vec<u16>> {
    let units = environment_units(key)?;
    if units.is_empty() {
        Err(WindowsCustodyError::invalid("environment key is empty"))
    } else if units.contains(&0) {
        Err(WindowsCustodyError::invalid("environment contains NUL"))
    } else if units.contains(&u16::from(b'=')) {
        Err(WindowsCustodyError::invalid("environment key contains '='"))
    } else {
        Ok(units)
    }
}

fn validate_environment_value(value: &OsStr) -> Result<Vec<u16>> {
    let units = environment_units(value)?;
    if units.contains(&0) {
        Err(WindowsCustodyError::invalid("environment contains NUL"))
    } else {
        Ok(units)
    }
}

fn checked_environment_key_length(length: usize) -> Result<i32> {
    i32::try_from(length).map_err(|_| WindowsCustodyError::invalid("environment key is too long"))
}

fn compare_environment_keys(left: &[u16], right: &[u16]) -> Result<Ordering> {
    let left_length = checked_environment_key_length(left.len())?;
    let right_length = checked_environment_key_length(right.len())?;
    // SAFETY: both slices remain valid for their declared lengths during the call.
    match unsafe {
        CompareStringOrdinal(left.as_ptr(), left_length, right.as_ptr(), right_length, 1)
    } {
        CSTR_LESS_THAN => Ok(Ordering::Less),
        CSTR_EQUAL => Ok(Ordering::Equal),
        CSTR_GREATER_THAN => Ok(Ordering::Greater),
        _ => Err(native("CompareStringOrdinal")),
    }
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;
