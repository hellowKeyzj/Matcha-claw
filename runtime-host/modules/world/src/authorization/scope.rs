use super::{AuthError, digest};
use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::{AccessScope, ActualImpact, AuthorizationFailure},
    expression::Effect,
    ids::{SourceId, StateRef},
};

/// Trusted grant data, not a permission extracted from a document. Empty resource/field
/// lists mean all resources/fields in the exact named scope; modes are never implicit.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccessGrant {
    pub access: Vec<AccessScope>,
    pub labels: Vec<String>,
    pub effects: Vec<Effect>,
}

pub(crate) fn actual_impact(
    mut access: Vec<AccessScope>,
    mut effects: Vec<Effect>,
    mut labels: Vec<String>,
    mut state: Vec<StateRef>,
    mut source_ids: Vec<SourceId>,
) -> Result<ActualImpact, AuthError> {
    if access.is_empty()
        || access.len() > 4096
        || labels.len() > 256
        || state.len() > 4096
        || source_ids.len() > 4096
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    for scope in &mut access {
        if scope.modes.is_empty() || scope.resources.len() > 4096 || scope.fields.len() > 4096 {
            return Err(AuthorizationFailure::InsufficientScope.into());
        }
        scope.resources.sort();
        scope.resources.dedup();
        scope.fields.sort();
        scope.fields.dedup();
        scope.modes.sort();
        scope.modes.dedup();
    }
    effects.sort();
    effects.dedup();
    labels.sort();
    labels.dedup();
    if labels
        .iter()
        .any(|label| label.is_empty() || label.len() > 256 || label.chars().any(char::is_control))
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    state.sort();
    state.dedup();
    source_ids.sort();
    source_ids.dedup();
    let digest = digest(&(&access, &effects, &labels, &state, &source_ids))?;
    Ok(ActualImpact {
        access,
        effects,
        labels,
        state,
        source_ids,
        digest,
    })
}

pub(super) fn validate_impact(impact: &ActualImpact) -> Result<(), AuthError> {
    let rebuilt = actual_impact(
        impact.access.clone(),
        impact.effects.clone(),
        impact.labels.clone(),
        impact.state.clone(),
        impact.source_ids.clone(),
    )?;
    if rebuilt != *impact {
        return Err(AuthorizationFailure::RequestDigestMismatch.into());
    }
    Ok(())
}

pub(super) fn covers(grant: &AccessScope, requested: &AccessScope) -> bool {
    grant.scope == requested.scope
        && requested
            .modes
            .iter()
            .all(|mode| grant.modes.contains(mode))
        && (grant.resources.is_empty()
            || (!requested.resources.is_empty()
                && requested
                    .resources
                    .iter()
                    .all(|resource| grant.resources.contains(resource))))
        && (grant.fields.is_empty()
            || (!requested.fields.is_empty()
                && requested
                    .fields
                    .iter()
                    .all(|field| grant.fields.contains(field))))
        && match (&grant.valid_time, &requested.valid_time) {
            (None, _) => true,
            (Some(_), None) => false,
            (Some(grant), Some(request)) => {
                grant.from <= request.from
                    && match (&grant.to, &request.to) {
                        (None, _) => true,
                        (Some(_), None) => false,
                        (Some(g), Some(r)) => r <= g,
                    }
            }
        }
}

pub(super) fn permits(grant: &AccessGrant, impact: &ActualImpact) -> bool {
    impact
        .access
        .iter()
        .all(|access| grant.access.iter().any(|allowed| covers(allowed, access)))
        && impact
            .labels
            .iter()
            .all(|label| grant.labels.contains(label))
        && impact
            .effects
            .iter()
            .filter(|effect| **effect != Effect::Pure)
            .all(|effect| grant.effects.contains(effect))
}

pub(super) fn overlaps(left: &AccessScope, right: &AccessScope) -> bool {
    left.scope == right.scope
        && left.modes.iter().any(|mode| right.modes.contains(mode))
        && (left.resources.is_empty()
            || right.resources.is_empty()
            || left.resources.iter().any(|r| right.resources.contains(r)))
        && (left.fields.is_empty()
            || right.fields.is_empty()
            || left.fields.iter().any(|f| right.fields.contains(f)))
        && match (&left.valid_time, &right.valid_time) {
            (Some(l), Some(r)) => {
                l.to.as_ref().is_none_or(|to| &r.from < to)
                    && r.to.as_ref().is_none_or(|to| &l.from < to)
            }
            _ => true,
        }
}
