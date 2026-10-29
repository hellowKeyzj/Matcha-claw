//! Built-in implementation identities, shared by package authors and native preparation.
use crate::{
    bindings::{Entrypoint, SlotKind},
    ids::{Digest, Revision},
    schema::{self, SchemaFailure},
    sources::ContractRef,
};

#[derive(Clone, Copy)]
pub struct Implementation {
    pub registration: &'static str,
    pub slot: SlotKind,
    pub revision: Revision,
}

impl Implementation {
    pub fn entrypoint(self) -> Entrypoint {
        Entrypoint::Builtin {
            registration: self.registration.into(),
            revision: self.revision,
        }
    }

    pub fn contracts(self) -> Result<Vec<ContractRef>, SchemaFailure> {
        let mut contracts = vec![crate::slots::slot_contract(self.slot)?];
        if self.slot == SlotKind::Connector {
            contracts.push(crate::sources::discover_contract()?);
            if self.registration == crate::sources::POSTGRES_REGISTRATION {
                contracts.push(crate::sources::write_contract()?);
                contracts.push(crate::sources::inspect_contract()?);
            }
        }
        contracts.sort_by(|a, b| (&a.id, &a.version).cmp(&(&b.id, &b.version)));
        Ok(contracts)
    }

    pub fn digest(self) -> Result<Digest, SchemaFailure> {
        let bytes = serde_json::to_vec(&(
            "matcha.world-builtin/1",
            self.registration,
            self.slot,
            self.revision,
            self.contracts()?,
        ))
        .map_err(|_| SchemaFailure)?;
        schema::hash(&bytes)
    }
}

/// Bump only the affected implementation's revision when its behavior changes.
/// Interface identity is independently derived from the actual wire types.
pub fn implementation(registration: &str) -> Option<Implementation> {
    use crate::{identity, slots, sources};
    let (registration, slot, revision) = match registration {
        sources::POSTGRES_REGISTRATION => (sources::POSTGRES_REGISTRATION, SlotKind::Connector, 1),
        sources::HTTP_JSON_REGISTRATION => (sources::HTTP_JSON_REGISTRATION, SlotKind::Connector, 1),
        identity::SOURCE_KEY_REGISTRATION => (identity::SOURCE_KEY_REGISTRATION, SlotKind::Identity, 1),
        slots::SCHEMA_REGISTRATION => (slots::SCHEMA_REGISTRATION, SlotKind::Schema, 1),
        slots::COMPILER_REGISTRATION => (slots::COMPILER_REGISTRATION, SlotKind::Compiler, 1),
        slots::POLICY_REGISTRATION => (slots::POLICY_REGISTRATION, SlotKind::Policy, 1),
        slots::PROVENANCE_REGISTRATION => (slots::PROVENANCE_REGISTRATION, SlotKind::Provenance, 1),
        slots::ACTION_REGISTRATION => (slots::ACTION_REGISTRATION, SlotKind::Action, 1),
        slots::EVALUATION_REGISTRATION => (slots::EVALUATION_REGISTRATION, SlotKind::Evaluation, 1),
        slots::PROJECTION_REGISTRATION => (slots::PROJECTION_REGISTRATION, SlotKind::Projection, 1),
        slots::RECONCILE_REGISTRATION => (slots::RECONCILE_REGISTRATION, SlotKind::Reconcile, 1),
        slots::ABSTRACTION_REGISTRATION => (slots::ABSTRACTION_REGISTRATION, SlotKind::Abstraction, 1),
        slots::AGENT_BRIDGE_REGISTRATION => (slots::AGENT_BRIDGE_REGISTRATION, SlotKind::AgentBridge, 1),
        slots::STORAGE_REGISTRATION => (slots::STORAGE_REGISTRATION, SlotKind::Storage, 1),
        slots::RESOLVER_REGISTRATION => (slots::RESOLVER_REGISTRATION, SlotKind::Resolver, 1),
        slots::CONTEXT_REGISTRATION => (slots::CONTEXT_REGISTRATION, SlotKind::Context, 1),
        _ => return None,
    };
    Some(Implementation { registration, slot, revision: Revision(revision) })
}
