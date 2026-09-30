use std::{
    collections::{HashMap, VecDeque, hash_map::DefaultHasher},
    fmt,
    future::Future,
    hash::{Hash, Hasher},
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use futures_util::FutureExt;
use tokio::{
    sync::{Mutex, mpsc},
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
        let (workers, _handle) = OwnedTask::spawn(move |cancellation| async move {
            let mut worker_tasks = Vec::with_capacity(config.worker_count);
            for _ in 0..config.worker_count {
                worker_tasks.push(tokio::spawn(worker_loop(
                    Arc::clone(&ready_rx),
                    cancellation.clone(),
                )));
            }
            let mut failure = None;
            for index in 0..worker_tasks.len() {
                let result = tokio::select! {
                    _ = cancellation.cancelled() => {
                        for worker in &worker_tasks {
                            worker.abort();
                        }
                        for worker in &mut worker_tasks[index..] {
                            let _ = worker.await;
                        }
                        return Ok(());
                    }
                    result = &mut worker_tasks[index] => result,
                };
                if let Err(error) = result {
                    failure.get_or_insert(error);
                }
            }
            failure.map_or(Ok(()), Err)
        });
        Self {
            next_owner_id: Arc::new(AtomicU64::new(1)),
            ready_tx: Some(ready_tx),
            drain: CancellationToken::new(),
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
                mailbox: mailbox_tx,
            },
            task,
        )
    }

    pub fn cancel(&self) {
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
        self.workers.cancel_and_join().await?
    }
}

pub struct OwnerRuntimeHandle<Command, Query = std::convert::Infallible> {
    id: OwnerRuntimeId,
    drain: CancellationToken,
    mailbox: mpsc::Sender<Mailbox<Command, Query>>,
}

impl<Command, Query> Clone for OwnerRuntimeHandle<Command, Query> {
    fn clone(&self) -> Self {
        Self {
            id: self.id,
            drain: self.drain.clone(),
            mailbox: self.mailbox.clone(),
        }
    }
}

impl<Command, Query> OwnerRuntimeHandle<Command, Query> {
    pub fn id(&self) -> OwnerRuntimeId {
        self.id
    }

    pub async fn command(&self, command: Command) -> Result<(), SendError> {
        self.send_command(command).await
    }

    pub async fn send(&self, command: Command) -> Result<(), SendError> {
        self.send_command(command).await
    }

    pub async fn send_command(&self, command: Command) -> Result<(), SendError> {
        self.send_message(Mailbox::Command(command)).await
    }

    pub fn try_command(&self, command: Command) -> Result<(), SendError> {
        self.try_send_command(command)
    }

    pub fn try_send(&self, command: Command) -> Result<(), SendError> {
        self.try_send_command(command)
    }

    pub fn try_send_command(&self, command: Command) -> Result<(), SendError> {
        self.try_send_message(Mailbox::Command(command))
    }

    pub async fn query(&self, query: Query) -> Result<(), SendError> {
        self.send_query(query).await
    }

    pub async fn send_query(&self, query: Query) -> Result<(), SendError> {
        self.send_message(Mailbox::Query(query)).await
    }

    pub fn try_query(&self, query: Query) -> Result<(), SendError> {
        self.try_send_query(query)
    }

    pub fn try_send_query(&self, query: Query) -> Result<(), SendError> {
        self.try_send_message(Mailbox::Query(query))
    }

    async fn send_message(&self, message: Mailbox<Command, Query>) -> Result<(), SendError> {
        tokio::select! {
            biased;
            _ = self.drain.cancelled() => Err(SendError::Closed),
            result = self.mailbox.send(message) => result.map_err(|_| SendError::Closed),
        }
    }

    fn try_send_message(&self, message: Mailbox<Command, Query>) -> Result<(), SendError> {
        if self.drain.is_cancelled() {
            return Err(SendError::Closed);
        }
        self.mailbox.try_send(message).map_err(map_try_send_error)
    }

    pub fn is_closed(&self) -> bool {
        self.drain.is_cancelled() || self.mailbox.is_closed()
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
    loop {
        let runnable = tokio::select! {
            _ = cancellation.cancelled() => None,
            runnable = recv_runnable(Arc::clone(&ready_rx)) => runnable,
        };
        let Some(runnable) = runnable else {
            break;
        };
        runnable.work.await;
    }
}

async fn recv_runnable(ready_rx: Arc<Mutex<mpsc::Receiver<Runnable>>>) -> Option<Runnable> {
    let mut ready_rx = ready_rx.lock().await;
    ready_rx.recv().await
}

enum Mailbox<Command, Query> {
    Command(Command),
    Query(Query),
}

enum LaneItem<O: OwnerSpec> {
    Command(O::Command),
    Query(O::Query),
}

enum GlobalItem<O: OwnerSpec> {
    Command(O::Command),
    Query(O::Query),
}

enum ExclusiveItem<O: OwnerSpec> {
    Command(O::Command),
    Query(O::Query),
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
        CommandRoute::Keyed(key) => observe_owner_runtime::<O>(
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
    queue: VecDeque<LaneItem<O>>,
    running: bool,
    cancellation: Option<CancellationToken>,
    idle_since: Option<Instant>,
}

struct OwnerRuntimeSlot<O: OwnerSpec> {
    id: OwnerRuntimeId,
    shared: O::Shared,
    global_state: Option<O::GlobalState>,
    global_queue: VecDeque<GlobalItem<O>>,
    global_running: bool,
    global_cancellation: Option<CancellationToken>,
    exclusive_queue: VecDeque<ExclusiveItem<O>>,
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
    completion_tx: mpsc::UnboundedSender<Completion<O>>,
    completion_rx: mpsc::UnboundedReceiver<Completion<O>>,
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
        completion_tx: mpsc::UnboundedSender<Completion<O>>,
        completion_rx: mpsc::UnboundedReceiver<Completion<O>>,
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
            closing: false,
        }
    }

    async fn run(
        mut self,
        mut mailbox_rx: mpsc::Receiver<Mailbox<O::Command, O::Query>>,
        cancellation: CancellationToken,
        drain: CancellationToken,
    ) {
        let mut mailbox_open = true;
        let mut draining = false;
        let mut pending = None;
        let mut eviction_interval = tokio::time::interval(Duration::from_secs(5));
        eviction_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            if self.closing {
                pending = None;
                mailbox_open = false;
                mailbox_rx.close();
            }
            if (self.closing || (!mailbox_open && pending.is_none())) && self.can_shutdown() {
                break;
            }

            self.dispatch_ready().await;

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

                _ = drain.cancelled(), if !draining && !self.closing => {
                    draining = true;
                    mailbox_rx.close();
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
        message: Mailbox<O::Command, O::Query>,
    ) -> Result<(), Mailbox<O::Command, O::Query>> {
        match message {
            Mailbox::Command(command) => {
                let route = O::route_command(&command);
                observe_command_route::<O>(&self.observation, self.id, &route);
                match route {
                    CommandRoute::Keyed(key) => self
                        .enqueue_keyed(key, LaneItem::Command(command))
                        .map_err(lane_item_to_mailbox),
                    CommandRoute::Global => self
                        .enqueue_global(GlobalItem::Command(command))
                        .map_err(global_item_to_mailbox),
                    CommandRoute::Exclusive => self
                        .enqueue_exclusive(ExclusiveItem::Command(command))
                        .map_err(exclusive_item_to_mailbox),
                    CommandRoute::Shutdown => self
                        .enqueue_exclusive(ExclusiveItem::Shutdown(command))
                        .map_err(exclusive_item_to_mailbox),
                }
            }
            Mailbox::Query(query) => {
                let route = O::route_query(&query);
                observe_query_route::<O>(&self.observation, self.id, &route);
                match route {
                    QueryRoute::Direct => {
                        self.dispatch_direct_query(query).await;
                        Ok(())
                    }
                    QueryRoute::Keyed(key) => self
                        .enqueue_keyed(key, LaneItem::Query(query))
                        .map_err(lane_item_to_mailbox),
                    QueryRoute::Global => self
                        .enqueue_global(GlobalItem::Query(query))
                        .map_err(global_item_to_mailbox),
                    QueryRoute::Exclusive => self
                        .enqueue_exclusive(ExclusiveItem::Query(query))
                        .map_err(exclusive_item_to_mailbox),
                }
            }
        }
    }

    fn enqueue_keyed(&mut self, key: O::Key, item: LaneItem<O>) -> Result<(), LaneItem<O>> {
        let item_kind = lane_item_observation_item(&item);
        let lane = self.lanes.entry(key.clone()).or_insert_with(|| Lane {
            state: Some(O::open_lane(&self.shared, &key)),
            queue: VecDeque::new(),
            running: false,
            cancellation: None,
            idle_since: None,
        });
        if lane.queue.len() >= self.lane_queue_capacity {
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

    fn enqueue_global(&mut self, item: GlobalItem<O>) -> Result<(), GlobalItem<O>> {
        let item_kind = global_item_observation_item(&item);
        if self.global_queue.len() >= self.global_queue_capacity {
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

    fn enqueue_exclusive(&mut self, item: ExclusiveItem<O>) -> Result<(), ExclusiveItem<O>> {
        let item_kind = exclusive_item_observation_item(&item);
        let route = exclusive_item_observation_route(&item);
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

    async fn dispatch_direct_query(&mut self, query: O::Query) {
        let id = self.next_direct_id;
        self.next_direct_id = self.next_direct_id.wrapping_add(1);
        let cancellation = CancellationToken::new();
        self.direct_running.insert(id, cancellation.clone());
        self.send_work(
            OwnerRuntimeItem::Query,
            OwnerRuntimeRoute::Direct,
            None,
            Work::DirectQuery {
                id,
                query,
                cancellation,
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
        let Some(state) = lane.state.take() else {
            return;
        };
        let Some(item) = lane.queue.pop_front() else {
            lane.state = Some(state);
            return;
        };
        let cancellation = CancellationToken::new();
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
                query,
                cancellation,
            },
        };
        self.send_work(item_kind, OwnerRuntimeRoute::Keyed, key_hash, work)
            .await;
    }

    async fn dispatch_global_if_ready(&mut self) {
        if self.global_running || self.global_queue.is_empty() {
            return;
        }
        let Some(state) = self.global_state.take() else {
            return;
        };
        let Some(item) = self.global_queue.pop_front() else {
            self.global_state = Some(state);
            return;
        };
        let cancellation = CancellationToken::new();
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
                query,
                cancellation,
            },
        };
        self.send_work(item_kind, OwnerRuntimeRoute::Global, None, work)
            .await;
    }

    async fn dispatch_exclusive_if_ready(&mut self) {
        if self.exclusive_running
            || self.exclusive_queue.is_empty()
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
        let Some(item) = self.exclusive_queue.pop_front() else {
            self.global_state = Some(state);
            return;
        };
        let cancellation = CancellationToken::new();
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
                query,
                cancellation,
            },
        };
        self.send_work(item_kind, route, None, work).await;
    }

    async fn send_work(
        &mut self,
        item: OwnerRuntimeItem,
        route: OwnerRuntimeRoute,
        key_hash: Option<u64>,
        work: Work<O>,
    ) {
        let Some(ready_tx) = &self.ready_tx else {
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
            return;
        };
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
        let runnable = Runnable {
            work: work.boxed(
                self.id,
                self.shared.clone(),
                self.observation.clone(),
                item,
                route,
                key_hash,
                self.completion_tx.clone(),
            ),
        };
        if ready_tx.send(runnable).await.is_err() {
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
        }
    }

    fn complete(&mut self, completion: Completion<O>) {
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
    }

    fn exclusive_blocks_mailbox(&self) -> bool {
        self.exclusive_running || !self.exclusive_queue.is_empty()
    }

    fn evict_idle_lanes(&mut self) {
        if self.idle_timeout.is_zero() {
            self.lanes
                .retain(|_, lane| lane.running || !lane.queue.is_empty());
            return;
        }
        let now = Instant::now();
        let idle_timeout = self.idle_timeout;
        self.lanes.retain(|_, lane| {
            lane.running
                || !lane.queue.is_empty()
                || lane
                    .idle_since
                    .is_none_or(|idle_since| now.duration_since(idle_since) < idle_timeout)
        });
    }

    fn begin_shutdown(&mut self) {
        self.closing = true;
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
        self.direct_running.is_empty()
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
        LaneItem::Command(command) => Mailbox::Command(command),
        LaneItem::Query(query) => Mailbox::Query(query),
    }
}

fn global_item_to_mailbox<O: OwnerSpec>(item: GlobalItem<O>) -> Mailbox<O::Command, O::Query> {
    match item {
        GlobalItem::Command(command) => Mailbox::Command(command),
        GlobalItem::Query(query) => Mailbox::Query(query),
    }
}

fn exclusive_item_to_mailbox<O: OwnerSpec>(
    item: ExclusiveItem<O>,
) -> Mailbox<O::Command, O::Query> {
    match item {
        ExclusiveItem::Command(command) | ExclusiveItem::Shutdown(command) => {
            Mailbox::Command(command)
        }
        ExclusiveItem::Query(query) => Mailbox::Query(query),
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
        completion_tx: mpsc::UnboundedSender<Completion<O>>,
    ) -> RuntimeWork {
        Box::pin(async move {
            match self {
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
                        O::handle_direct_query(shared, query),
                    )
                    .await;
                    let _ = completion_tx.send(Completion::Direct { id, failed });
                }
                Self::KeyedCommand {
                    key,
                    mut state,
                    command,
                    cancellation,
                } => {
                    let failed = run_observed_handler::<O, _>(
                        &observation,
                        owner_id,
                        item,
                        route,
                        key_hash,
                        &cancellation,
                        O::handle_keyed_command(shared, key.clone(), &mut state, command),
                    )
                    .await;
                    let _ = completion_tx.send(Completion::Keyed { key, state, failed });
                }
                Self::KeyedQuery {
                    key,
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
                        O::handle_keyed_query(shared, key.clone(), &mut state, query),
                    )
                    .await;
                    let _ = completion_tx.send(Completion::Keyed { key, state, failed });
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
                        O::handle_global_command(shared, &mut state, command),
                    )
                    .await;
                    let _ = completion_tx.send(Completion::Global {
                        state,
                        failed,
                        close_after,
                    });
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
                        O::handle_global_query(shared, &mut state, query),
                    )
                    .await;
                    let _ = completion_tx.send(Completion::Global {
                        state,
                        failed,
                        close_after: false,
                    });
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
                        O::handle_exclusive_query(shared, &mut state, query),
                    )
                    .await;
                    let _ = completion_tx.send(Completion::Exclusive { state, failed });
                }
            }
        })
    }
}
