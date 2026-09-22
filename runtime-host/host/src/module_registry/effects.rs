use foundation::lifecycle::{EffectRegistration as ScopedEffectRegistration, ScopedEffectKind};
use platform::module::{EffectKind, EffectRegistration, ModuleId};

pub(crate) fn map_scoped_effects(
    scoped_effects: &[ScopedEffectRegistration],
) -> Vec<EffectRegistration> {
    scoped_effects
        .iter()
        .filter(|registration| registration.kind() != ScopedEffectKind::Route)
        .map(|registration| {
            EffectRegistration::new(
                ModuleId::new(registration.scope_id()),
                map_scoped_effect_kind(registration.kind()),
                registration.effect_id(),
            )
        })
        .collect()
}

fn map_scoped_effect_kind(kind: ScopedEffectKind) -> EffectKind {
    match kind {
        ScopedEffectKind::OwnerTask => EffectKind::OwnerTask,
        ScopedEffectKind::Route => EffectKind::Route,
        ScopedEffectKind::EventSubscription => EffectKind::EventSubscription,
        ScopedEffectKind::Process => EffectKind::Process,
        ScopedEffectKind::Listener => EffectKind::Listener,
        ScopedEffectKind::RuntimeEndpoint => EffectKind::RuntimeEndpoint,
        ScopedEffectKind::CallbackServer => EffectKind::CallbackServer,
    }
}
