use std::{fs, io, path::Path};

pub(crate) fn replace_file(temporary: &Path, target: &Path) -> io::Result<()> {
    fs::rename(temporary, target)
}
