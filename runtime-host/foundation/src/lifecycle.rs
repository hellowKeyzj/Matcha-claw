use std::{future::Future, pin::Pin, sync::Mutex};

use crate::execution::{OwnedTask, TaskHandle};

type DisposeFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type Disposer = Box<dyn FnOnce() -> DisposeFuture + Send>;
type Disposers = Vec<Disposer>;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ScopedEffectKind {
    OwnerTask,
    Route,
    EventSubscription,
    Process,
    Listener,
    RuntimeEndpoint,
    CallbackServer,
}

impl ScopedEffectKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OwnerTask => "owner-task",
            Self::Route => "route",
            Self::EventSubscription => "event-subscription",
            Self::Process => "process",
            Self::Listener => "listener",
            Self::RuntimeEndpoint => "runtime-endpoint",
            Self::CallbackServer => "callback-server",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct EffectRegistration {
    scope_id: &'static str,
    kind: ScopedEffectKind,
    effect_id: &'static str,
}

impl EffectRegistration {
    pub const fn scope_id(&self) -> &'static str {
        self.scope_id
    }

    pub const fn kind(&self) -> ScopedEffectKind {
        self.kind
    }

    pub const fn effect_id(&self) -> &'static str {
        self.effect_id
    }
}

pub struct EffectGuard {
    scope_id: &'static str,
    kind: ScopedEffectKind,
    effect_id: &'static str,
}

impl EffectGuard {
    pub const fn scope_id(&self) -> &'static str {
        self.scope_id
    }

    pub const fn kind(&self) -> ScopedEffectKind {
        self.kind
    }

    pub const fn effect_id(&self) -> &'static str {
        self.effect_id
    }
}

pub struct ModuleScope {
    id: &'static str,
    registrations: Vec<EffectRegistration>,
    owned_tasks: Vec<TaskHandle>,
    disposers: Mutex<Disposers>,
}

impl ModuleScope {
    pub fn new(id: &'static str) -> Self {
        debug_assert!(!id.is_empty());
        Self {
            id,
            registrations: Vec::new(),
            owned_tasks: Vec::new(),
            disposers: Mutex::new(Vec::new()),
        }
    }

    pub const fn id(&self) -> &'static str {
        self.id
    }

    pub fn effect_registrations(&self) -> &[EffectRegistration] {
        &self.registrations
    }

    pub fn cancel_owned_tasks(&self) {
        for task in &self.owned_tasks {
            task.cancel();
        }
    }

    pub fn register_effect_disposer<F, U>(
        &mut self,
        kind: ScopedEffectKind,
        effect_id: &'static str,
        disposer: F,
    ) -> EffectGuard
    where
        F: FnOnce() -> U + Send + 'static,
        U: Future<Output = ()> + Send + 'static,
    {
        debug_assert!(!effect_id.is_empty());
        self.disposers
            .get_mut()
            .expect("module scope disposers mutex poisoned")
            .push(Box::new(move || Box::pin(disposer())));
        self.register_effect(kind, effect_id)
    }

    pub fn register_owned_task<T>(&mut self, mut task: OwnedTask<T>) -> EffectGuard
    where
        T: Send + 'static,
    {
        self.owned_tasks.push(task.handle());
        self.register_effect_disposer(
            ScopedEffectKind::OwnerTask,
            "owner-task",
            move || async move {
                let _ = task.cancel_and_join().await;
            },
        )
    }

    pub fn register_route<F, U>(&mut self, effect_id: &'static str, disposer: F) -> EffectGuard
    where
        F: FnOnce() -> U + Send + 'static,
        U: Future<Output = ()> + Send + 'static,
    {
        self.register_effect_disposer(ScopedEffectKind::Route, effect_id, disposer)
    }

    pub fn register_event_subscription<F, U>(
        &mut self,
        effect_id: &'static str,
        disposer: F,
    ) -> EffectGuard
    where
        F: FnOnce() -> U + Send + 'static,
        U: Future<Output = ()> + Send + 'static,
    {
        self.register_effect_disposer(ScopedEffectKind::EventSubscription, effect_id, disposer)
    }

    pub fn register_process<F, U>(&mut self, effect_id: &'static str, disposer: F) -> EffectGuard
    where
        F: FnOnce() -> U + Send + 'static,
        U: Future<Output = ()> + Send + 'static,
    {
        self.register_effect_disposer(ScopedEffectKind::Process, effect_id, disposer)
    }

    pub fn register_listener<F, U>(&mut self, effect_id: &'static str, disposer: F) -> EffectGuard
    where
        F: FnOnce() -> U + Send + 'static,
        U: Future<Output = ()> + Send + 'static,
    {
        self.register_effect_disposer(ScopedEffectKind::Listener, effect_id, disposer)
    }

    pub fn register_runtime_endpoint<F, U>(
        &mut self,
        effect_id: &'static str,
        disposer: F,
    ) -> EffectGuard
    where
        F: FnOnce() -> U + Send + 'static,
        U: Future<Output = ()> + Send + 'static,
    {
        self.register_effect_disposer(ScopedEffectKind::RuntimeEndpoint, effect_id, disposer)
    }

    pub fn register_callback_server<F, U>(
        &mut self,
        effect_id: &'static str,
        disposer: F,
    ) -> EffectGuard
    where
        F: FnOnce() -> U + Send + 'static,
        U: Future<Output = ()> + Send + 'static,
    {
        self.register_effect_disposer(ScopedEffectKind::CallbackServer, effect_id, disposer)
    }

    pub async fn dispose_all_lifo(&mut self) {
        loop {
            let disposer = self
                .disposers
                .get_mut()
                .expect("module scope disposers mutex poisoned")
                .pop();
            let Some(disposer) = disposer else {
                break;
            };
            disposer().await;
        }
    }

    fn register_effect(&mut self, kind: ScopedEffectKind, effect_id: &'static str) -> EffectGuard {
        self.registrations.push(EffectRegistration {
            scope_id: self.id,
            kind,
            effect_id,
        });
        EffectGuard {
            scope_id: self.id,
            kind,
            effect_id,
        }
    }
}
