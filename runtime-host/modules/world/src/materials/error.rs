use std::{error::Error as StdError, fmt};

use world_protocol::materials::MaterialFailure;

pub(crate) struct Error {
    reason: MaterialFailure,
    source: Option<Cause>,
    cleanup: Vec<crate::content::Error>,
    related: Vec<Error>,
}

enum Cause {
    Content(crate::content::Error),
    Other(Box<dyn StdError + Send + Sync>),
}

impl Error {
    pub(crate) fn new(reason: MaterialFailure) -> Self {
        Self {
            reason,
            source: None,
            cleanup: Vec::new(),
            related: Vec::new(),
        }
    }

    pub(crate) fn caused(
        reason: MaterialFailure,
        source: impl StdError + Send + Sync + 'static,
    ) -> Self {
        Self {
            source: Some(Cause::Other(Box::new(source))),
            ..Self::new(reason)
        }
    }

    pub(crate) fn reason(&self) -> &MaterialFailure {
        &self.reason
    }

    pub(super) fn cleanup(&mut self, result: Result<(), crate::content::Error>) {
        if let Err(error) = result {
            self.cleanup.push(error);
        }
    }

    pub(super) fn with_related(mut self, error: Error) -> Self {
        self.related.push(error);
        self
    }
}

impl From<crate::content::Error> for Error {
    fn from(error: crate::content::Error) -> Self {
        let reason = error
            .reason()
            .cloned()
            .unwrap_or(MaterialFailure::InternalFault);
        Self {
            source: Some(Cause::Content(error)),
            ..Self::new(reason)
        }
    }
}

impl From<Error> for crate::owner::Error {
    fn from(error: Error) -> Self {
        use world_protocol::{
            api::ApiFailure,
            failure::{FailureStage, Recovery},
            operation::OperationFailure,
        };
        let Error {
            reason,
            source,
            cleanup,
            related,
        } = error;
        let mut error = match source {
            Some(Cause::Content(error)) => error.into(),
            source => Self::new(
                "world.material.failed",
                FailureStage::Parse,
                "资料处理失败。",
                ApiFailure::Operation(OperationFailure::Material(reason.clone())),
                Recovery::Refresh,
            )
            .caused(Error {
                reason,
                source,
                cleanup: Vec::new(),
                related: Vec::new(),
            }),
        };
        for cleanup in cleanup {
            error = error.with_related(cleanup.into());
        }
        for related in related {
            error = error.with_related(related.into());
        }
        error
    }
}

impl From<document_parser::ParseFailure> for Error {
    fn from(error: document_parser::ParseFailure) -> Self {
        use document_parser::FailureKind;
        let reason = match error.kind {
            FailureKind::Unsupported => MaterialFailure::UnsupportedFormat,
            FailureKind::Corrupt => MaterialFailure::CorruptContent,
            FailureKind::Encrypted => MaterialFailure::EncryptedContent,
            FailureKind::ParserUnavailable => MaterialFailure::ParserUnavailable,
            FailureKind::ResourceLimit => MaterialFailure::SizeLimit,
            FailureKind::Cancelled => MaterialFailure::Cancelled,
            FailureKind::Internal => MaterialFailure::InternalFault,
        };
        Self::caused(reason, error)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "world material {:?}", self.reason)
    }
}

impl fmt::Debug for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MaterialError")
            .field("reason", &self.reason)
            .field("cleanup_failed", &!self.cleanup.is_empty())
            .finish_non_exhaustive()
    }
}

impl StdError for Error {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.source.as_ref().map(|source| match source {
            Cause::Content(error) => error as &(dyn StdError + 'static),
            Cause::Other(error) => error.as_ref(),
        })
    }
}
