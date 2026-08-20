use super::*;

mod access;
mod audit;
mod command;
mod reader;
mod records;
mod resources;
mod targets;
mod topology;

use reader::Reader;

pub(crate) struct DecodedFacts {
    pub(crate) facts: FleetFacts,
    pub(crate) had_interrupted_delivery: bool,
}

pub(crate) fn decode_facts(content: &[u8], schema: u8) -> Result<DecodedFacts, StoreFault> {
    let mut reader = Reader::new(content);
    let commands = reader.commands()?;
    let dispatches = match schema {
        CURRENT_SCHEMA_VERSION
        | PREVIOUS_SCHEMA_VERSION
        | LEGACY_V11_SCHEMA_VERSION
        | LEGACY_V10_SCHEMA_VERSION
        | OLDEST_SCHEMA_VERSION
        | LEGACY_V6_SCHEMA_VERSION => reader.dispatches()?,
        LEGACY_V5_SCHEMA_VERSION => reader.dispatches_v5()?,
        _ => return Err(StoreFault::UnsupportedSchemaVersion(schema)),
    };
    let had_interrupted_delivery = dispatches
        .iter()
        .any(|record| record.phase() == DispatchPhase::InFlight);
    let references = reader.secret_references()?;
    let audit_entries = reader.audit_entries(schema >= PREVIOUS_SCHEMA_VERSION)?;
    let topology = reader.topology(
        schema != LEGACY_V5_SCHEMA_VERSION,
        schema >= PREVIOUS_SCHEMA_VERSION,
    )?;
    let enrollments = reader.enrollments()?;
    let ingress_credentials = reader.ingress_credentials()?;
    let targets = reader.targets(
        schema >= LEGACY_V10_SCHEMA_VERSION,
        schema >= PREVIOUS_SCHEMA_VERSION,
    )?;
    let bindings = if schema >= PREVIOUS_SCHEMA_VERSION {
        reader.target_bindings()?
    } else {
        Vec::new()
    };
    let (connections, environments, managed_resources, effects, runtime_agents, leases) = if matches!(
        schema,
        CURRENT_SCHEMA_VERSION
            | PREVIOUS_SCHEMA_VERSION
            | LEGACY_V10_SCHEMA_VERSION
            | OLDEST_SCHEMA_VERSION
    ) {
        let connections = reader.connections()?;
        let (environments, resources) = reader.environments(schema >= CURRENT_SCHEMA_VERSION)?;
        let effects = reader.effects()?;
        let runtime_agents = reader.runtime_agents_v7()?;
        let leases = if schema >= PREVIOUS_SCHEMA_VERSION {
            reader.leases()?
        } else {
            Vec::new()
        };
        (
            connections,
            environments,
            resources,
            effects,
            runtime_agents,
            leases,
        )
    } else {
        (
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )
    };
    let runtime_agent_reachability = if schema >= PREVIOUS_SCHEMA_VERSION {
        reader.runtime_agent_reachability()?
    } else {
        Vec::new()
    };
    reader.finish()?;
    let facts = FleetFacts::restore(FleetFactsRestoreInput {
        commands,
        dispatches,
        secret_references: references,
        audit_entries,
        topology,
        enrollments,
        ingress_credentials,
        targets,
        connections,
        environments,
        managed_resources,
        effects,
        runtime_agents,
        runtime_agent_reachability,
        leases,
        bindings,
    })?;
    Ok(DecodedFacts {
        facts,
        had_interrupted_delivery,
    })
}
