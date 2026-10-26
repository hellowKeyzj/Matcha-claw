use std::collections::BTreeSet;

use world_protocol::definitions::{
    Definition, DefinitionBody, DefinitionFailure, DefinitionFieldReason as Reason,
    DefinitionLifecycle,
};

use super::invalid;

pub(crate) fn validate_revision(
    previous: Option<&Definition<DefinitionBody>>,
    next: &Definition<DefinitionBody>,
) -> Result<(), DefinitionFailure> {
    match previous {
        None => {
            if next.reference.revision.0 == 0
                || next.reference.revision.0 > i64::MAX as u64
                || next.previous_ref.is_some()
                || !matches!(next.lifecycle, DefinitionLifecycle::Available)
            {
                return Err(DefinitionFailure::LifecycleConflict);
            }
        }
        Some(previous) => {
            if previous.reference.world != next.reference.world
                || previous.reference.id != next.reference.id
                || previous.body.kind() != next.body.kind()
                || next.previous_ref.as_ref() != Some(&previous.reference)
            {
                return Err(DefinitionFailure::LifecycleConflict);
            }
            if next.reference.revision <= previous.reference.revision
                || next.reference.revision.0 > i64::MAX as u64
            {
                return Err(DefinitionFailure::LifecycleConflict);
            }
            if !matches!(previous.lifecycle, DefinitionLifecycle::Available)
                && next.lifecycle != previous.lifecycle
            {
                return Err(DefinitionFailure::LifecycleConflict);
            }
            match (&previous.body, &next.body) {
                (DefinitionBody::Extension(previous), DefinitionBody::Extension(next)) => {
                    if previous.name != next.name || previous.contract != next.contract {
                        return Err(DefinitionFailure::LifecycleConflict);
                    }
                }
                (DefinitionBody::RelationType(previous), DefinitionBody::RelationType(next)) => {
                    for role in &previous.roles {
                        if next
                            .roles
                            .iter()
                            .find(|replacement| replacement.id == role.id)
                            .is_none_or(|replacement| {
                                replacement.target_type.id != role.target_type.id
                            })
                        {
                            return Err(invalid(
                                &["roles".into(), role.id.to_string()],
                                Reason::InvalidRole,
                            ));
                        }
                    }
                }
                (DefinitionBody::StateModel(previous), DefinitionBody::StateModel(next)) => {
                    if previous.property.id != next.property.id {
                        return Err(DefinitionFailure::LifecycleConflict);
                    }
                    for state in &previous.states {
                        if !next
                            .states
                            .iter()
                            .any(|replacement| replacement.id == state.id)
                        {
                            return Err(invalid(
                                &["states".into(), state.id.to_string()],
                                Reason::InvalidState,
                            ));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    validate_lifecycle(next)
}

pub(super) fn validate_lifecycle(
    next: &Definition<DefinitionBody>,
) -> Result<(), DefinitionFailure> {
    match &next.lifecycle {
        DefinitionLifecycle::Available => {}
        DefinitionLifecycle::Deprecated {
            replacements,
            reason,
            effective_at,
        } => {
            if reason.trim().is_empty() {
                return Err(invalid(
                    &["lifecycle".into(), "reason".into()],
                    Reason::Empty,
                ));
            }
            if effective_at < &next.valid_time.from {
                return Err(DefinitionFailure::LifecycleConflict);
            }
            validate_replacements(replacements, next, false)?;
        }
        DefinitionLifecycle::Split {
            replacements,
            effective_at,
        } => {
            if effective_at < &next.valid_time.from {
                return Err(DefinitionFailure::LifecycleConflict);
            }
            validate_replacements(replacements, next, true)?;
        }
    }
    Ok(())
}

fn validate_replacements(
    replacements: &[world_protocol::ids::DefinitionRef],
    next: &Definition<DefinitionBody>,
    split: bool,
) -> Result<(), DefinitionFailure> {
    let mut ids = BTreeSet::new();
    if split && replacements.len() < 2 {
        return Err(DefinitionFailure::LifecycleConflict);
    }
    for replacement in replacements {
        if replacement.world != next.reference.world
            || replacement.id == next.reference.id
            || replacement.revision.0 == 0
            || !ids.insert(&replacement.id)
        {
            return Err(DefinitionFailure::LifecycleConflict);
        }
    }
    Ok(())
}
