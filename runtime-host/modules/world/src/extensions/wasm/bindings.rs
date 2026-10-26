pub(super) mod projection {
    wasm_host::wasmtime::component::bindgen!({
        path: "protocol/wit",
        world: "projection-plugin",
        imports: { default: async | trappable },
        exports: { default: async },
        wasmtime_crate: wasm_host::wasmtime,
    });
}

// One generated ordinary-import/type surface, reused by every exact export world.
macro_rules! slot {
    ($module:ident, $world:literal) => {
        pub(super) mod $module {
            wasm_host::wasmtime::component::bindgen!({
                path: "protocol/wit",
                world: $world,
                imports: { default: async | trappable },
                exports: { default: async },
                with: {
                    "matcha:world/types@1.0.0": super::projection::matcha::world::types,
                    "matcha:world/source@1.0.0": super::projection::matcha::world::source,
                    "matcha:world/world-read@1.0.0": super::projection::matcha::world::world_read,
                    "matcha:world/model@1.0.0": super::projection::matcha::world::model,
                    "matcha:world/state@1.0.0": super::projection::matcha::world::state,
                    "matcha:world/clock@1.0.0": super::projection::matcha::world::clock,
                    "matcha:world/logging@1.0.0": super::projection::matcha::world::logging,
                    "matcha:world/config@1.0.0": super::projection::matcha::world::config,
                },
                wasmtime_crate: wasm_host::wasmtime,
            });
        }
    };
}
slot!(connector, "connector-plugin");
slot!(identity, "identity-plugin");
slot!(schema, "schema-plugin");
slot!(resolver, "resolver-plugin");
slot!(provenance, "provenance-plugin");
slot!(compiler, "compiler-plugin");
slot!(policy, "policy-plugin");
slot!(action, "action-plugin");
slot!(reconcile, "reconcile-plugin");
slot!(abstraction, "abstraction-plugin");
slot!(evaluation, "evaluation-plugin");
slot!(context, "context-plugin");
slot!(agent_bridge, "agent-bridge-plugin");
slot!(storage, "storage-plugin");

pub(super) mod state_migration {
    wasm_host::wasmtime::component::bindgen!({
        path: "protocol/wit",
        world: "state-migration-plugin",
        exports: { default: async },
        with: { "matcha:world/types@1.0.0": super::projection::matcha::world::types },
        wasmtime_crate: wasm_host::wasmtime,
    });
}

pub(super) use projection::matcha::world::{
    clock, config, logging, model, source, state, types, world_read,
};
