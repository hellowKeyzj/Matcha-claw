use std::sync::{Arc, Mutex};

use foundation::{
    execution::OwnedTask,
    lifecycle::{ModuleScope, ScopedEffectKind},
};

#[tokio::test]
async fn typed_registrations_record_metadata_and_return_matching_guards() {
    let mut scope = ModuleScope::new("module-a");

    let route = scope.register_route("route-a", || async {});
    let event_subscription = scope.register_event_subscription("event-a", || async {});
    let process = scope.register_process("process-a", || async {});
    let listener = scope.register_listener("listener-a", || async {});
    let runtime_endpoint = scope.register_runtime_endpoint("runtime-endpoint-a", || async {});
    let callback_server = scope.register_callback_server("callback-server-a", || async {});

    let expected = [
        (ScopedEffectKind::Route, "route", "route-a"),
        (
            ScopedEffectKind::EventSubscription,
            "event-subscription",
            "event-a",
        ),
        (ScopedEffectKind::Process, "process", "process-a"),
        (ScopedEffectKind::Listener, "listener", "listener-a"),
        (
            ScopedEffectKind::RuntimeEndpoint,
            "runtime-endpoint",
            "runtime-endpoint-a",
        ),
        (
            ScopedEffectKind::CallbackServer,
            "callback-server",
            "callback-server-a",
        ),
    ];
    let guards = [
        &route,
        &event_subscription,
        &process,
        &listener,
        &runtime_endpoint,
        &callback_server,
    ];

    assert_eq!(scope.effect_registrations().len(), expected.len());
    for ((expected_kind, expected_label, expected_id), guard) in expected.iter().zip(guards) {
        assert_eq!(guard.scope_id(), "module-a");
        assert_eq!(guard.kind(), *expected_kind);
        assert_eq!(guard.kind().as_str(), *expected_label);
        assert_eq!(guard.effect_id(), *expected_id);
    }
    for (registration, (expected_kind, expected_label, expected_id)) in
        scope.effect_registrations().iter().zip(expected)
    {
        assert_eq!(registration.scope_id(), "module-a");
        assert_eq!(registration.kind(), expected_kind);
        assert_eq!(registration.kind().as_str(), expected_label);
        assert_eq!(registration.effect_id(), expected_id);
    }
}

#[tokio::test]
async fn dispose_all_lifo_runs_each_disposer_once() {
    let mut scope = ModuleScope::new("module-dispose");
    let calls = Arc::new(Mutex::new(Vec::new()));

    let route_calls = Arc::clone(&calls);
    scope.register_route("route", move || async move {
        route_calls.lock().expect("calls lock").push("route");
    });
    let event_calls = Arc::clone(&calls);
    scope.register_event_subscription("event", move || async move {
        event_calls
            .lock()
            .expect("calls lock")
            .push("event-subscription");
    });
    let process_calls = Arc::clone(&calls);
    scope.register_process("process", move || async move {
        process_calls.lock().expect("calls lock").push("process");
    });
    let listener_calls = Arc::clone(&calls);
    scope.register_listener("listener", move || async move {
        listener_calls.lock().expect("calls lock").push("listener");
    });
    let runtime_endpoint_calls = Arc::clone(&calls);
    scope.register_runtime_endpoint("runtime-endpoint", move || async move {
        runtime_endpoint_calls
            .lock()
            .expect("calls lock")
            .push("runtime-endpoint");
    });
    let callback_server_calls = Arc::clone(&calls);
    scope.register_callback_server("callback-server", move || async move {
        callback_server_calls
            .lock()
            .expect("calls lock")
            .push("callback-server");
    });

    scope.dispose_all_lifo().await;
    scope.dispose_all_lifo().await;

    assert_eq!(
        calls.lock().expect("calls lock").as_slice(),
        [
            "callback-server",
            "runtime-endpoint",
            "listener",
            "process",
            "event-subscription",
            "route",
        ]
    );
}

#[tokio::test]
async fn registered_owned_task_is_cancelled_and_joined_on_dispose() {
    let mut scope = ModuleScope::new("module-task");
    let (cleanup_done, wait_cleanup_done) = tokio::sync::oneshot::channel();
    let (task, handle) = OwnedTask::spawn(|cancellation| async move {
        cancellation.cancelled().await;
        let _ = cleanup_done.send(());
        "cancelled"
    });

    let guard = scope.register_owned_task(task);

    assert_eq!(guard.scope_id(), "module-task");
    assert_eq!(guard.kind(), ScopedEffectKind::OwnerTask);
    assert_eq!(guard.effect_id(), "owner-task");
    assert!(!handle.is_cancelled());

    scope.dispose_all_lifo().await;
    scope.dispose_all_lifo().await;

    assert!(handle.is_cancelled());
    wait_cleanup_done
        .await
        .expect("owned task cleanup should complete before dispose returns");
}
