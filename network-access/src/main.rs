mod network;
mod protocol;
mod rpc;

use protocol::{Command, MAX_FRAME, MAX_REQUEST, bounded_object, failure};
use serde_json::json;
use std::{collections::HashSet, sync::Arc};
use tokio::{
    sync::{Semaphore, mpsc},
    task::JoinSet,
};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    std::panic::set_hook(Box::new(|_| eprintln!("matcha-network: internal failure")));
    let output = protocol::output();
    let (commands, mut input) = mpsc::channel(64);
    tokio::spawn(protocol::read_commands(commands));
    let bridge = rpc::Bridge::new(output.clone());
    let Some(Ok(Command::Start { id, configuration })) = input.recv().await else {
        std::process::exit(1);
    };

    let mut starting = Box::pin(network::Network::start(&configuration, bridge.clone()));
    let network = loop {
        tokio::select! {
            result = &mut starting => {
                match result {
                    Ok(network) => break network,
                    Err(()) => {
                        let _ = output.send(failure(id, "unavailable")).await;
                        std::process::exit(1);
                    }
                }
            }
            command = input.recv() => {
                match command {
                    None | Some(Ok(Command::Stop { .. })) => std::process::exit(0),
                    Some(Ok(Command::Reply { id, response })) => {
                        bridge.reply(id, response);
                    }
                    Some(Ok(Command::Read { id } | Command::Start { id, .. } | Command::Invoke { id, .. }))
                    | Some(Err(Some(id))) => { let _ = output.send(failure(id, "invalid-request")).await; }
                    Some(Err(None)) => std::process::exit(1),
                }
            }
        }
    };
    drop(starting);
    drop(configuration);
    let _ = output
        .send(json!({ "kind": "ready", "id": id, "runtime": network.runtime().await }))
        .await;
    let permits = Arc::new(Semaphore::new(64));
    let mut tasks = JoinSet::new();
    let mut active = HashSet::new();
    loop {
        tokio::select! {
            completion = tasks.join_next(), if !tasks.is_empty() => {
                if let Some(Ok(id)) = completion {
                    active.remove(&id);
                }
            }
            command = input.recv() => {
                match command {
                    None | Some(Ok(Command::Stop { .. })) => std::process::exit(0),
                    Some(Ok(Command::Read { id })) => {
                        let _ = output.send(json!({ "kind": "runtime", "id": id, "runtime": network.runtime().await })).await;
                    }
                    Some(Ok(Command::Invoke { id, node_id, request })) => {
                        if active.contains(&id) || !bounded_object(&request, MAX_REQUEST) {
                            let _ = output.send(failure(id, "invalid-request")).await;
                            continue;
                        }
                        let Ok(permit) = permits.clone().try_acquire_owned() else {
                            let _ = output.send(failure(id, "unavailable")).await;
                            continue;
                        };
                        let manager = network.instance.get_peer_manager();
                        let output = output.clone();
                        let bytes = serde_json::to_vec(&request).unwrap();
                        active.insert(id);
                        tasks.spawn(async move {
                            let _permit = permit;
                            let event = match network::invoke(manager, node_id, bytes).await {
                                Ok(response) => {
                                    let event = json!({ "kind": "result", "id": id, "response": response });
                                    if serde_json::to_vec(&event).is_ok_and(|bytes| bytes.len() <= MAX_FRAME) {
                                        event
                                    } else { failure(id, "outcome-unknown") }
                                }
                                Err(error) => failure(id, error),
                            };
                            let _ = output.send(event).await;
                            id
                        });
                    }
                    Some(Ok(Command::Reply { id, response })) => {
                        bridge.reply(id, response);
                    }
                    Some(Ok(Command::Start { id, .. })) | Some(Err(Some(id))) => {
                        let _ = output.send(failure(id, "invalid-request")).await;
                    }
                    Some(Err(None)) => std::process::exit(1),
                }
            }
        }
    }
}
