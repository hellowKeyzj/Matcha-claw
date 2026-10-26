use std::collections::BTreeSet;

use world_protocol::{
    definitions::{Definition, DefinitionBody, RelationType, Scope},
    facts::{Assertion, AssertionOrigin, AuthorityOwnership, Claim, FactFailure, SourceAuthority},
    ids::ScopeId,
    sources::{ChangeStreamCapability, SyncPolicy},
    time::{Timestamp, ValidTime},
};

use crate::definitions::{scope_contains, valid_time_contains};

use super::Error;

pub(super) fn validate_retraction_authority(
    binding: &Definition<DefinitionBody>,
    authority: &SourceAuthority,
    scope: &ScopeId,
    valid_time: &ValidTime,
    scopes: &[Scope],
    now: &Timestamp,
) -> Result<(), Error> {
    let denied = || FactFailure::SourceAuthorityDenied {
        binding: binding.reference.clone(),
    };
    let DefinitionBody::SourceBinding(source) = &binding.body else {
        return Err(denied().into());
    };
    if authority.world != binding.reference.world
        || authority.binding != binding.reference
        || authority.authority != source.authority
        || authority.source_id != source.source_id
        || authority.incarnation != source.incarnation
        || authority.recorded_at > *now
        || !valid_time_contains(&authority.valid_time, valid_time)
        || !valid_time_contains(&binding.valid_time, valid_time)
        || !scope_contains(&authority.world, &authority.scope, scope, scopes)?
        || !scope_contains(&authority.world, &source.scope, scope, scopes)?
    {
        return Err(denied().into());
    }
    Ok(())
}

/// Consumes an approved exact authority record, never a source's self-reported grant.
pub(super) fn validate_authority(
    assertion: &Assertion,
    binding_definition: &Definition<DefinitionBody>,
    authority: &SourceAuthority,
    scopes: &[Scope],
    relation_definition: Option<&RelationType>,
) -> Result<(), Error> {
    let AssertionOrigin::Source {
        binding,
        authority: requested,
        position,
    } = &assertion.origin
    else {
        return Ok(());
    };
    let denied = || {
        FactFailure::SourceAuthorityDenied {
            binding: binding.clone(),
        }
        .into()
    };
    let DefinitionBody::SourceBinding(source) = &binding_definition.body else {
        return Err(denied());
    };
    if binding != &binding_definition.reference
        || binding != &authority.binding
        || authority.world != assertion.reference.world
        || binding.world != authority.world
        || authority.source_id != source.source_id
        || authority.incarnation != source.incarnation
        || requested != &authority.authority
        || requested != &source.authority
        || authority.recorded_at > assertion.recorded_at
        || !valid_time_contains(&authority.valid_time, &assertion.valid_time)
        || !valid_time_contains(&binding_definition.valid_time, &assertion.valid_time)
        || !scope_contains(&authority.world, &authority.scope, &assertion.scope, scopes)?
        || !scope_contains(&authority.world, &source.scope, &assertion.scope, scopes)?
    {
        return Err(denied());
    }
    if position.as_ref().is_some_and(|position| {
        position.source_id != source.source_id || position.incarnation != source.incarnation
    }) {
        return Err(denied());
    }
    if matches!(source.sync, SyncPolicy::ChangeStream)
        && (position.is_none() || source.capabilities.change_stream == ChangeStreamCapability::None)
    {
        return Err(FactFailure::SourceCapabilityMissing {
            capability: world_protocol::sources::SourceCapability::ChangeStream,
        }
        .into());
    }
    match (&assertion.claim, &authority.ownership) {
        (Claim::Attribute(claim), AuthorityOwnership::Properties { properties })
            if properties.contains(&claim.property)
                && requested.fields.contains(&claim.property.id) =>
        {
            Ok(())
        }
        (
            Claim::Relation(claim),
            AuthorityOwnership::RelationRoles {
                relation_type,
                roles,
            },
        ) if relation_type == &claim.relation_type => {
            let Some(definition) = relation_definition else {
                return Err(denied());
            };
            let owned: BTreeSet<_> = roles.iter().collect();
            let declared: BTreeSet<_> = requested.roles.iter().collect();
            let complete: BTreeSet<_> = definition.roles.iter().map(|role| &role.id).collect();
            if owned.len() != roles.len()
                || owned != declared
                || owned != complete
                || claim
                    .roles
                    .iter()
                    .any(|binding| !owned.contains(&binding.role))
            {
                return Err(denied());
            }
            Ok(())
        }
        _ => Err(denied()),
    }
}
