use std::{fmt, num::NonZeroU64};

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct EnvironmentRevision(NonZeroU64);

impl EnvironmentRevision {
    /// Creates a revision assigned to one accepted desired definition.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidEnvironmentRevision`] when `value` is zero.
    pub fn try_new(value: u64) -> Result<Self, InvalidEnvironmentRevision> {
        NonZeroU64::new(value)
            .map(Self)
            .ok_or(InvalidEnvironmentRevision)
    }

    pub fn get(self) -> u64 {
        self.0.get()
    }

    /// Returns the revision immediately following this one.
    ///
    /// # Errors
    ///
    /// Returns [`EnvironmentRevisionOverflow`] when this revision cannot be
    /// incremented without wrapping.
    pub fn next(self) -> Result<Self, EnvironmentRevisionOverflow> {
        self.0
            .get()
            .checked_add(1)
            .and_then(NonZeroU64::new)
            .map(Self)
            .ok_or(EnvironmentRevisionOverflow)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidEnvironmentRevision;

impl fmt::Display for InvalidEnvironmentRevision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("environment revision must be greater than zero")
    }
}

impl std::error::Error for InvalidEnvironmentRevision {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EnvironmentRevisionOverflow;

impl fmt::Display for EnvironmentRevisionOverflow {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("environment revision cannot advance beyond u64::MAX")
    }
}

impl std::error::Error for EnvironmentRevisionOverflow {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_is_positive_and_monotonic() {
        let revision = EnvironmentRevision::try_new(41).unwrap();

        assert_eq!(revision.get(), 41);
        assert_eq!(revision.next().unwrap().get(), 42);
    }

    #[test]
    fn revision_rejects_zero_and_fails_closed_on_overflow() {
        assert_eq!(
            EnvironmentRevision::try_new(0).unwrap_err(),
            InvalidEnvironmentRevision
        );
        assert_eq!(
            EnvironmentRevision::try_new(u64::MAX)
                .unwrap()
                .next()
                .unwrap_err(),
            EnvironmentRevisionOverflow
        );
    }
}
