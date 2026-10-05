pub(crate) fn len(text: &str) -> usize {
    text.encode_utf16().count()
}

// Unlike JS slice, a budget inside a surrogate pair contracts to a Unicode boundary.
pub(crate) fn prefix(text: &str, limit: usize) -> &str {
    let mut remaining = limit;
    for (index, character) in text.char_indices() {
        let width = character.len_utf16();
        if width > remaining {
            return &text[..index];
        }
        remaining -= width;
    }
    text
}

pub(crate) fn suffix(text: &str, limit: usize) -> &str {
    let mut remaining = limit;
    for (index, character) in text.char_indices().rev() {
        let width = character.len_utf16();
        if width > remaining {
            return &text[index + character.len_utf8()..];
        }
        remaining -= width;
    }
    text
}
