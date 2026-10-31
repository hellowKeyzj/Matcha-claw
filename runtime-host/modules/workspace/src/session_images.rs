#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionImage {
    pub reference: String,
    pub name: String,
    pub mime_type: Option<String>,
    pub readable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionImagePage {
    pub items: Vec<SessionImage>,
    pub next_cursor: Option<String>,
    pub omitted_oversized: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionImageData {
    pub name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionImageFailure {
    Unsupported,
    CursorInvalid,
    InvalidReference,
    TooLarge,
    Unavailable,
}
