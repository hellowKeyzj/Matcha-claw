use matcha_agent::peer::SessionSubscriptionItem;
use openclaw::session::events::SessionEvent as OpenClawEvent;

use crate::sessions::state::SessionChange;
use crate::sessions::command::SourceBinding;

/// 从 OpenClaw SessionEvent 提取 session 数据用于 SessionOwner 路由。
///
/// 返回 (run_id, source_binding, epoch, cursor, changes)
pub(crate) fn extract_openclaw_session_data(
    event: &OpenClawEvent,
) -> Option<(String, SourceBinding, u64, u64, Vec<SessionChange>)> {
    // OpenClaw SessionEvent 包含：
    // - Lifecycle(LifecycleEvent) - 生命周期事件
    // - SessionUpdate(SessionUpdate) - session 更新
    // - Activity { route_key, activity, provenance }

    // 从 provenance 提取元数据
    let provenance = match event {
        OpenClawEvent::Lifecycle(lifecycle) => lifecycle.provenance(),
        OpenClawEvent::SessionUpdate(update) => update.provenance(),
        OpenClawEvent::Activity { provenance, .. } => provenance.as_ref(),
    };

    let provenance = provenance?;
    let run_id = provenance.run_id()?.to_string();
    let epoch = provenance.source_epoch()?;
    let cursor = provenance.source_cursor()?;
    let endpoint_session_id = provenance.session_key()?.to_string();

    let source_binding = SourceBinding {
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint::OpenClaw,
        endpoint_session_id,
    };

    // 提取 changes
    let changes = extract_changes_from_openclaw(event)?;

    Some((run_id, source_binding, epoch, cursor, changes))
}

/// 从 Matcha SessionSubscriptionItem 提取 session 数据用于 SessionOwner 路由。
///
/// 返回 (run_id, source_binding, epoch, cursor, changes)
pub(crate) fn extract_matcha_session_data(
    item: &SessionSubscriptionItem,
) -> Option<(String, SourceBinding, u64, u64, Vec<SessionChange>)> {
    match item {
        SessionSubscriptionItem::Event(envelope) => {
            let run_id = envelope.run_id().to_string();
            let cursor = envelope.source_cursor();
            let epoch = envelope.source_epoch()?;
            let endpoint_session_id = envelope.session_key().to_string();

            let source_binding = SourceBinding {
                endpoint: platform::endpoint::runtime_address::RuntimeEndpoint::Matcha,
                endpoint_session_id,
            };

            // 从 RendererEvent 提取 changes
            let changes = extract_changes_from_matcha_event(envelope)?;

            Some((run_id, source_binding, epoch, cursor, changes))
        }
        SessionSubscriptionItem::Recovery { .. } => {
            // Recovery 事件由其他路径处理
            None
        }
    }
}

fn extract_changes_from_openclaw(_event: &OpenClawEvent) -> Option<Vec<SessionChange>> {
    // OpenClaw native events 不转换为 SessionChange
    // SessionOwner 只记录 cursor/epoch，不解析 native payload
    // OpenClaw 的 session facts 由 RuntimeDriver 维护
    Some(Vec::new())
}

fn extract_changes_from_matcha_event(
    _envelope: &matcha_agent::peer::RendererEventEnvelope,
) -> Option<Vec<SessionChange>> {
    // Matcha native events 不转换为 SessionChange
    // SessionOwner 只记录 cursor/epoch，不解析 native payload
    // Matcha 的 session facts 由 RuntimeDriver 维护
    Some(Vec::new())
}
