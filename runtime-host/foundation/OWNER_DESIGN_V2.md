# Foundation Owner v2 设计：支持内部事件流

## 问题陈述

当前 Owner trait 只支持单一命令流的串行处理：

```rust
trait Owner {
    type Command;
    async fn handle_command(&mut self, command: Self::Command);
}
```

**局限性**：
1. 慢 IO 操作会阻塞整个 mailbox
2. 无法支持后台任务完成通知
3. 无法实现按 key 分区的并发控制

**典型场景**（ChannelOwner）：
- 多个 channel 的登录操作应该并发执行
- 同一个 channel 的操作必须串行
- 后台操作完成后需要通知 owner 处理下一个排队请求

## 设计方案

### 1. 扩展 Owner Trait

```rust
/// Owner 可以声明内部事件类型，用于接收后台任务的完成通知
pub trait Owner: Send + 'static {
    /// 外部命令类型（来自 Handle）
    type Command: Send;
    
    /// 内部事件类型（来自后台任务），默认为 Never（无内部事件）
    type InternalEvent: Send = Never;
    
    /// 初始化，接收自己的 handle（可选：发送命令给自己）
    fn set_handle(&mut self, handle: OwnerHandle<Self::Command>) {
        let _ = handle; // 默认不需要
    }
    
    /// 返回内部事件接收器（可选）
    /// 
    /// 如果返回 Some，框架会在 select! loop 中同时监听命令和内部事件
    /// 内部事件优先级更高（biased select），确保及时处理完成通知
    fn take_internal_events(&mut self) -> Option<mpsc::Receiver<Self::InternalEvent>> {
        None
    }
    
    /// 处理外部命令
    async fn handle_command(&mut self, command: Self::Command);
    
    /// 处理内部事件
    /// 
    /// 只有在 take_internal_events() 返回 Some 时才会被调用
    /// 默认实现：panic（如果声明了内部事件但未实现此方法）
    async fn handle_internal_event(&mut self, event: Self::InternalEvent) {
        let _ = event;
        panic!("Owner declared internal events but didn't implement handle_internal_event");
    }
}

/// 永不类型，用作默认的内部事件类型
pub enum Never {}
```

### 2. 增强的 spawn_owner

```rust
pub fn spawn_owner<O>(
    mut owner: O,
    command_capacity: usize,
) -> (OwnerHandle<O::Command>, JoinHandle<()>)
where
    O: Owner,
{
    let (cmd_tx, mut cmd_rx) = mpsc::channel(command_capacity);
    let handle = OwnerHandle::new(cmd_tx);
    
    // 1. 设置 handle（让 owner 可以发送命令给自己）
    owner.set_handle(handle.clone());
    
    // 2. 获取内部事件接收器
    let internal_rx = owner.take_internal_events();
    
    // 3. 根据是否有内部事件，选择不同的运行模式
    let join = if let Some(mut internal_rx) = internal_rx {
        // 双通道模式：同时监听命令和内部事件
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased; // 优先处理内部事件
                    Some(event) = internal_rx.recv() => {
                        owner.handle_internal_event(event).await;
                    }
                    Some(cmd) = cmd_rx.recv() => {
                        owner.handle_command(cmd).await;
                    }
                    else => break,
                }
            }
        })
    } else {
        // 简单模式：只处理命令
        tokio::spawn(async move {
            while let Some(cmd) = cmd_rx.recv().await {
                owner.handle_command(cmd).await;
            }
        })
    };
    
    (handle, join)
}
```

### 3. ChannelOwner 使用示例

```rust
/// 内部事件：后台操作完成通知
enum ChannelInternalEvent {
    MutationCompleted {
        key: ChannelKey,
        correlation: u64,
        effect: ChannelMutationEffect,
    },
}

struct ChannelOwner {
    // 状态
    processing: HashMap<ChannelKey, ProcessingMutation>,
    pending: HashMap<ChannelKey, VecDeque<QueuedMutation>>,
    
    // 内部事件通道
    completion_tx: mpsc::Sender<ChannelInternalEvent>,
    completion_rx: Option<mpsc::Receiver<ChannelInternalEvent>>,
    
    // 端口
    mutation_port: Arc<dyn ChannelMutationPort>,
}

impl Owner for ChannelOwner {
    type Command = ChannelCommand;
    type InternalEvent = ChannelInternalEvent;
    
    fn take_internal_events(&mut self) -> Option<mpsc::Receiver<Self::InternalEvent>> {
        self.completion_rx.take()
    }
    
    async fn handle_command(&mut self, command: Self::Command) {
        match command {
            ChannelCommand::Configure { key, values, reply } => {
                // 检查该 key 是否有进行中的操作
                if self.processing.contains_key(&key) {
                    // 排队等待
                    self.pending.entry(key).or_default().push_back(QueuedMutation {
                        mutation: ChannelMutation::Configure { values },
                        reply: MutationReply::Configure(reply),
                    });
                } else {
                    // 启动后台操作
                    self.start_mutation(key, values, reply).await;
                }
            }
            // ... 其他命令
        }
    }
    
    async fn handle_internal_event(&mut self, event: Self::InternalEvent) {
        match event {
            ChannelInternalEvent::MutationCompleted { key, correlation, effect } => {
                // 1. 结算当前操作
                self.settle_mutation(&key, correlation, effect);
                
                // 2. 启动该 key 的下一个排队操作（如果有）
                if let Some(next) = self.pending.get_mut(&key).and_then(|q| q.pop_front()) {
                    self.start_next_mutation(key, next).await;
                } else {
                    // 该 key 没有待处理操作了
                    self.processing.remove(&key);
                }
            }
        }
    }
}

impl ChannelOwner {
    async fn start_mutation(&mut self, key: ChannelKey, values: Vec<u8>, reply: oneshot::Sender<_>) {
        let correlation = self.next_correlation();
        
        // 记录为进行中
        self.processing.insert(key.clone(), ProcessingMutation { correlation });
        
        // 启动后台任务
        let mutation_port = self.mutation_port.clone();
        let completion_tx = self.completion_tx.clone();
        let key_clone = key.clone();
        
        tokio::spawn(async move {
            // 执行慢 IO
            let effect = mutation_port.execute(key, ChannelMutation::Configure { values }).await;
            
            // 发送完成通知到内部事件流
            let _ = completion_tx.send(ChannelInternalEvent::MutationCompleted {
                key: key_clone,
                correlation,
                effect,
            }).await;
            
            // 回复给调用者
            let _ = reply.send(extract_configure_outcome(effect));
        });
    }
}
```

## 关键优势

### 1. **清晰的职责分离**
- **外部命令**：来自 Handle，用户发起的操作
- **内部事件**：来自后台任务，完成通知和状态更新

### 2. **类型安全的并发控制**
```rust
// 编译时确定事件类型
type InternalEvent = ChannelInternalEvent;

// 无法发送错误的事件类型
completion_tx.send(WrongEvent).await; // ❌ 编译错误
```

### 3. **Framework 管理并发**
```rust
// Owner 不需要自己写 select! loop
tokio::select! {
    biased; // Foundation 确保内部事件优先
    Some(event) = internal_rx.recv() => { /* ... */ }
    Some(cmd) = cmd_rx.recv() => { /* ... */ }
}
```

### 4. **向后兼容**
```rust
// 简单 Owner 不需要改动
impl Owner for SimpleOwner {
    type Command = SimpleCommand;
    // InternalEvent 默认为 Never
    // take_internal_events() 默认返回 None
    
    async fn handle_command(&mut self, cmd: Self::Command) {
        // ... 直接处理
    }
}
```

### 5. **灵活的并发模型**

**按 Key 分区并发**（ChannelOwner）：
- 不同 key 的操作并发执行
- 同一 key 的操作串行执行
- 完成通知触发下一个排队操作

**全局并发 + 结算**（假设的 DatabaseOwner）：
- 所有写操作并发执行
- 完成后更新内存缓存
- 读操作访问缓存，不阻塞

**Pipeline 模式**：
- 命令启动多个阶段的后台任务
- 每个阶段完成发送内部事件
- Owner 协调各阶段的状态转移

## 实现注意事项

### 1. Biased Select
```rust
tokio::select! {
    biased; // 确保内部事件优先处理
    Some(event) = internal_rx.recv() => { /* ... */ }
    Some(cmd) = cmd_rx.recv() => { /* ... */ }
}
```
**原因**：避免命令积压导致完成通知得不到及时处理

### 2. Channel 容量设计
```rust
let (completion_tx, completion_rx) = mpsc::channel(INTERNAL_EVENT_CAPACITY);
```
建议：
- 命令 channel：64-256（用户请求速率）
- 内部事件 channel：256-1024（后台任务完成速率可能更高）

### 3. 取消处理
```rust
impl ChannelOwner {
    async fn handle_command(&mut self, command: ChannelCommand) {
        match command {
            ChannelCommand::LoginCancel { key, reply } => {
                // 1. 取消后台任务（通过 CancellationToken）
                if let Some(processing) = self.processing.get_mut(&key) {
                    processing.cancel_token.cancel();
                }
                
                // 2. 清空该 key 的排队操作
                self.pending.remove(&key);
                
                // 3. 内部事件到来时检查是否已取消
            }
        }
    }
    
    async fn handle_internal_event(&mut self, event: ChannelInternalEvent) {
        match event {
            ChannelInternalEvent::MutationCompleted { key, correlation, .. } => {
                // 检查 correlation 是否匹配（可能已被取消）
                if let Some(proc) = self.processing.get(&key) {
                    if proc.correlation == correlation && !proc.cancel_token.is_cancelled() {
                        // 正常处理
                    }
                }
            }
        }
    }
}
```

### 4. 错误处理
```rust
// 后台任务中的错误通过内部事件报告
tokio::spawn(async move {
    let result = perform_operation().await;
    let event = match result {
        Ok(data) => InternalEvent::Success { key, data },
        Err(e) => InternalEvent::Failed { key, error: e.into() },
    };
    let _ = completion_tx.send(event).await;
});
```

## 迁移路径

### Phase 1: 扩展 Foundation
1. 添加 `InternalEvent` 关联类型到 `Owner` trait
2. 添加 `take_internal_events()` 和 `handle_internal_event()` 方法
3. 修改 `spawn_owner` 支持双通道模式

### Phase 2: 迁移 ChannelOwner
1. 定义 `ChannelInternalEvent` 枚举
2. 将 `completions` channel 转换为内部事件
3. 实现 `take_internal_events()` 和 `handle_internal_event()`
4. 测试验证：同一 key 串行，不同 key 并发

### Phase 3: 其他需要的 Owner
- FleetOwner：Fleet 操作的异步完成通知
- OrganizationOwner：TeamRun 执行状态更新
- 保持简单 Owner 不变（SessionOwner, ProviderOwner, etc.）

## 对比其他方案

### 为什么不用自引用命令？
```rust
enum ChannelCommand {
    Configure { /* ... */ },
    Internal(InternalCompletion), // ❌ 暴露内部实现
}
```
**问题**：
- 污染公共命令类型
- 外部可能错误发送内部命令
- 类型系统无法区分

### 为什么不让 Owner 自己管理 select!？
```rust
trait Owner {
    async fn run_loop(&mut self, commands: Receiver<Command>) {
        // Owner 自己写 select!
    }
}
```
**问题**：
- 失去 Framework 的统一控制
- 每个 Owner 重复实现 select! 逻辑
- 难以添加通用的监控、跟踪、超时等功能

### 为什么不用 Poll 模式？
```rust
trait Owner {
    async fn poll_internal(&mut self) {}
    async fn handle_command(&mut self, cmd: Command);
}
```
**问题**：
- 只在有命令时才 poll，长时间无命令时内部事件得不到处理
- 无法控制 poll 的时机和频率

## 结论

**双通道 Owner 模型**是最佳设计：
- ✅ 类型安全
- ✅ 清晰语义
- ✅ Framework 管理并发
- ✅ 向后兼容
- ✅ 支持复杂并发模型

这个设计保持了 Foundation 的简洁性（简单 Owner 不受影响），同时为需要复杂并发控制的 Owner 提供了强大而安全的机制。
