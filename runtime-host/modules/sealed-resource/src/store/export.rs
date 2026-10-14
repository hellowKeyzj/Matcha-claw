use std::{fs, io, path::Path};

use crate::api::SealedResourceError;

pub(super) fn package_file_name(
    directory: &Path,
    name: &str,
    extension: &str,
) -> Result<String, SealedResourceError> {
    let stem = package_file_stem(name);
    let mut number = 1;
    loop {
        let file_name = if number == 1 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem} ({number}).{extension}")
        };
        match fs::symlink_metadata(directory.join(&file_name)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(file_name),
            Err(_) => return Err(SealedResourceError::Unknown),
            Ok(_) => number += 1,
        }
    }
}

pub(super) fn skill_package_file_name(skill_key: &str) -> String {
    format!("{}.matcha-skillpkg", package_file_stem(skill_key))
}

fn package_file_stem(name: &str) -> String {
    let mut stem = String::new();
    for character in name.trim().chars() {
        let character = if character.is_control()
            || matches!(
                character,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) {
            '_'
        } else {
            character
        };
        if stem.len() + character.len_utf8() > 180 {
            break;
        }
        stem.push(character);
    }
    stem.truncate(stem.trim_end_matches([' ', '.']).len());
    let device = stem
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if stem.is_empty()
        || matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || device
            .strip_prefix("COM")
            .or_else(|| device.strip_prefix("LPT"))
            .is_some_and(|number| {
                matches!(
                    number,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
    {
        stem.insert(0, '_');
    }
    stem
}
