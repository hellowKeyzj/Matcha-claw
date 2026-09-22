use std::fmt;

const MAX_OPAQUE_REFERENCE_BYTES: usize = 128;
const MAX_LABEL_BYTES: usize = 128;

#[derive(Clone, Eq, PartialEq)]
pub struct EvidenceReference {
    kind: EvidenceReferenceKind,
    reference: String,
    label: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceReferenceKind {
    WorkspacePath,
    Uri,
    Artifact,
    InlineText,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceReferenceError {
    BlankReference,
    ReferenceTooLong,
    BlankLabel,
    LabelTooLong,
}

impl EvidenceReference {
    pub fn opaque(
        kind: EvidenceReferenceKind,
        reference: impl Into<String>,
        label: Option<String>,
    ) -> Result<Self, EvidenceReferenceError> {
        let reference = reference.into();
        if reference.trim().is_empty() {
            return Err(EvidenceReferenceError::BlankReference);
        }
        if reference.len() > MAX_OPAQUE_REFERENCE_BYTES {
            return Err(EvidenceReferenceError::ReferenceTooLong);
        }
        if let Some(label) = &label {
            if label.trim().is_empty() {
                return Err(EvidenceReferenceError::BlankLabel);
            }
            if label.len() > MAX_LABEL_BYTES {
                return Err(EvidenceReferenceError::LabelTooLong);
            }
        }
        Ok(Self {
            kind,
            reference,
            label,
        })
    }

    pub const fn kind(&self) -> EvidenceReferenceKind {
        self.kind
    }

    pub fn reference(&self) -> &str {
        &self.reference
    }

    pub fn label(&self) -> Option<&str> {
        self.label.as_deref()
    }
}

impl fmt::Debug for EvidenceReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EvidenceReference")
            .field("kind", &self.kind)
            .field("has_reference", &true)
            .field("has_label", &self.label.is_some())
            .finish()
    }
}
