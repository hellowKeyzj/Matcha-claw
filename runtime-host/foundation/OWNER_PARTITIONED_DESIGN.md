# Foundation Owner 分区并发设计

## 问题

简单的串行 Owner 模式存在问题：
1. **直接 await 慢 IO**：阻塞整个 mailbox，后续所有命令排队等待
2. **spawn 后台执行**：无法保证串行一致性，可能乱序

## 解决方案：分区并发

**核心思想**：
- 不同分区键的命令可以并发执行
- 相同分区键的命令必须串行执行
- 类似于数据库的行锁：不同行并发，同一行串行

## API 设计

```rust
pub trait PartitionedOwner: Send + Sized + 'static {
    type Command: Send + 'static;
    type Key: Eq + Hash + Clone + Send + 'static;
    
    /// 提取命令的分区键
    /// 
    /// - Some(key): 该命令需要按 key 串行化
    /// - None: 该命令不需要串行化（可以立即并发执行）
    fn partition_key(&self, command: &Self::Command) -> Option<Self::Key>;
    
    /// 处理命令（可能是慢 IO）
    async fn handle_command(&mut self, command: Self::Command);
    
    /// 可选：graceful shutdown
    fn shutdown(self) -> impl Future<Output = ()> + Send {
        async {}
    }
}

pub struct PartitionedOwnerHandle<Cmd> {
    sender: mpsc::Sender<Cmd>,
}

/// 启动分区并发 owner
pub fn spawn_partitioned_owner<O: PartitionedOwner>(
    owner: O,
    capacity: usize,
) -> (PartitionedOwnerHandle<O::Command>, TaskHandle<()>);
```

## 内部实现

```rust
struct PartitionedExecutor<O: PartitionedOwner> {
    owner: Arc<Mutex<O>>,
    
    // 正在执行的分区
    processing: HashMap<O::Key, TaskHandle<()>>,
    
    // 每个分区的排队命令
    pending: HashMap<O::Key, VecDeque<O::Command>>,
    
    // 完成通知 channel
    completion_tx: mpsc::Sender<Completion<O::Key>>,
    completions: mpsc::Receiver<Completion<O::Key>>,
}

struct Completion<K> {
    key: K,
}

impl<O: PartitionedOwner> PartitionedExecutor<O> {
    async fn run(mut self, mut commands: mpsc::Receiver<O::Command>) {
        loop {
            tokio::select! {
                biased;
                
                // 优先处理完成通知
                Some(completion) = self.completions.recv() => {
                    self.settle(completion).await;
                }
                
                // 接收新命令
                Some(command) = commands.recv() => {
                    self.accept(command).await;
                }
                
                else => break,
            }
        }
        
        // Graceful shutdown
        self.shutdown().await;
    }
    
    async fn accept(&mut self, command: O::Command) {
        let owner = self.owner.lock().await;
        let key = owner.partition_key(&command);
        drop(owner);
        
        match key {
            // 无分区键：立即并发执行
            None => {
                self.spawn_unpartitioned(command);
            }
            
            // 有分区键：检查是否需要排队
            Some(key) => {
                if self.processing.contains_key(&key) {
                    // 该分区正在执行，排队
                    self.pending.entry(key).or_default().push_back(command);
                } else {
                    // 该分区空闲，启动执行
                    self.start(key, command);
                }
            }
        }
    }
    
    fn start(&mut self, key: O::Key, command: O::Command) {
        let owner = Arc::clone(&self.owner);
        let completion_tx = self.completion_tx.clone();
        let key_clone = key.clone();
        
        let handle = tokio::spawn(async move {
            let mut owner = owner.lock().await;
            owner.handle_command(command).await;
            drop(owner);
            
            let _ = completion_tx.send(Completion { key: key_clone }).await;
        });
        
        self.processing.insert(key, handle.into());
    }
    
    fn spawn_unpartitioned(&self, command: O::Command) {
        let owner = Arc::clone(&self.owner);
        tokio::spawn(async move {
            let mut owner = owner.lock().await;
            owner.handle_command(command).await;
        });
    }
    
    async fn settle(&mut self, completion: Completion<O::Key>) {
        self.processing.remove(&completion.key);
        
        // 启动该分区的下一个排队命令
        if let Some(queue) = self.pending.get_mut(&completion.key) {
            if let Some(next) = queue.pop_front() {
                self.start(completion.key.clone(), next);
            }
            
            if queue.is_empty() {
                self.pending.remove(&completion.key);
            }
        }
    }
    
    async fn shutdown(mut self) {
        // 等待所有进行中的任务
        for (_, handle) in self.processing.drain() {
            let _ = handle.join().await;
        }
        
        // 丢弃所有排队的命令（或者可以选择执行它们）
        self.pending.clear();
        
        // 调用 owner 的 shutdown
        let owner = Arc::try_unwrap(self.owner)
            .ok()
            .expect("owner still has references")
            .into_inner();
        owner.shutdown().await;
    }
}
```

## SessionOwner 示例

```rust
impl PartitionedOwner for SessionOwner {
    type Command = SessionCommand;
    type Key = String;  // session_id
    
    fn partition_key(&self, command: &Self::Command) -> Option<Self::Key> {
        match command {
            // 需要按 session_id 串行化的命令
            SessionCommand::SendMessage { session_id, .. } => Some(session_id.clone()),
            SessionCommand::CreateSession { .. } => Some(command.session_id().clone()),
            SessionCommand::AbortSession { session_id, .. } => Some(session_id.clone()),
            
            // 不需要串行化的查询命令
            SessionCommand::ListSessions { .. } => None,
            SessionCommand::GetCapabilities { .. } => None,
        }
    }
    
    async fn handle_command(&mut self, command: Self::Command) {
        match command {
            SessionCommand::SendMessage { session_id, content, reply } => {
                // 可以放心 await，不会阻塞其他 session
                let result = self.ops.send_message(&session_id, content).await;
                let _ = reply.send(result);
            }
            
            SessionCommand::ListSessions { reply } => {
                // 没有分区键，会立即并发执行（不阻塞其他命令）
                let result = self.ops.list_sessions().await;
                let _ = reply.send(result);
            }
            
            // ...
        }
    }
}

// 使用
let (handle, join) = foundation::spawn_partitioned_owner(session_owner, 64);
```

## 并发行为示例

```rust
// 用户操作序列
t0: SendMessage { session_id: "A", content: "hello" }   // 100ms
t1: SendMessage { session_id: "B", content: "hi" }      // 100ms
t2: SendMessage { session_id: "A", content: "world" }   // 100ms
t3: ListSessions { }                                     // 10ms

// 执行时序：
// t0: 启动 session A 的 "hello" (spawn)
// t1: 启动 session B 的 "hi" (spawn，与 A 并发)
// t2: session A 正在执行，"world" 排队等待
// t3: 没有分区键，立即 spawn（与 A、B 并发）

// 时间线：
// 0ms:   A.hello (start)
//        B.hi (start)
//        ListSessions (start)
// 10ms:  ListSessions (完成)
// 100ms: A.hello (完成) → A.world (start)
//        B.hi (完成)
// 200ms: A.world (完成)

// 总耗时：200ms（而不是串行的 310ms）
```

## 与 ChannelOwner 对比

### ChannelOwner（手动实现）
```rust
// 优点：
// - 完全控制并发逻辑
// - 可以实现复杂的取消、优先级等

// 缺点：
// - 每个 owner 都要重复实现 processing/pending/settle 逻辑
// - 容易出 bug（见 ChannelOwner 的 900 行代码）
```

### PartitionedOwner（框架支持）
```rust
// 优点：
// - 只需实现 partition_key()，框架处理并发
// - 代码简洁，不易出错
// - 所有 owner 行为一致

// 缺点：
// - 不支持自定义取消逻辑（如 ChannelOwner 的 LoginWait 取消）
// - 不支持自定义完成处理（如 ChannelOwner 的 login finalization）
```

## 迁移策略

1. **简单 owner**：使用 `PartitionedOwner`
   - SessionOwner, ProviderOwner, FleetOwner, OrganizationOwner 等

2. **复杂 owner**：保持自定义实现
   - ChannelOwner（需要取消、login finalization 等复杂逻辑）

## 性能分析

### 理论性能

| Owner | 串行模式 | 分区并发模式 | 提升 |
|-------|---------|------------|------|
| SessionOwner | N × 100ms | 100ms（不同 session 并发） | N倍 |
| FleetOwner | N × 1s | 1s（不同 target 并发） | N倍 |
| OrganizationOwner | N × 10ms | 10ms（不同 team 并发） | N倍 |

### 实际效果

**假设**：用户同时操作 3 个 session

```
串行模式：
  SendMessage(A) → SendMessage(B) → SendMessage(C)
  100ms + 100ms + 100ms = 300ms

分区并发模式：
  SendMessage(A) ┐
  SendMessage(B) ├─ 并发执行
  SendMessage(C) ┘
  max(100ms, 100ms, 100ms) = 100ms
```

## 实现优先级

1. ✅ 实现 `PartitionedOwner` trait 和 `spawn_partitioned_owner`
2. ✅ 迁移 SessionOwner 到 `PartitionedOwner`
3. ✅ 验证性能提升
4. ✅ 迁移其他 7 个 owner
5. ⚠️ ChannelOwner 保持自定义实现

## 开放问题

1. **Mutex vs Message Passing**：
   - 当前设计用 `Arc<Mutex<Owner>>` 保护 owner 状态
   - 也可以用 message passing（owner 不需要 Mutex）
   - 权衡：Mutex 更简单，message passing 更"纯粹"

2. **背压处理**：
   - 如果某个分区积压太多命令怎么办？
   - 是否需要 per-partition 的队列容量限制？

3. **公平性**：
   - 当前实现是 FIFO per-partition
   - 是否需要跨分区的公平调度？

4. **监控**：
   - 如何暴露每个分区的队列长度、执行时间等指标？
