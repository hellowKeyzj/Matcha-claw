use std::{fmt, num::NonZeroU64};

macro_rules! text_identity {
    ($name:ident, $label:literal) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidIdentity> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err(InvalidIdentity { label: $label });
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

text_identity!(SessionId, "session ID");
text_identity!(TargetId, "target ID");
text_identity!(ProviderId, "provider ID");

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionIdAllocator {
    next: Option<NonZeroU64>,
}

impl Default for SessionIdAllocator {
    fn default() -> Self {
        Self {
            next: NonZeroU64::new(1),
        }
    }
}

impl SessionIdAllocator {
    pub fn next(&mut self) -> Option<SessionId> {
        let sequence = self.next.take()?;
        self.next = sequence.get().checked_add(1).and_then(NonZeroU64::new);
        Some(
            SessionId::try_new(format!("terminal-session-{}", sequence.get()))
                .expect("allocator-generated terminal session ID is valid"),
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidIdentity {
    label: &'static str,
}

impl fmt::Display for InvalidIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} must not be empty", self.label)
    }
}

impl std::error::Error for InvalidIdentity {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Dimensions {
    rows: u16,
    cols: u16,
}

impl Dimensions {
    pub fn try_new(rows: u16, cols: u16) -> Result<Self, InvalidDimensions> {
        if !(1..=1000).contains(&rows) || !(1..=1000).contains(&cols) {
            return Err(InvalidDimensions);
        }
        Ok(Self { rows, cols })
    }

    pub const fn rows(self) -> u16 {
        self.rows
    }

    pub const fn cols(self) -> u16 {
        self.cols
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidDimensions;

impl fmt::Display for InvalidDimensions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("terminal rows and columns must be between 1 and 1000")
    }
}

impl std::error::Error for InvalidDimensions {}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Generation(NonZeroU64);

impl Generation {
    pub const FIRST: Self = Self(NonZeroU64::new(1).unwrap());

    pub const fn get(self) -> u64 {
        self.0.get()
    }

    pub fn next(self) -> Option<Self> {
        NonZeroU64::new(self.get().checked_add(1)?).map(Self)
    }
}
