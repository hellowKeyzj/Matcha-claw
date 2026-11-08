use crate::protocol::{MAX_FRAME, MAX_REQUEST, Output, bounded_object};
use async_trait::async_trait;
use bytes::Bytes;
use easytier::proto::{
    rpc_impl::RpcController,
    rpc_types::{
        __rt::RpcClientFactory,
        descriptor::{MethodDescriptor, ServiceDescriptor},
        error::{Error, Result},
        handler::{Handler, HandlerExt},
    },
};
use serde_json::Value;
use std::{
    any::TypeId,
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Semaphore, oneshot};

pub const DOMAIN: &str = "matcha.resource.v1";

#[derive(Clone, Copy, Debug)]
pub struct Invoke;

impl TryFrom<u8> for Invoke {
    type Error = ();
    fn try_from(index: u8) -> std::result::Result<Self, ()> {
        if index == 0 { Ok(Self) } else { Err(()) }
    }
}

impl MethodDescriptor for Invoke {
    fn name(&self) -> &'static str {
        "invoke"
    }
    fn proto_name(&self) -> &'static str {
        "Invoke"
    }
    fn input_type(&self) -> TypeId {
        TypeId::of::<Bytes>()
    }
    fn input_proto_type(&self) -> &'static str {
        "bytes"
    }
    fn output_type(&self) -> TypeId {
        TypeId::of::<Bytes>()
    }
    fn output_proto_type(&self) -> &'static str {
        "bytes"
    }
    fn index(&self) -> u8 {
        0
    }
}

#[derive(Clone, Debug, Default)]
pub struct Descriptor;

impl ServiceDescriptor for Descriptor {
    type Method = Invoke;
    fn name(&self) -> &'static str {
        "MatchaResource"
    }
    fn proto_name(&self) -> &'static str {
        "MatchaResource"
    }
    fn methods(&self) -> &'static [Invoke] {
        &[Invoke]
    }
}

#[derive(Clone)]
pub struct Factory;

impl RpcClientFactory for Factory {
    type Descriptor = Descriptor;
    type Controller = RpcController;
    type ClientImpl = Arc<dyn HandlerExt<Controller = RpcController>>;
    fn new(
        handler: impl Handler<Descriptor = Descriptor, Controller = RpcController>,
    ) -> Self::ClientImpl {
        Arc::new(handler)
    }
}

pub struct Bridge {
    output: Output,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    capacity: Semaphore,
}

impl Bridge {
    pub fn new(output: Output) -> Arc<Self> {
        Arc::new(Self {
            output,
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            capacity: Semaphore::new(64),
        })
    }

    pub fn reply(&self, id: u64, response: Value) -> bool {
        if !bounded_object(&response, MAX_FRAME) {
            return false;
        }
        self.pending
            .lock()
            .unwrap()
            .remove(&id)
            .is_some_and(|sender| sender.send(response).is_ok())
    }
}

struct Pending<'a> {
    bridge: &'a Bridge,
    id: u64,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.bridge.pending.lock().unwrap().remove(&self.id);
    }
}

#[derive(Clone)]
pub struct ResourceHandler(pub Arc<Bridge>);

#[async_trait]
impl Handler for ResourceHandler {
    type Descriptor = Descriptor;
    type Controller = RpcController;

    async fn call(&self, _ctrl: RpcController, _method: Invoke, input: Bytes) -> Result<Bytes> {
        if input.len() > MAX_REQUEST {
            return Err(Error::MalformatRpcPacket("invalid-request".into()));
        }
        let request: Value = serde_json::from_slice(&input)
            .map_err(|_| Error::MalformatRpcPacket("invalid-request".into()))?;
        if !request.is_object() {
            return Err(Error::MalformatRpcPacket("invalid-request".into()));
        }
        let _permit = self.0.capacity.try_acquire().map_err(|_| Error::Shutdown)?;
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.0.pending.lock().unwrap().insert(id, sender);
        let _pending = Pending {
            bridge: &self.0,
            id,
        };
        let response = tokio::time::timeout(Duration::from_secs(8), async {
            self.0
                .output
                .send(serde_json::json!({ "kind": "incoming", "id": id, "request": request }))
                .await
                .map_err(|_| Error::Shutdown)?;
            receiver.await.map_err(|_| Error::Shutdown)
        })
        .await??;
        let bytes = serde_json::to_vec(&response)
            .map_err(|_| Error::MalformatRpcPacket("invalid-request".into()))?;
        if bytes.len() > MAX_FRAME {
            return Err(Error::MalformatRpcPacket("invalid-request".into()));
        }
        Ok(bytes.into())
    }
}
