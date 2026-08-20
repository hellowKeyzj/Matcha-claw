use std::cmp::Ordering;
use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Globalization::{
    CSTR_EQUAL, CSTR_GREATER_THAN, CSTR_LESS_THAN, CompareStringOrdinal,
};

use super::InvalidLaunchSpec;

pub(super) fn validate_public_environment_keys(
    public_environment: &[(OsString, OsString)],
) -> Result<(), InvalidLaunchSpec> {
    let mut keys = Vec::<Vec<u16>>::new();
    keys.try_reserve_exact(public_environment.len())
        .map_err(|_| InvalidLaunchSpec::EnvironmentKeyComparisonFailed)?;

    for (key, _) in public_environment {
        let length = key.encode_wide().count();
        let mut key_units = Vec::new();
        key_units
            .try_reserve_exact(length)
            .map_err(|_| InvalidLaunchSpec::EnvironmentKeyComparisonFailed)?;
        key_units.extend(key.encode_wide());
        for observed in &keys {
            if compare_environment_keys(&key_units, observed)? == Ordering::Equal {
                return Err(InvalidLaunchSpec::DuplicateEnvironmentKey);
            }
        }
        keys.push(key_units);
    }
    Ok(())
}

fn compare_environment_keys(left: &[u16], right: &[u16]) -> Result<Ordering, InvalidLaunchSpec> {
    let left_length = comparison_length(left.len())?;
    let right_length = comparison_length(right.len())?;
    // SAFETY: both slices remain valid for their declared lengths during this call.
    match unsafe {
        CompareStringOrdinal(left.as_ptr(), left_length, right.as_ptr(), right_length, 1)
    } {
        CSTR_LESS_THAN => Ok(Ordering::Less),
        CSTR_EQUAL => Ok(Ordering::Equal),
        CSTR_GREATER_THAN => Ok(Ordering::Greater),
        _ => Err(InvalidLaunchSpec::EnvironmentKeyComparisonFailed),
    }
}

fn comparison_length(length: usize) -> Result<i32, InvalidLaunchSpec> {
    i32::try_from(length).map_err(|_| InvalidLaunchSpec::EnvironmentKeyComparisonFailed)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::{InvalidLaunchSpec, validate_public_environment_keys};

    #[test]
    fn rejects_windows_ordinal_case_insensitive_duplicate_environment_keys() {
        for keys in [("PATH", "path"), ("Å", "å")] {
            let environment = [
                (OsString::from(keys.0), OsString::from("one")),
                (OsString::from(keys.1), OsString::from("two")),
            ];

            assert_eq!(
                validate_public_environment_keys(&environment),
                Err(InvalidLaunchSpec::DuplicateEnvironmentKey)
            );
        }
    }

    #[test]
    fn accepts_ordinal_distinct_environment_keys() {
        let environment = [
            (OsString::from("PATH"), OsString::from("one")),
            (OsString::from("PATHEXT"), OsString::from("two")),
        ];

        assert_eq!(validate_public_environment_keys(&environment), Ok(()));
    }
}
