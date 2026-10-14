use std::{
    any::Any,
    collections::{HashMap, VecDeque, hash_map::DefaultHasher},
    fmt,
    future::Future,
    hash::{Hash, Hasher},
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use futures_util::{FutureExt, StreamExt, stream::FuturesUnordered};
use tokio::{
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, TryAcquireError, mpsc},
    task::JoinSet,
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use super::{
    ObservationRecord, ObservationSink, OwnedTask, OwnerRuntimeItem, OwnerRuntimeObservation,
    OwnerRuntimeReason, OwnerRuntimeRoute, OwnerRuntimeStage, TraceContext,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaneRetention {
    HighFrequency,
    MediumFrequency,
    LowFrequency,
    Immediate,
    Custom(Duration),
}

impl LaneRetention {
    pub fn as_duration(self) -> Duration {
        match self {
            Self::HighFrequency => Duration::from_secs(300),
            Self::MediumFrequency => Duration::from_secs(60),
            Self::LowFrequency => Duration::from_secs(30),
            Self::Immediate => Duration::ZERO,
            Self::Custom(duration) => duration,
        }
    }
}

impl Default for LaneRetention {
    fn default() -> Self {
        Self::MediumFrequency
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandRoute<K> {
    Keyed(K),
    KeyedControl(K),
    Global,
    Exclusive,
    Shutdown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QueryRoute<K> {
    Direct,
    Keyed(K),
    Global,
    Exclusive,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct OwnerRuntimeId(u64);

impl OwnerRuntimeId {
    pub const fn as_u64(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OwnerRuntimeConfig {
    pub mailbox_capacity: usize,
    pub lane_queue_capacity: usize,
    pub global_queue_capacity: usize,
    pub ready_queue_capacity: usize,
    pub worker_count: usize,
    pub lane_retention: LaneRetention,
}

impl OwnerRuntimeConfig {
    pub fn new(mailbox_capacity: usize, lane_retention: LaneRetention) -> Self {
        Self {
            mailbox_capacity,
            lane_retention,
            ..Self::default()
        }
    }

    fn normalized(self) -> Self {
        Self {
            mailbox_capacity: self.mailbox_capacity.max(1),
            lane_queue_capacity: self.lane_queue_capacity.max(1),
            global_queue_capacity: self.global_queue_capacity.max(1),
            ready_queue_capacity: self.ready_queue_capacity.max(1),
            worker_count: self.worker_count.max(1),
            lane_retention: self.lane_retention,
        }
    }
}

impl Default for OwnerRuntimeConfig {
    fn default() -> Self {
        let worker_count = std::thread::available_parallelism()
            .map(|count| count.get().saturating_sub(2).max(1))
            .unwrap_or(2);
        Self {
            mailbox_capacity: 64,
            lane_queue_capacity: 64,
            global_queue_capacity: 64,
            ready_queue_capacity: worker_count * 2,
            worker_count,
            lane_retention: LaneRetention::default(),
        }
    }
}

pub trait OwnerSpec: Send + Sized + 'static {
    const PENDING_LIFECYCLE: bool = false;

    type Command: Send + 'static;
    type Query: Send + 'static;
    type Key: Eq + Hash + Clone + Send + 'static;
    type Shared: Clone + Send + Sync + 'static;
    type GlobalState: Send + 'static;
    type LaneState: Send + 'static;

    fn split(self) -> (Self::Shared, Self::GlobalState);

    fn route_command(command: &Self::Command) -> CommandRoute<Self::Key>;

    fn route_query(query: &Self::Query) -> QueryRoute<Self::Key>;

    fn open_lane(shared: &Self::Shared, key: &Self::Key) -> Self::LaneState;

    fn keyed_command_ready(
        _shared: &Self::Shared,
        _key: &Self::Key,
        _lane: &Self::LaneState,
        _command: &Self::Command,
    ) -> bool {
        true
    }

    fn lane_has_pending(
        _shared: &Self::Shared,
        _key: &Self::Key,
        _lane: &Self::LaneState,
    ) -> bool {
        false
    }

    fn handle_keyed_command(
        shared: Self::Shared,
        key: Self::Key,
        lane: &mut Self::LaneState,
        command: Self::Command,
    ) -> impl Future<Output = ()> + Send;

    fn handle_global_command(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        command: Self::Command,
    ) -> impl Future<Output = ()> + Send;

    fn handle_direct_query(
        shared: Self::Shared,
        query: Self::Query,
    ) -> impl Future<Output = ()> + Send;

    fn handle_keyed_query(
        shared: Self::Shared,
        key: Self::Key,
        lane: &mut Self::LaneState,
        query: Self::Query,
    ) -> impl Future<Output = ()> + Send;

    fn handle_global_query(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) -> impl Future<Output = ()> + Send;

    fn handle_exclusive_query(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) -> impl Future<Output = ()> + Send;

    fn shutdown(
        _shared: Self::Shared,
        _global: &mut Self::GlobalState,
        _lanes: Vec<(Self::Key, Self::LaneState)>,
    ) -> impl Future<Output = ()> + Send {
        async {}
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OwnerRoute<K> {
    Direct,
    Keyed(K),
    KeyedControl(K),
    Global,
    Exclusive,
    Shutdown,
}

pub trait OwnerRuntime: Send + Sized + 'static {
    type Command: Send + 'static;
    type Key: Eq + Hash + Clone + Send + 'static;
    type Shared: Clone + Send + Sync + 'static;
    type GlobalState: Send + 'static;
    type LaneState: Send + 'static;

    fn split(self) -> (Self::Shared, Self::GlobalState);

    fn route(command: &Self::Command) -> OwnerRoute<Self::Key>;

    fn open_lane(shared: &Self::Shared, key: &Self::Key) -> Self::LaneState;

    fn handle_direct(
        shared: Self::Shared,
        command: Self::Command,
        cancellation: CancellationToken,
    ) -> impl Future<Output = ()> + Send;

    fn handle_keyed(
        shared: Self::Shared,
        key: Self::Key,
        state: &mut Self::LaneState,
        command: Self::Command,
        cancellation: CancellationToken,
    ) -> impl Future<Output = ()> + Send;

    fn handle_keyed_control(
        shared: Self::Shared,
        key: Self::Key,
        command: Self::Command,
    ) -> impl Future<Output = ()> + Send;

    fn handle_global(
        shared: Self::Shared,
        state: &mut Self::GlobalState,
        command: Self::Command,
        cancellation: CancellationToken,
    ) -> impl Future<Output = ()> + Send;

    fn handle_exclusive(
        shared: Self::Shared,
        state: &mut Self::GlobalState,
        command: Self::Command,
        cancellation: CancellationToken,
    ) -> impl Future<Output = ()> + Send;

    fn shutdown(
        shared: Self::Shared,
        state: &mut Self::GlobalState,
        lanes: Vec<(Self::Key, Self::LaneState)>,
    ) -> impl Future<Output = ()> + Send;
}

pub fn spawn_owner_runtime<O>(
    owner: O,
    capacity: usize,
    idle_timeout: LaneRetention,
) -> (OwnerRuntimeHandle<O::Command>, OwnedTask<()>)
where
    O: OwnerRuntime,
{
    let adapter = LegacyOwnerRuntime(owner);
    let mut system = OwnerRuntimeSystem::spawn(OwnerRuntimeConfig::new(capacity, idle_timeout));
    let (handle, mut owner_task) =
        system.spawn_owner(adapter, OwnerRuntimeConfig::new(capacity, idle_timeout));
    let (task, _handle) = OwnedTask::spawn(|cancellation| async move {
        tokio::select! {
            _ = cancellation.cancelled() => {
                owner_task.cancel();
                let _ = owner_task.join().await;
                let _ = system.cancel_and_join().await;
            }
            result = &mut owner_task => {
                let _ = result;
                let _ = system.cancel_and_join().await;
            }
        }
    });
    (handle, task)
}

struct LegacyOwnerRuntime<O>(O);

impl<O> OwnerSpec for LegacyOwnerRuntime<O>
where
    O: OwnerRuntime,
{
    type Command = O::Command;
    type Query = std::convert::Infallible;
    type Key = O::Key;
    type Shared = O::Shared;
    type GlobalState = O::GlobalState;
    type LaneState = O::LaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        self.0.split()
    }

    fn route_command(command: &Self::Command) -> CommandRoute<Self::Key> {
        match O::route(command) {
            OwnerRoute::Direct => CommandRoute::Global,
            OwnerRoute::Keyed(key) | OwnerRoute::KeyedControl(key) => CommandRoute::Keyed(key),
            OwnerRoute::Global => CommandRoute::Global,
            OwnerRoute::Exclusive => CommandRoute::Exclusive,
            OwnerRoute::Shutdown => CommandRoute::Shutdown,
        }
    }

    fn route_query(query: &Self::Query) -> QueryRoute<Self::Key> {
        match *query {}
    }

    fn open_lane(shared: &Self::Shared, key: &Self::Key) -> Self::LaneState {
        O::open_lane(shared, key)
    }

    async fn handle_keyed_command(
        shared: Self::Shared,
        key: Self::Key,
        lane: &mut Self::LaneState,
        command: Self::Command,
    ) {
        match O::route(&command) {
            OwnerRoute::KeyedControl(_) => O::handle_keyed_control(shared, key, command).await,
            _ => O::handle_keyed(shared, key, lane, command, CancellationToken::new()).await,
        }
    }

    async fn handle_global_command(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        match O::route(&command) {
            OwnerRoute::Direct => O::handle_direct(shared, command, CancellationToken::new()).await,
            OwnerRoute::Exclusive => {
                O::handle_exclusive(shared, global, command, CancellationToken::new()).await;
            }
            _ => O::handle_global(shared, global, command, CancellationToken::new()).await,
        }
    }

    async fn handle_direct_query(_shared: Self::Shared, query: Self::Query) {
        match query {}
    }

    fn handle_keyed_query(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        query: Self::Query,
    ) -> impl Future<Output = ()> + Send {
        async move { match query {} }
    }

    fn handle_global_query(
        _shared: Self::Shared,
        _global: &mut Self::GlobalState,
        query: Self::Query,
    ) -> impl Future<Output = ()> + Send {
        async move { match query {} }
    }

    fn handle_exclusive_query(
        _shared: Self::Shared,
        _global: &mut Self::GlobalState,
        query: Self::Query,
    ) -> impl Future<Output = ()> + Send {
        async move { match query {} }
    }

    async fn shutdown(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        lanes: Vec<(Self::Key, Self::LaneState)>,
    ) {
        O::shutdown(shared, global, lanes).await;
    }
}

pub struct OwnerRuntimeSystem {
    next_owner_id: Arc<AtomicU64>,
    ready_tx: Option<mpsc::Sender<Runnable>>,
    drain: CancellationToken,
    cancellation: CancellationToken,
    observation: ObservationSink,
    workers: OwnedTask<Result<(), tokio::task::JoinError>>,
}

impl OwnerRuntimeSystem {
    pub fn spawn(config: OwnerRuntimeConfig) -> Self {
        Self::spawn_observed(config, ObservationSink::disabled())
    }

    pub fn spawn_observed(config: OwnerRuntimeConfig, observation: ObservationSink) -> Self {
        let config = config.normalized();
        let (ready_tx, ready_rx) = mpsc::channel(config.ready_queue_capacity);
        let ready_rx = Arc::new(Mutex::new(ready_rx));
        let cancellation = CancellationToken::new();
        let worker_cancellation = cancellation.clone();
        let (workers, _handle) = OwnedTask::spawn(move |cancellation| async move {
            let mut worker_tasks = JoinSet::new();
            for _ in 0..config.worker_count {
                worker_tasks.spawn(worker_loop(
                    Arc::clone(&ready_rx),
                    worker_cancellation.clone(),
                ));
            }
            let mut failure = None;
            let mut cancelling = false;
            loop {
                tokio::select! {
                    _ = cancellation.cancelled(), if !cancelling => {
                        cancelling = true;
                        worker_cancellation.cancel();
                    }
                    result = worker_tasks.join_next() => {
                        match result {
                            Some(Err(error)) => {
                                failure.get_or_insert(error);
                                worker_cancellation.cancel();
                            }
                            Some(Ok(())) => {}
                            None => break,
                        }
                    }
                }
            }
            failure.map_or(Ok(()), Err)
        });
        Self {
            next_owner_id: Arc::new(AtomicU64::new(1)),
            ready_tx: Some(ready_tx),
            drain: CancellationToken::new(),
            cancellation,
            observation,
            workers,
        }
    }

    pub fn spawn_owner<O>(
        &self,
        owner: O,
        config: OwnerRuntimeConfig,
    ) -> (OwnerRuntimeHandle<O::Command, O::Query>, OwnedTask<()>)
    where
        O: OwnerSpec,
    {
        let config = config.normalized();
        let id = OwnerRuntimeId(self.next_owner_id.fetch_add(1, Ordering::Relaxed));
        let (mailbox_tx, mailbox_rx) = mpsc::channel(config.mailbox_capacity);
        // Bound all resident work without turning Direct or distinct keyed lanes into one lane.
        let admission = Arc::new(Semaphore::new(
            config.mailbox_capacity
                .saturating_add(config.lane_queue_capacity)
                .saturating_add(config.global_queue_capacity)
                .saturating_add(config.ready_queue_capacity)
                .saturating_add(config.worker_count)
                .min(Semaphore::MAX_PERMITS),
        ));
        // Keyed/global backlog must not consume the capacity needed by Direct queries.
        let direct_admission = Arc::new(Semaphore::new(
            config.mailbox_capacity
                .saturating_add(config.ready_queue_capacity)
                .saturating_add(config.worker_count)
                .min(Semaphore::MAX_PERMITS),
        ));
        let query_route_failure = Arc::new(QueryRouteFailure::new());
        let (completion_tx, completion_rx) = mpsc::unbounded_channel();
        let (shared, global_state) = owner.split();
        let slot = OwnerRuntimeSlot::<O>::new(
            id,
            shared,
            global_state,
            config,
            self.ready_tx
                .as_ref()
                .expect("owner runtime system is draining")
                .clone(),
            self.observation.clone(),
            completion_tx,
            completion_rx,
            Arc::clone(&admission),
            Arc::clone(&direct_admission),
            Arc::clone(&query_route_failure),
            self.cancellation.clone(),
        );
        observe_owner_runtime::<O>(
            &self.observation,
            id,
            OwnerRuntimeStage::Spawn,
            OwnerRuntimeItem::Command,
            OwnerRuntimeRoute::Global,
            None,
            None,
            None,
        );
        let drain = self.drain.child_token();
        let slot_drain = drain.clone();
        let (mut task, _handle) = OwnedTask::spawn(|cancellation| async move {
            slot.run(mailbox_rx, cancellation, slot_drain).await;
        });
        task.set_drain(drain.clone());
        (
            OwnerRuntimeHandle {
                id,
                drain,
                cancellation: self.cancellation.clone(),
                admission,
                direct_admission,
                classify_command: |command| O::PENDING_LIFECYCLE && matches!(O::route_command(command), CommandRoute::KeyedControl(_)),
                classify_query: |query| {
                    let route = O::route_query(query);
                    ClassifiedQueryRoute {
                        direct: matches!(&route, QueryRoute::Direct),
                        route: Box::new(route),
                    }
                },
                query_route_failure,
                mailbox: mailbox_tx,
            },
            task,
        )
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
        self.workers.cancel();
    }

    pub fn is_finished(&self) -> bool {
        self.workers.is_finished()
    }

    /// Drain upstream owners first when their handlers call other owner mailboxes.
    pub async fn drain_and_join(&mut self) -> Result<(), tokio::task::JoinError> {
        self.drain.cancel();
        self.ready_tx.take();
        // Each slot retains a ready sender until its handlers and shutdown hook finish.
        self.workers.join().await?
    }

    pub async fn cancel_and_join(&mut self) -> Result<(), tokio::task::JoinError> {
        self.cancel();
        self.workers.join().await?
    }
}

pub struct OwnerRuntimeHandle<Command, Query = std::convert::Infallible> {
    id: OwnerRuntimeId,
    drain: CancellationToken,
    cancellation: CancellationToken,
    admission: Arc<Semaphore>,
    direct_admission: Arc<Semaphore>,
    classify_command: fn(&Command) -> bool,
    classify_query: fn(&Query) -> ClassifiedQueryRoute,
    query_route_failure: Arc<QueryRouteFailure>,
    mailbox: mpsc::Sender<Admitted<Mailbox<Command, Query>>>,
}

pub struct OwnerRuntimePermit<Command, Query = std::convert::Infallible> {
    drain: CancellationToken,
    cancellation: CancellationToken,
    admission: Arc<Semaphore>,
    mailbox: mpsc::OwnedPermit<Admitted<Mailbox<Command, Query>>>,
    permit: OwnedSemaphorePermit,
    control: bool,
    classify_command: fn(&Command) -> bool,
}

impl<Command, Query> OwnerRuntimePermit<Command, Query> {
    pub fn send(self, command: Command) -> Result<(), SendError> {
        if (self.drain.is_cancelled() && !self.control)
            || self.cancellation.is_cancelled()
            || self.admission.is_closed()
            || (self.control && !(self.classify_command)(&command))
        {
            return Err(SendError::Closed);
        }
        self.mailbox.send(Admitted {
            item: Mailbox::Command { command, control: self.control },
            permit: self.permit,
        });
        Ok(())
    }
}

impl<Command, Query> Clone for OwnerRuntimeHandle<Command, Query> {
    fn clone(&self) -> Self {
        Self {
            id: self.id,
            drain: self.drain.clone(),
            cancellation: self.cancellation.clone(),
            admission: Arc::clone(&self.admission),
            direct_admission: Arc::clone(&self.direct_admission),
            classify_command: self.classify_command,
            classify_query: self.classify_query,
            query_route_failure: Arc::clone(&self.query_route_failure),
            mailbox: self.mailbox.clone(),
        }
    }
}

impl<Command, Query> OwnerRuntimeHandle<Command, Query> {
    pub fn id(&self) -> OwnerRuntimeId {
        self.id
    }

    pub async fn reserve(&self) -> Result<OwnerRuntimePermit<Command, Query>, SendError> {
        self.reserve_command(false).await
    }

    pub async fn reserve_control(&self) -> Result<OwnerRuntimePermit<Command, Query>, SendError> {
        self.reserve_command(true).await
    }

    async fn reserve_command(&self, control: bool) -> Result<OwnerRuntimePermit<Command, Query>, SendError> {
        let admission = if control { &self.direct_admission } else { &self.admission };
        tokio::select! {
            biased;
            _ = self.drain.cancelled(), if !control => Err(SendError::Closed),
            _ = self.cancellation.cancelled() => Err(SendError::Closed),
            result = async {
                let permit = Arc::clone(admission)
                    .acquire_owned()
                    .await
                    .map_err(|_| SendError::Closed)?;
                let mailbox = self.mailbox.clone()
                    .reserve_owned()
                    .await
                    .map_err(|_| SendError::Closed)?;
                Ok(OwnerRuntimePermit {
                    drain: self.drain.clone(),
                    cancellation: self.cancellation.clone(),
                    admission: Arc::clone(admission),
                    mailbox,
                    permit,
                    control,
                    classify_command: self.classify_command,
                })
            } => result,
        }
    }

    pub fn try_reserve(&self) -> Result<OwnerRuntimePermit<Command, Query>, SendError> {
        if self.is_closed() {
            return Err(SendError::Closed);
        }
        let permit = Arc::clone(&self.admission)
            .try_acquire_owned()
            .map_err(|error| match error {
                TryAcquireError::NoPermits => SendError::Full,
                TryAcquireError::Closed => SendError::Closed,
            })?;
        let mailbox = self.mailbox.clone()
            .try_reserve_owned()
            .map_err(map_try_send_error)?;
        Ok(OwnerRuntimePermit {
            drain: self.drain.clone(),
            cancellation: self.cancellation.clone(),
            admission: Arc::clone(&self.admission),
            mailbox,
            permit,
            control: false,
            classify_command: self.classify_command,
        })
    }

    pub async fn command(&self, command: Command) -> Result<(), SendError> {
        self.send_command(command).await
    }

    pub async fn send(&self, command: Command) -> Result<(), SendError> {
        self.send_command(command).await
    }

    pub async fn send_command(&self, command: Command) -> Result<(), SendError> {
        let control = self.classify_command_route(&command)?;
        self.send_message(Mailbox::Command { command, control }).await
    }

    pub fn try_command(&self, command: Command) -> Result<(), SendError> {
        self.try_send_command(command)
    }

    pub fn try_send(&self, command: Command) -> Result<(), SendError> {
        self.try_send_command(command)
    }

    pub fn try_send_command(&self, command: Command) -> Result<(), SendError> {
        let control = self.classify_command_route(&command)?;
        self.try_send_message(Mailbox::Command { command, control })
    }

    pub async fn query(&self, query: Query) -> Result<(), SendError> {
        self.send_query(query).await
    }

    pub async fn send_query(&self, query: Query) -> Result<(), SendError> {
        let route = self.classify_query_route(&query)?;
        self.send_message(Mailbox::Query { query, route }).await
    }

    pub fn try_query(&self, query: Query) -> Result<(), SendError> {
        self.try_send_query(query)
    }

    pub fn try_send_query(&self, query: Query) -> Result<(), SendError> {
        let route = self.classify_query_route(&query)?;
        self.try_send_message(Mailbox::Query { query, route })
    }

    fn classify_command_route(&self, command: &Command) -> Result<bool, SendError> {
        let mut failure = self.query_route_failure.panic.lock()
            .expect("query route failure lock poisoned");
        if self.is_stopped() {
            return Err(SendError::Closed);
        }
        match std::panic::catch_unwind(AssertUnwindSafe(|| (self.classify_command)(command))) {
            Ok(control) => Ok(control),
            Err(panic) => {
                self.admission.close();
                self.direct_admission.close();
                *failure = Some(panic);
                drop(failure);
                self.query_route_failure.cancellation.cancel();
                Err(SendError::Closed)
            }
        }
    }

    fn classify_query_route(&self, query: &Query) -> Result<ClassifiedQueryRoute, SendError> {
        let mut failure = self.query_route_failure.panic.lock()
            .expect("query route failure lock poisoned");
        if self.is_closed() {
            return Err(SendError::Closed);
        }
        match std::panic::catch_unwind(AssertUnwindSafe(|| (self.classify_query)(query))) {
            Ok(route) => Ok(route),
            Err(panic) => {
                self.admission.close();
                self.direct_admission.close();
                *failure = Some(panic);
                drop(failure);
                self.query_route_failure.cancellation.cancel();
                Err(SendError::Closed)
            }
        }
    }

    fn message_admission(&self, message: &Mailbox<Command, Query>) -> Arc<Semaphore> {
        match message {
            Mailbox::Command { control: true, .. } => Arc::clone(&self.direct_admission),
            Mailbox::Query { route, .. } if route.direct => Arc::clone(&self.direct_admission),
            _ => Arc::clone(&self.admission),
        }
    }

    async fn send_message(&self, message: Mailbox<Command, Query>) -> Result<(), SendError> {
        let control = matches!(&message, Mailbox::Command { control: true, .. });
        if self.is_stopped() || (self.drain.is_cancelled() && !control) {
            return Err(SendError::Closed);
        }
        let admission = self.message_admission(&message);
        tokio::select! {
            biased;
            _ = self.drain.cancelled(), if !control => Err(SendError::Closed),
            _ = self.cancellation.cancelled() => Err(SendError::Closed),
            result = async {
                let permit = admission
                    .acquire_owned()
                    .await
                    .map_err(|_| SendError::Closed)?;
                self.mailbox
                    .send(Admitted { item: message, permit })
                    .await
                    .map_err(|_| SendError::Closed)
            } => result,
        }
    }

    fn try_send_message(&self, message: Mailbox<Command, Query>) -> Result<(), SendError> {
        let control = matches!(&message, Mailbox::Command { control: true, .. });
        if self.is_stopped() || (self.drain.is_cancelled() && !control) {
            return Err(SendError::Closed);
        }
        let permit = self.message_admission(&message)
            .try_acquire_owned()
            .map_err(|error| match error {
                TryAcquireError::NoPermits => SendError::Full,
                TryAcquireError::Closed => SendError::Closed,
            })?;
        self.mailbox
            .try_send(Admitted { item: message, permit })
            .map_err(map_try_send_error)
    }

    pub fn is_closed(&self) -> bool {
        self.drain.is_cancelled() || self.is_stopped()
    }

    fn is_stopped(&self) -> bool {
        self.cancellation.is_cancelled()
            || self.admission.is_closed()
            || self.direct_admission.is_closed()
            || self.mailbox.is_closed()
    }
}

fn map_try_send_error<T>(error: mpsc::error::TrySendError<T>) -> SendError {
    match error {
        mpsc::error::TrySendError::Full(_) => SendError::Full,
        mpsc::error::TrySendError::Closed(_) => SendError::Closed,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SendError {
    Full,
    Closed,
}

impl fmt::Display for SendError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Full => formatter.write_str("owner runtime mailbox full"),
            Self::Closed => formatter.write_str("owner runtime closed"),
        }
    }
}

impl std::error::Error for SendError {}

type RuntimeWork = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

struct Runnable {
    work: RuntimeWork,
}

async fn worker_loop(
    ready_rx: Arc<Mutex<mpsc::Receiver<Runnable>>>,
    cancellation: CancellationToken,
) {
    let mut active = FuturesUnordered::new();
    let mut ready_open = true;
    let mut cancelling = false;
    while ready_open || !active.is_empty() {
        tokio::select! {
            _ = cancellation.cancelled(), if !cancelling => {
                cancelling = true;
                ready_rx.lock().await.close();
            }
            Some(()) = active.next(), if !active.is_empty() => {}
            runnable = recv_runnable(Arc::clone(&ready_rx)), if ready_open => {
                match runnable {
                    Some(runnable) => active.push(runnable.work),
                    None => ready_open = false,
                }
            }
        }
    }
}

async fn recv_runnable(ready_rx: Arc<Mutex<mpsc::Receiver<Runnable>>>) -> Option<Runnable> {
    let mut ready_rx = ready_rx.lock().await;
    ready_rx.recv().await
}

struct Admitted<T> {
    item: T,
    permit: OwnedSemaphorePermit,
}

impl<T> Admitted<T> {
    fn map<U>(self, map: impl FnOnce(T) -> U) -> Admitted<U> {
        Admitted {
            item: map(self.item),
            permit: self.permit,
        }
    }
}

struct ClassifiedQueryRoute {
    direct: bool,
    route: Box<dyn Any + Send>,
}

struct QueryRouteFailure {
    panic: StdMutex<Option<Box<dyn Any + Send>>>,
    cancellation: CancellationToken,
}

impl QueryRouteFailure {
    fn new() -> Self {
        Self {
            panic: StdMutex::new(None),
            cancellation: CancellationToken::new(),
        }
    }

    fn take(&self) -> Option<Box<dyn Any + Send>> {
        self.panic.lock().expect("query route failure lock poisoned").take()
    }
}

struct RoutedQuery<Query, Key> {
    query: Query,
    route: QueryRoute<Key>,
}

impl<Query, Key: Send + 'static> RoutedQuery<Query, Key> {
    fn into_mailbox<Command>(self) -> Mailbox<Command, Query> {
        Mailbox::Query {
            query: self.query,
            route: ClassifiedQueryRoute {
                direct: matches!(&self.route, QueryRoute::Direct),
                route: Box::new(self.route),
            },
        }
    }
}

enum Mailbox<Command, Query> {
    Command { command: Command, control: bool },
    Query { query: Query, route: ClassifiedQueryRoute },
}

enum LaneItem<O: OwnerSpec> {
    Command(O::Command),
    Query(RoutedQuery<O::Query, O::Key>),
}

enum GlobalItem<O: OwnerSpec> {
    Command(O::Command),
    Query(RoutedQuery<O::Query, O::Key>),
}

enum ExclusiveItem<O: OwnerSpec> {
    Command(O::Command),
    Query(RoutedQuery<O::Query, O::Key>),
    Shutdown(O::Command),
}

fn hash_observation_key<K: Hash>(key: &K) -> u64 {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    hasher.finish()
}

fn observe_owner_runtime<O>(
    observation: &ObservationSink,
    owner_id: OwnerRuntimeId,
    stage: OwnerRuntimeStage,
    item: OwnerRuntimeItem,
    route: OwnerRuntimeRoute,
    key_hash: Option<u64>,
    queue_depth: Option<usize>,
    reason: Option<OwnerRuntimeReason>,
) where
    O: OwnerSpec,
{
    if !observation.is_enabled() {
        return;
    }

    observation.observe(ObservationRecord::OwnerRuntime(OwnerRuntimeObservation {
        trace: TraceContext::absent(),
        owner_id: owner_id.as_u64(),
        owner_kind: std::any::type_name::<O>(),
        stage,
        item,
        route,
        key_hash,
        queue_depth,
        reason,
    }));
}

fn observe_keyed_owner_runtime<O>(
    observation: &ObservationSink,
    owner_id: OwnerRuntimeId,
    stage: OwnerRuntimeStage,
    item: OwnerRuntimeItem,
    route: OwnerRuntimeRoute,
    key: &O::Key,
    queue_depth: Option<usize>,
    reason: Option<OwnerRuntimeReason>,
) where
    O: OwnerSpec,
{
    if !observation.is_enabled() {
        return;
    }

    observe_owner_runtime::<O>(
        observation,
        owner_id,
        stage,
        item,
        route,
        Some(hash_observation_key(key)),
        queue_depth,
        reason,
    );
}

fn key_hash_for_observation<K>(observation: &ObservationSink, key: &K) -> Option<u64>
where
    K: Hash,
{
    if observation.is_enabled() {
        Some(hash_observation_key(key))
    } else {
        None
    }
}

fn observe_command_route<O>(
    observation: &ObservationSink,
    owner_id: OwnerRuntimeId,
    route: &CommandRoute<O::Key>,
) where
    O: OwnerSpec,
{
    if !observation.is_enabled() {
        return;
    }

    match route {
        CommandRoute::Keyed(key) | CommandRoute::KeyedControl(key) => observe_owner_runtime::<O>(
            observation,
            owner_id,
            OwnerRuntimeStage::Route,
            OwnerRuntimeItem::Command,
            OwnerRuntimeRoute::Keyed,
            Some(hash_observation_key(key)),
            None,
            Some(OwnerRuntimeReason::Accepted),
        ),
        CommandRoute::Global => observe_owner_runtime::<O>(
            observation,
            owner_id,
            OwnerRuntimeStage::Route,
            OwnerRuntimeItem::Command,
            OwnerRuntimeRoute::Global,
            None,
            None,
            Some(OwnerRuntimeReason::Accepted),
        ),
        CommandRoute::Exclusive => observe_owner_runtime::<O>(
            observation,
            owner_id,
            OwnerRuntimeStage::Route,
            OwnerRuntimeItem::Command,
            OwnerRuntimeRoute::Exclusive,
            None,
            None,
            Some(OwnerRuntimeReason::Accepted),
        ),
        CommandRoute::Shutdown => observe_owner_runtime::<O>(
            observation,
            owner_id,
            OwnerRuntimeStage::Route,
            OwnerRuntimeItem::Shutdown,
            OwnerRuntimeRoute::Shutdown,
            None,
            None,
            Some(OwnerRuntimeReason::Accepted),
        ),
    }
}

fn observe_query_route<O>(
    observation: &ObservationSink,
    owner_id: OwnerRuntimeId,
    route: &QueryRoute<O::Key>,
) where
    O: OwnerSpec,
{
    if !observation.is_enabled() {
        return;
    }

    match route {
        QueryRoute::Direct => observe_owner_runtime::<O>(
            observation,
            owner_id,
            OwnerRuntimeStage::Route,
            OwnerRuntimeItem::Query,
            OwnerRuntimeRoute::Direct,
            None,
            None,
            Some(OwnerRuntimeReason::Accepted),
        ),
        QueryRoute::Keyed(key) => observe_owner_runtime::<O>(
            observation,
            owner_id,
            OwnerRuntimeStage::Route,
            OwnerRuntimeItem::Query,
            OwnerRuntimeRoute::Keyed,
            Some(hash_observation_key(key)),
            None,
            Some(OwnerRuntimeReason::Accepted),
        ),
        QueryRoute::Global => observe_owner_runtime::<O>(
            observation,
            owner_id,
            OwnerRuntimeStage::Route,
            OwnerRuntimeItem::Query,
            OwnerRuntimeRoute::Global,
            None,
            None,
            Some(OwnerRuntimeReason::Accepted),
        ),
        QueryRoute::Exclusive => observe_owner_runtime::<O>(
            observation,
            owner_id,
            OwnerRuntimeStage::Route,
            OwnerRuntimeItem::Query,
            OwnerRuntimeRoute::Exclusive,
            None,
            None,
            Some(OwnerRuntimeReason::Accepted),
        ),
    }
}

fn lane_item_observation_item<O>(item: &LaneItem<O>) -> OwnerRuntimeItem
where
    O: OwnerSpec,
{
    match item {
        LaneItem::Command(_) => OwnerRuntimeItem::Command,
        LaneItem::Query(_) => OwnerRuntimeItem::Query,
    }
}

fn global_item_observation_item<O>(item: &GlobalItem<O>) -> OwnerRuntimeItem
where
    O: OwnerSpec,
{
    match item {
        GlobalItem::Command(_) => OwnerRuntimeItem::Command,
        GlobalItem::Query(_) => OwnerRuntimeItem::Query,
    }
}

fn exclusive_item_observation_item<O>(item: &ExclusiveItem<O>) -> OwnerRuntimeItem
where
    O: OwnerSpec,
{
    match item {
        ExclusiveItem::Command(_) => OwnerRuntimeItem::Command,
        ExclusiveItem::Query(_) => OwnerRuntimeItem::Query,
        ExclusiveItem::Shutdown(_) => OwnerRuntimeItem::Shutdown,
    }
}

fn exclusive_item_observation_route<O>(item: &ExclusiveItem<O>) -> OwnerRuntimeRoute
where
    O: OwnerSpec,
{
    match item {
        ExclusiveItem::Shutdown(_) => OwnerRuntimeRoute::Shutdown,
        ExclusiveItem::Command(_) | ExclusiveItem::Query(_) => OwnerRuntimeRoute::Exclusive,
    }
}

struct Lane<O: OwnerSpec> {
    state: Option<O::LaneState>,
    queue: VecDeque<Admitted<LaneItem<O>>>,
    running: bool,
    cancellation: Option<CancellationToken>,
    idle_since: Option<Instant>,
}

struct OwnerRuntimeSlot<O: OwnerSpec> {
    id: OwnerRuntimeId,
    shared: O::Shared,
    global_state: Option<O::GlobalState>,
    global_queue: VecDeque<Admitted<GlobalItem<O>>>,
    global_running: bool,
    global_cancellation: Option<CancellationToken>,
    exclusive_queue: VecDeque<Admitted<ExclusiveItem<O>>>,
    exclusive_running: bool,
    exclusive_cancellation: Option<CancellationToken>,
    lanes: HashMap<O::Key, Lane<O>>,
    direct_running: HashMap<u64, CancellationToken>,
    next_direct_id: u64,
    idle_timeout: Duration,
    lane_queue_capacity: usize,
    global_queue_capacity: usize,
    ready_tx: Option<mpsc::Sender<Runnable>>,
    observation: ObservationSink,
    completion_tx: mpsc::UnboundedSender<Admitted<Completion<O>>>,
    completion_rx: mpsc::UnboundedReceiver<Admitted<Completion<O>>>,
    admission: Arc<Semaphore>,
    direct_admission: Arc<Semaphore>,
    query_route_failure: Arc<QueryRouteFailure>,
    system_cancellation: CancellationToken,
    owner_cancellation: CancellationToken,
    task_cancellation: CancellationToken,
    closing: bool,
}

enum Work<O: OwnerSpec> {
    DirectQuery {
        id: u64,
        query: O::Query,
        cancellation: CancellationToken,
    },
    KeyedCommand {
        key: O::Key,
        state: O::LaneState,
        command: O::Command,
        cancellation: CancellationToken,
    },
    KeyedQuery {
        key: O::Key,
        state: O::LaneState,
        query: O::Query,
        cancellation: CancellationToken,
    },
    GlobalCommand {
        state: O::GlobalState,
        command: O::Command,
        close_after: bool,
        cancellation: CancellationToken,
    },
    GlobalQuery {
        state: O::GlobalState,
        query: O::Query,
        cancellation: CancellationToken,
    },
    ExclusiveQuery {
        state: O::GlobalState,
        query: O::Query,
        cancellation: CancellationToken,
    },
}

enum Completion<O: OwnerSpec> {
    Direct {
        id: u64,
        failed: bool,
    },
    Keyed {
        key: O::Key,
        state: O::LaneState,
        failed: bool,
    },
    Global {
        state: O::GlobalState,
        failed: bool,
        close_after: bool,
    },
    Exclusive {
        state: O::GlobalState,
        failed: bool,
    },
}

impl<O> OwnerRuntimeSlot<O>
where
    O: OwnerSpec,
{
    fn new(
        id: OwnerRuntimeId,
        shared: O::Shared,
        global_state: O::GlobalState,
        config: OwnerRuntimeConfig,
        ready_tx: mpsc::Sender<Runnable>,
        observation: ObservationSink,
        completion_tx: mpsc::UnboundedSender<Admitted<Completion<O>>>,
        completion_rx: mpsc::UnboundedReceiver<Admitted<Completion<O>>>,
        admission: Arc<Semaphore>,
        direct_admission: Arc<Semaphore>,
        query_route_failure: Arc<QueryRouteFailure>,
        system_cancellation: CancellationToken,
    ) -> Self {
        Self {
            id,
            shared,
            global_state: Some(global_state),
            global_queue: VecDeque::new(),
            global_running: false,
            global_cancellation: None,
            exclusive_queue: VecDeque::new(),
            exclusive_running: false,
            exclusive_cancellation: None,
            lanes: HashMap::new(),
            direct_running: HashMap::new(),
            next_direct_id: 0,
            idle_timeout: config.lane_retention.as_duration(),
            lane_queue_capacity: config.lane_queue_capacity,
            global_queue_capacity: config.global_queue_capacity,
            ready_tx: Some(ready_tx),
            observation,
            completion_tx,
            completion_rx,
            admission,
            direct_admission,
            query_route_failure,
            owner_cancellation: system_cancellation.child_token(),
            system_cancellation,
            task_cancellation: CancellationToken::new(),
            closing: false,
        }
    }

    async fn run(
        mut self,
        mut mailbox_rx: mpsc::Receiver<Admitted<Mailbox<O::Command, O::Query>>>,
        cancellation: CancellationToken,
        drain: CancellationToken,
    ) {
        self.task_cancellation = cancellation.clone();
        let mut mailbox_open = true;
        let mut draining = false;
        let mut pending = None;
        let mut eviction_interval = tokio::time::interval(Duration::from_secs(5));
        eviction_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            if !self.closing
                && (cancellation.is_cancelled()
                    || self.system_cancellation.is_cancelled()
                    || self.query_route_failure.cancellation.is_cancelled())
            {
                self.begin_shutdown();
            }
            if self.closing {
                pending = None;
                mailbox_open = false;
                mailbox_rx.close();
            }
            if draining && O::PENDING_LIFECYCLE && !self.closing && pending.is_none() && self.can_shutdown() {
                mailbox_rx.close();
            }
            if (self.closing || (!mailbox_open && pending.is_none())) && self.can_shutdown() {
                break;
            }

            if !self.closing {
                self.dispatch_ready().await;
                if self.closing {
                    continue;
                }
            }

            if let Some(message) = pending.take() {
                match self.accept(message).await {
                    Ok(()) => continue,
                    Err(message) => pending = Some(message),
                }
            }

            tokio::select! {
                biased;

                _ = cancellation.cancelled(), if !self.closing => {
                    self.begin_shutdown();
                    mailbox_open = false;
                    mailbox_rx.close();
                }

                _ = self.system_cancellation.cancelled(), if !self.closing => {
                    self.begin_shutdown();
                    mailbox_open = false;
                    mailbox_rx.close();
                }

                _ = self.query_route_failure.cancellation.cancelled(), if !self.closing => {
                    self.begin_shutdown();
                    mailbox_open = false;
                    mailbox_rx.close();
                }

                _ = drain.cancelled(), if !draining && !self.closing => {
                    draining = true;
                    if !O::PENDING_LIFECYCLE {
                        mailbox_rx.close();
                    }
                }

                Some(completion) = self.completion_rx.recv() => {
                    self.complete(completion);
                }

                message = mailbox_rx.recv(), if mailbox_open && pending.is_none() && !self.exclusive_blocks_mailbox() => {
                    match message {
                        Some(message) => {
                            if let Err(message) = self.accept(message).await {
                                pending = Some(message);
                            }
                        }
                        None => {
                            mailbox_open = false;
                        }
                    }
                }

                _ = eviction_interval.tick(), if !self.closing && !self.exclusive_blocks_mailbox() => {
                    self.evict_idle_lanes();
                }
            }
        }

        self.admission.close();
        self.direct_admission.close();
        if let Some(panic) = self.query_route_failure.take() {
            std::panic::resume_unwind(panic);
        }
        let mut lanes = Vec::with_capacity(self.lanes.len());
        for (key, mut lane) in self.lanes.drain() {
            if let Some(state) = lane.state.take() {
                lanes.push((key, state));
            }
        }
        if let Some(mut global_state) = self.global_state.take() {
            observe_owner_runtime::<O>(
                &self.observation,
                self.id,
                OwnerRuntimeStage::ShutdownStart,
                OwnerRuntimeItem::Shutdown,
                OwnerRuntimeRoute::Shutdown,
                None,
                None,
                Some(OwnerRuntimeReason::Accepted),
            );
            match AssertUnwindSafe(O::shutdown(self.shared, &mut global_state, lanes))
                .catch_unwind()
                .await
            {
                Ok(()) => observe_owner_runtime::<O>(
                    &self.observation,
                    self.id,
                    OwnerRuntimeStage::ShutdownSettle,
                    OwnerRuntimeItem::Shutdown,
                    OwnerRuntimeRoute::Shutdown,
                    None,
                    None,
                    Some(OwnerRuntimeReason::Accepted),
                ),
                Err(panic) => {
                    observe_owner_runtime::<O>(
                        &self.observation,
                        self.id,
                        OwnerRuntimeStage::ShutdownSettle,
                        OwnerRuntimeItem::Shutdown,
                        OwnerRuntimeRoute::Shutdown,
                        None,
                        None,
                        Some(OwnerRuntimeReason::Panic),
                    );
                    std::panic::resume_unwind(panic);
                }
            }
        }
    }

    async fn accept(
        &mut self,
        message: Admitted<Mailbox<O::Command, O::Query>>,
    ) -> Result<(), Admitted<Mailbox<O::Command, O::Query>>> {
        let Admitted { item: message, permit } = message;
        match message {
            Mailbox::Command { command, .. } => {
                let route = O::route_command(&command);
                observe_command_route::<O>(&self.observation, self.id, &route);
                match route {
                    CommandRoute::Keyed(key) | CommandRoute::KeyedControl(key) => self
                        .enqueue_keyed(key, Admitted { item: LaneItem::Command(command), permit })
                        .map_err(|item| item.map(lane_item_to_mailbox)),
                    CommandRoute::Global => self
                        .enqueue_global(Admitted { item: GlobalItem::Command(command), permit })
                        .map_err(|item| item.map(global_item_to_mailbox)),
                    CommandRoute::Exclusive => self
                        .enqueue_exclusive(Admitted { item: ExclusiveItem::Command(command), permit })
                        .map_err(|item| item.map(exclusive_item_to_mailbox)),
                    CommandRoute::Shutdown => self
                        .enqueue_exclusive(Admitted { item: ExclusiveItem::Shutdown(command), permit })
                        .map_err(|item| item.map(exclusive_item_to_mailbox)),
                }
            }
            Mailbox::Query { query, route } => {
                let route = *route.route.downcast::<QueryRoute<O::Key>>()
                    .unwrap_or_else(|_| unreachable!("query route belongs to its owner"));
                observe_query_route::<O>(&self.observation, self.id, &route);
                match route {
                    QueryRoute::Direct => {
                        self.dispatch_direct_query(Admitted { item: query, permit }).await;
                        Ok(())
                    }
                    QueryRoute::Keyed(key) => self
                        .enqueue_keyed(key.clone(), Admitted {
                            item: LaneItem::Query(RoutedQuery { query, route: QueryRoute::Keyed(key) }),
                            permit,
                        })
                        .map_err(|item| item.map(lane_item_to_mailbox)),
                    QueryRoute::Global => self
                        .enqueue_global(Admitted {
                            item: GlobalItem::Query(RoutedQuery { query, route: QueryRoute::Global }),
                            permit,
                        })
                        .map_err(|item| item.map(global_item_to_mailbox)),
                    QueryRoute::Exclusive => self
                        .enqueue_exclusive(Admitted {
                            item: ExclusiveItem::Query(RoutedQuery { query, route: QueryRoute::Exclusive }),
                            permit,
                        })
                        .map_err(|item| item.map(exclusive_item_to_mailbox)),
                }
            }
        }
    }

    fn enqueue_keyed(
        &mut self,
        key: O::Key,
        item: Admitted<LaneItem<O>>,
    ) -> Result<(), Admitted<LaneItem<O>>> {
        let item_kind = lane_item_observation_item(&item.item);
        let progress = O::PENDING_LIFECYCLE && (self.has_pending_lanes() || self.lanes.values().any(|lane| lane.running));
        let control = O::PENDING_LIFECYCLE && matches!(&item.item, LaneItem::Command(command) if matches!(O::route_command(command), CommandRoute::KeyedControl(_)));
        let lane = self.lanes.entry(key.clone()).or_insert_with(|| Lane {
            state: Some(O::open_lane(&self.shared, &key)),
            queue: VecDeque::new(),
            running: false,
            cancellation: None,
            idle_since: None,
        });
        if lane.queue.len() >= self.lane_queue_capacity && !control && !progress {
            observe_keyed_owner_runtime::<O>(
                &self.observation,
                self.id,
                OwnerRuntimeStage::Enqueue,
                item_kind,
                OwnerRuntimeRoute::Keyed,
                &key,
                Some(lane.queue.len()),
                Some(OwnerRuntimeReason::QueueFull),
            );
            return Err(item);
        }
        lane.idle_since = None;
        lane.queue.push_back(item);
        observe_keyed_owner_runtime::<O>(
            &self.observation,
            self.id,
            OwnerRuntimeStage::Enqueue,
            item_kind,
            OwnerRuntimeRoute::Keyed,
            &key,
            Some(lane.queue.len()),
            Some(OwnerRuntimeReason::Accepted),
        );
        Ok(())
    }

    fn enqueue_global(
        &mut self,
        item: Admitted<GlobalItem<O>>,
    ) -> Result<(), Admitted<GlobalItem<O>>> {
        let item_kind = global_item_observation_item(&item.item);
        if self.global_queue.len() >= self.global_queue_capacity
            && !(O::PENDING_LIFECYCLE && (self.has_pending_lanes() || self.lanes.values().any(|lane| lane.running)))
        {
            observe_owner_runtime::<O>(
                &self.observation,
                self.id,
                OwnerRuntimeStage::Enqueue,
                item_kind,
                OwnerRuntimeRoute::Global,
                None,
                Some(self.global_queue.len()),
                Some(OwnerRuntimeReason::QueueFull),
            );
            return Err(item);
        }
        self.global_queue.push_back(item);
        observe_owner_runtime::<O>(
            &self.observation,
            self.id,
            OwnerRuntimeStage::Enqueue,
            item_kind,
            OwnerRuntimeRoute::Global,
            None,
            Some(self.global_queue.len()),
            Some(OwnerRuntimeReason::Accepted),
        );
        Ok(())
    }

    fn enqueue_exclusive(
        &mut self,
        item: Admitted<ExclusiveItem<O>>,
    ) -> Result<(), Admitted<ExclusiveItem<O>>> {
        let item_kind = exclusive_item_observation_item(&item.item);
        let route = exclusive_item_observation_route(&item.item);
        if self.exclusive_queue.len() >= self.global_queue_capacity {
            observe_owner_runtime::<O>(
                &self.observation,
                self.id,
                OwnerRuntimeStage::Enqueue,
                item_kind,
                route,
                None,
                Some(self.exclusive_queue.len()),
                Some(OwnerRuntimeReason::QueueFull),
            );
            return Err(item);
        }
        self.exclusive_queue.push_back(item);
        observe_owner_runtime::<O>(
            &self.observation,
            self.id,
            OwnerRuntimeStage::Enqueue,
            item_kind,
            route,
            None,
            Some(self.exclusive_queue.len()),
            Some(OwnerRuntimeReason::Accepted),
        );
        Ok(())
    }

    async fn dispatch_direct_query(&mut self, query: Admitted<O::Query>) {
        let Admitted { item: query, permit } = query;
        let id = self.next_direct_id;
        self.next_direct_id = self.next_direct_id.wrapping_add(1);
        let cancellation = self.owner_cancellation.child_token();
        self.direct_running.insert(id, cancellation.clone());
        self.send_work(
            OwnerRuntimeItem::Query,
            OwnerRuntimeRoute::Direct,
            None,
            Admitted {
                item: Work::DirectQuery {
                    id,
                    query,
                    cancellation,
                },
                permit,
            },
        )
        .await;
    }

    async fn dispatch_ready(&mut self) {
        if self.closing {
            return;
        }

        self.dispatch_global_if_ready().await;
        let keys = self
            .lanes
            .iter()
            .filter(|(_, lane)| !lane.running && !lane.queue.is_empty() && lane.state.is_some())
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in keys {
            self.dispatch_keyed(key).await;
        }
        self.dispatch_exclusive_if_ready().await;
    }

    async fn dispatch_keyed(&mut self, key: O::Key) {
        let Some(lane) = self.lanes.get_mut(&key) else {
            return;
        };
        if lane.running || lane.queue.is_empty() {
            return;
        }
        let Some(state) = lane.state.as_ref() else {
            return;
        };
        let index = match lane.queue.front().map(|item| &item.item) {
            Some(LaneItem::Command(command)) if !O::keyed_command_ready(&self.shared, &key, state, command) => {
                let Some(index) = lane.queue.iter().position(|item| {
                    matches!(&item.item, LaneItem::Command(command) if matches!(O::route_command(command), CommandRoute::KeyedControl(_)))
                }) else { return; };
                index
            }
            _ => 0,
        };
        let state = lane.state.take().expect("ready lane state");
        let Some(Admitted { item, permit }) = lane.queue.remove(index) else {
            lane.state = Some(state);
            return;
        };
        let cancellation = self.owner_cancellation.child_token();
        lane.running = true;
        lane.cancellation = Some(cancellation.clone());
        let item_kind = lane_item_observation_item(&item);
        let key_hash = key_hash_for_observation(&self.observation, &key);
        let work = match item {
            LaneItem::Command(command) => Work::KeyedCommand {
                key,
                state,
                command,
                cancellation,
            },
            LaneItem::Query(query) => Work::KeyedQuery {
                key,
                state,
                query: query.query,
                cancellation,
            },
        };
        self.send_work(item_kind, OwnerRuntimeRoute::Keyed, key_hash, Admitted { item: work, permit })
            .await;
    }

    async fn dispatch_global_if_ready(&mut self) {
        if self.global_running || self.global_queue.is_empty() {
            return;
        }
        let Some(state) = self.global_state.take() else {
            return;
        };
        let Some(Admitted { item, permit }) = self.global_queue.pop_front() else {
            self.global_state = Some(state);
            return;
        };
        let cancellation = self.owner_cancellation.child_token();
        self.global_running = true;
        self.global_cancellation = Some(cancellation.clone());
        let item_kind = global_item_observation_item(&item);
        let work = match item {
            GlobalItem::Command(command) => Work::GlobalCommand {
                state,
                command,
                close_after: false,
                cancellation,
            },
            GlobalItem::Query(query) => Work::GlobalQuery {
                state,
                query: query.query,
                cancellation,
            },
        };
        self.send_work(item_kind, OwnerRuntimeRoute::Global, None, Admitted { item: work, permit })
            .await;
    }

    async fn dispatch_exclusive_if_ready(&mut self) {
        if self.exclusive_running
            || self.exclusive_queue.is_empty()
            || self.has_pending_lanes()
            || !self.direct_running.is_empty()
            || self.global_running
            || !self.global_queue.is_empty()
            || self
                .lanes
                .values()
                .any(|lane| lane.running || !lane.queue.is_empty())
        {
            return;
        }
        let Some(state) = self.global_state.take() else {
            return;
        };
        let Some(Admitted { item, permit }) = self.exclusive_queue.pop_front() else {
            self.global_state = Some(state);
            return;
        };
        let cancellation = self.owner_cancellation.child_token();
        self.exclusive_running = true;
        self.exclusive_cancellation = Some(cancellation.clone());
        let item_kind = exclusive_item_observation_item(&item);
        let route = exclusive_item_observation_route(&item);
        let work = match item {
            ExclusiveItem::Command(command) => Work::GlobalCommand {
                state,
                command,
                close_after: false,
                cancellation,
            },
            ExclusiveItem::Shutdown(command) => Work::GlobalCommand {
                state,
                command,
                close_after: true,
                cancellation,
            },
            ExclusiveItem::Query(query) => Work::ExclusiveQuery {
                state,
                query: query.query,
                cancellation,
            },
        };
        self.send_work(item_kind, route, None, Admitted { item: work, permit }).await;
    }

    async fn send_work(
        &mut self,
        item: OwnerRuntimeItem,
        route: OwnerRuntimeRoute,
        key_hash: Option<u64>,
        work: Admitted<Work<O>>,
    ) {
        observe_owner_runtime::<O>(
            &self.observation,
            self.id,
            OwnerRuntimeStage::Dequeue,
            item,
            route,
            key_hash,
            None,
            Some(OwnerRuntimeReason::Accepted),
        );
        let Admitted { item: work, permit } = work;
        let runnable = Runnable {
            work: work.boxed(
                self.id,
                self.shared.clone(),
                self.observation.clone(),
                item,
                route,
                key_hash,
                self.completion_tx.clone(),
                permit,
            ),
        };
        let ready_tx = self.ready_tx.clone();
        let reservation = match &ready_tx {
            Some(ready_tx) => tokio::select! {
                biased;
                _ = self.task_cancellation.cancelled() => None,
                _ = self.system_cancellation.cancelled() => None,
                _ = self.query_route_failure.cancellation.cancelled() => None,
                result = ready_tx.reserve() => result.ok(),
            },
            None => None,
        };
        if let Some(reservation) = reservation {
            reservation.send(runnable);
        } else {
            observe_owner_runtime::<O>(
                &self.observation,
                self.id,
                OwnerRuntimeStage::Enqueue,
                item,
                route,
                key_hash,
                None,
                Some(OwnerRuntimeReason::ReadyQueueClosed),
            );
            self.begin_shutdown();
            // A rejected ready send still owes the slot its state and terminal permit.
            runnable.work.await;
        }
    }

    fn complete(&mut self, completion: Admitted<Completion<O>>) {
        let Admitted { item: completion, permit } = completion;
        let failed = match completion {
            Completion::Direct { id, failed } => {
                self.direct_running.remove(&id);
                failed
            }
            Completion::Keyed { key, state, failed } => {
                if let Some(lane) = self.lanes.get_mut(&key) {
                    lane.state = Some(state);
                    lane.running = false;
                    lane.cancellation = None;
                    if lane.queue.is_empty() {
                        lane.idle_since = Some(Instant::now());
                    }
                }
                failed
            }
            Completion::Global {
                state,
                failed,
                close_after,
            } => {
                self.global_state = Some(state);
                self.global_running = false;
                self.global_cancellation = None;
                if self.exclusive_running {
                    self.exclusive_running = false;
                    self.exclusive_cancellation = None;
                }
                if close_after {
                    self.begin_shutdown();
                }
                failed
            }
            Completion::Exclusive { state, failed } => {
                self.global_state = Some(state);
                self.exclusive_running = false;
                self.exclusive_cancellation = None;
                failed
            }
        };
        if failed {
            self.begin_shutdown();
        }
        drop(permit);
    }

    fn has_pending_lanes(&self) -> bool {
        self.lanes.iter().any(|(key, lane)| {
            lane.state.as_ref().is_some_and(|state| O::lane_has_pending(&self.shared, key, state))
        })
    }

    fn exclusive_blocks_mailbox(&self) -> bool {
        self.exclusive_running || !self.exclusive_queue.is_empty()
    }

    fn evict_idle_lanes(&mut self) {
        if self.idle_timeout.is_zero() {
            self.lanes
                .retain(|key, lane| lane.running || !lane.queue.is_empty()
                    || lane.state.as_ref().is_some_and(|state| O::lane_has_pending(&self.shared, key, state)));
            return;
        }
        let now = Instant::now();
        let idle_timeout = self.idle_timeout;
        self.lanes.retain(|key, lane| {
            lane.running
                || !lane.queue.is_empty()
                || lane.state.as_ref().is_some_and(|state| O::lane_has_pending(&self.shared, key, state))
                || lane
                    .idle_since
                    .is_none_or(|idle_since| now.duration_since(idle_since) < idle_timeout)
        });
    }

    fn begin_shutdown(&mut self) {
        self.closing = true;
        self.admission.close();
        self.direct_admission.close();
        self.owner_cancellation.cancel();
        if let Some(cancellation) = &self.global_cancellation {
            cancellation.cancel();
        }
        if let Some(cancellation) = &self.exclusive_cancellation {
            cancellation.cancel();
        }
        for cancellation in self.direct_running.values() {
            cancellation.cancel();
        }
        self.global_queue.clear();
        self.exclusive_queue.clear();
        for lane in self.lanes.values_mut() {
            if let Some(cancellation) = &lane.cancellation {
                cancellation.cancel();
            }
            lane.queue.clear();
        }
    }

    fn can_shutdown(&self) -> bool {
        (self.closing || !self.has_pending_lanes())
            && self.direct_running.is_empty()
            && !self.global_running
            && !self.exclusive_running
            && self.global_queue.is_empty()
            && self.exclusive_queue.is_empty()
            && self
                .lanes
                .values()
                .all(|lane| !lane.running && lane.queue.is_empty())
    }
}

fn lane_item_to_mailbox<O: OwnerSpec>(item: LaneItem<O>) -> Mailbox<O::Command, O::Query> {
    match item {
        LaneItem::Command(command) => {
            let control = O::PENDING_LIFECYCLE && matches!(O::route_command(&command), CommandRoute::KeyedControl(_));
            Mailbox::Command { command, control }
        },
        LaneItem::Query(query) => query.into_mailbox(),
    }
}

fn global_item_to_mailbox<O: OwnerSpec>(item: GlobalItem<O>) -> Mailbox<O::Command, O::Query> {
    match item {
        GlobalItem::Command(command) => Mailbox::Command { command, control: false },
        GlobalItem::Query(query) => query.into_mailbox(),
    }
}

fn exclusive_item_to_mailbox<O: OwnerSpec>(
    item: ExclusiveItem<O>,
) -> Mailbox<O::Command, O::Query> {
    match item {
        ExclusiveItem::Command(command) | ExclusiveItem::Shutdown(command) => {
            Mailbox::Command { command, control: false }
        }
        ExclusiveItem::Query(query) => query.into_mailbox(),
    }
}

async fn run_observed_handler<O, F>(
    observation: &ObservationSink,
    owner_id: OwnerRuntimeId,
    item: OwnerRuntimeItem,
    route: OwnerRuntimeRoute,
    key_hash: Option<u64>,
    cancellation: &CancellationToken,
    future: F,
) -> bool
where
    O: OwnerSpec,
    F: Future<Output = ()> + Send,
{
    observe_owner_runtime::<O>(
        observation,
        owner_id,
        OwnerRuntimeStage::HandlerStart,
        item,
        route,
        key_hash,
        None,
        None,
    );
    let reason = tokio::select! {
        biased;
        _ = cancellation.cancelled() => OwnerRuntimeReason::Cancellation,
        result = AssertUnwindSafe(future).catch_unwind() => {
            if result.is_err() {
                OwnerRuntimeReason::Panic
            } else {
                OwnerRuntimeReason::Accepted
            }
        }
    };
    observe_owner_runtime::<O>(
        observation,
        owner_id,
        OwnerRuntimeStage::HandlerSettle,
        item,
        route,
        key_hash,
        None,
        Some(reason),
    );
    reason == OwnerRuntimeReason::Panic
}

impl<O> Work<O>
where
    O: OwnerSpec,
{
    fn boxed(
        self,
        owner_id: OwnerRuntimeId,
        shared: O::Shared,
        observation: ObservationSink,
        item: OwnerRuntimeItem,
        route: OwnerRuntimeRoute,
        key_hash: Option<u64>,
        completion_tx: mpsc::UnboundedSender<Admitted<Completion<O>>>,
        permit: OwnedSemaphorePermit,
    ) -> RuntimeWork {
        Box::pin(async move {
            let completion = match self {
                Self::DirectQuery {
                    id,
                    query,
                    cancellation,
                } => {
                    let failed = run_observed_handler::<O, _>(
                        &observation,
                        owner_id,
                        item,
                        route,
                        key_hash,
                        &cancellation,
                        async { O::handle_direct_query(shared, query).await },
                    )
                    .await;
                    Completion::Direct { id, failed }
                }
                Self::KeyedCommand {
                    mut key,
                    mut state,
                    command,
                    cancellation,
                } => {
                    let handler_key = &mut key;
                    let handler_state = &mut state;
                    let failed = run_observed_handler::<O, _>(
                        &observation,
                        owner_id,
                        item,
                        route,
                        key_hash,
                        &cancellation,
                        async move {
                            O::handle_keyed_command(shared, handler_key.clone(), handler_state, command).await;
                        },
                    )
                    .await;
                    Completion::Keyed { key, state, failed }
                }
                Self::KeyedQuery {
                    mut key,
                    mut state,
                    query,
                    cancellation,
                } => {
                    let handler_key = &mut key;
                    let handler_state = &mut state;
                    let failed = run_observed_handler::<O, _>(
                        &observation,
                        owner_id,
                        item,
                        route,
                        key_hash,
                        &cancellation,
                        async move {
                            O::handle_keyed_query(shared, handler_key.clone(), handler_state, query).await;
                        },
                    )
                    .await;
                    Completion::Keyed { key, state, failed }
                }
                Self::GlobalCommand {
                    mut state,
                    command,
                    close_after,
                    cancellation,
                } => {
                    let failed = run_observed_handler::<O, _>(
                        &observation,
                        owner_id,
                        item,
                        route,
                        key_hash,
                        &cancellation,
                        async { O::handle_global_command(shared, &mut state, command).await },
                    )
                    .await;
                    Completion::Global {
                        state,
                        failed,
                        close_after,
                    }
                }
                Self::GlobalQuery {
                    mut state,
                    query,
                    cancellation,
                } => {
                    let failed = run_observed_handler::<O, _>(
                        &observation,
                        owner_id,
                        item,
                        route,
                        key_hash,
                        &cancellation,
                        async { O::handle_global_query(shared, &mut state, query).await },
                    )
                    .await;
                    Completion::Global {
                        state,
                        failed,
                        close_after: false,
                    }
                }
                Self::ExclusiveQuery {
                    mut state,
                    query,
                    cancellation,
                } => {
                    let failed = run_observed_handler::<O, _>(
                        &observation,
                        owner_id,
                        item,
                        route,
                        key_hash,
                        &cancellation,
                        async { O::handle_exclusive_query(shared, &mut state, query).await },
                    )
                    .await;
                    Completion::Exclusive { state, failed }
                }
            };
            let _ = completion_tx.send(Admitted { item: completion, permit });
        })
    }
}
