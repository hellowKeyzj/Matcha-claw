use crate::model::*;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) fn operation(operation: &BoardOperation) -> Result<(), BoardFailure> {
    let valid = match operation {
        BoardOperation::Get {} => true,
        BoardOperation::Update { ops } => ops.iter().all(op),
        BoardOperation::WidgetPut {
            name: widget_name,
            title,
            content,
            placement,
            declared,
            generated_identity,
            ..
        } => {
            name(widget_name)
                && title.as_ref().is_none_or(|title| text(title, 1, 80))
                && put_content(content)
                && placement.as_ref().is_none_or(|placement| {
                    placement.tab_id.as_ref().is_none_or(|id| tab_id(id))
                        && placement.after.as_ref().is_none_or(|after| name(after))
                })
                && declared.as_ref().is_none_or(declaration)
                && generated_identity
                    .as_ref()
                    .is_none_or(|identity| hex(&identity.key, 64) && name(&identity.fallback_name))
        }
        BoardOperation::WidgetGrant {
            name: widget_name,
            revision,
            instance_id,
            ..
        }
        | BoardOperation::WidgetAppView {
            name: widget_name,
            revision,
            instance_id,
        } => name(widget_name) && positive(*revision) && !instance_id.is_empty(),
        BoardOperation::Event {
            widget,
            ticket: view_ticket,
            ..
        } => match (widget, view_ticket) {
            (Some(widget), None) => name(widget),
            (None, Some(view_ticket)) => ticket(view_ticket),
            _ => false,
        },
        BoardOperation::PromptAuthorize {
            ticket: view_ticket,
        } => ticket(view_ticket),
        BoardOperation::DataRead {
            ticket: view_ticket,
            binding_id,
            params,
        } => {
            ticket(view_ticket)
                && text(binding_id, 1, 64)
                && params.as_ref().is_none_or(capability_params)
        }
        BoardOperation::Action {
            ticket: view_ticket,
            action,
            job_id,
            params,
        } => {
            ticket(view_ticket)
                && match job_id {
                    Some(job_id) => {
                        action == "cron.trigger" && text(job_id, 1, 256) && params.is_none()
                    }
                    None => text(action, 1, 269) && params.as_ref().is_none_or(capability_params),
                }
        }
    };
    valid.then_some(()).ok_or(BoardFailure::Invalid)
}

pub(crate) fn result(result: &BoardResult) -> Result<(), BoardFailure> {
    let valid = match result {
        BoardResult::Snapshot(snapshot) => snapshot_fields(
            &snapshot.session_key,
            snapshot.revision,
            &snapshot.tabs,
            &snapshot.widgets,
        ),
        BoardResult::WidgetPut(result) => {
            name(&result.resolved_widget_name)
                && snapshot_fields(
                    &result.session_key,
                    result.revision,
                    &result.tabs,
                    &result.widgets,
                )
        }
        BoardResult::AppView(view) => !view.view_id.is_empty() && safe(view.expires_at_ms),
        BoardResult::Event(event) => event.ok,
        BoardResult::PromptAuthorization(_) | BoardResult::Data(_) | BoardResult::Action(_) => true,
    };
    valid.then_some(()).ok_or(BoardFailure::Unknown)
}

pub(crate) fn event(event: &BoardEvent) -> Result<(), BoardFailure> {
    let valid = match event {
        BoardEvent::Changed(event) => {
            safe(event.revision) && event.widget.as_ref().is_none_or(|widget| name(widget))
        }
        BoardEvent::Command(event) => match &event.command {
            BoardCommand::FocusTab { tab_id: id } => tab_id(id),
            BoardCommand::SetChatDock { .. } => true,
        },
    };
    valid.then_some(()).ok_or(BoardFailure::Invalid)
}

fn op(op: &BoardOp) -> bool {
    match op {
        BoardOp::TabCreate {
            tab_id: id, title, ..
        } => tab_id(id) && text(title, 1, 80),
        BoardOp::TabUpdate {
            tab_id: id,
            title,
            position,
            ..
        } => {
            tab_id(id)
                && title.as_ref().is_none_or(|title| text(title, 1, 80))
                && position.is_none_or(safe)
        }
        BoardOp::TabDelete { tab_id: id } => tab_id(id),
        BoardOp::TabsReorder { tab_ids } => tab_ids.iter().all(|id| tab_id(id)),
        BoardOp::WidgetMove {
            name: widget_name,
            tab_id: id,
            position,
            after,
        } => {
            name(widget_name)
                && id.as_ref().is_none_or(|id| tab_id(id))
                && position.is_none_or(safe)
                && after.as_ref().is_none_or(|after| name(after))
        }
        BoardOp::WidgetResize {
            name: widget_name,
            size_w,
            size_h,
            ..
        } => {
            name(widget_name)
                && size_w.unsigned_abs() <= MAX_SAFE_INTEGER
                && size_h.unsigned_abs() <= MAX_SAFE_INTEGER
        }
        BoardOp::WidgetRemove { name: widget_name } => name(widget_name),
    }
}

fn put_content(content: &BoardWidgetPutContent) -> bool {
    match content {
        BoardWidgetPutContent::Html { html } => text(html, 0, 262_144),
        BoardWidgetPutContent::McpApp { view_id } => !view_id.is_empty(),
        BoardWidgetPutContent::CanvasDoc { doc_id } => !doc_id.is_empty(),
        BoardWidgetPutContent::Plugin {
            plugin_kind: kind, ..
        } => plugin_kind(kind),
        BoardWidgetPutContent::Registered {
            content_kind: kind,
            source,
        } => content_kind(kind) && text(source, 0, 262_144),
    }
}

fn snapshot_fields(
    session_key: &str,
    revision: u64,
    tabs: &[BoardTab],
    widgets: &[BoardWidget],
) -> bool {
    !session_key.is_empty()
        && safe(revision)
        && tabs
            .iter()
            .all(|tab| tab_id(&tab.tab_id) && text(&tab.title, 1, 80) && safe(tab.position))
        && widgets.iter().all(widget)
}

fn widget(widget: &BoardWidget) -> bool {
    name(&widget.name)
        && tab_id(&widget.tab_id)
        && widget.title.as_ref().is_none_or(|title| text(title, 1, 80))
        && widget
            .registered_content_kind
            .as_ref()
            .is_none_or(|kind| content_kind(kind))
        && widget
            .plugin_kind
            .as_ref()
            .is_none_or(|kind| plugin_kind(kind))
        && (1..=12).contains(&widget.size_w)
        && (1..=20).contains(&widget.size_h)
        && safe(widget.position)
        && positive(widget.revision)
        && widget
            .instance_id
            .as_ref()
            .is_none_or(|instance| !instance.is_empty())
        && widget.declared.as_ref().is_none_or(declaration)
        && widget.view_ticket_ttl_ms.is_none_or(positive)
        && widget
            .view_generation
            .as_ref()
            .is_none_or(|generation| hex(generation, 32))
        && widget.sandbox_port.is_none_or(|port| port > 0)
        && widget
            .kind_label
            .as_ref()
            .is_none_or(|label| text(label, 1, 80))
}

fn declaration(declared: &BoardWidgetDeclared) -> bool {
    declared.net_origins.as_ref().is_none_or(|origins| {
        origins.len() <= 32 && origins.iter().all(|origin| text(origin, 1, 2048))
    }) && declared
        .tools
        .as_ref()
        .is_none_or(|tools| tools.len() <= 64 && tools.iter().all(|tool| text(tool, 1, 269)))
}

fn capability_params(params: &BoardParams) -> bool {
    params.len() <= 64 && params.keys().all(|key| text(key, 1, 80))
}
fn text(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.chars().count())
}
fn ticket(value: &str) -> bool {
    text(value, 1, 2048)
}
fn safe(value: u64) -> bool {
    value <= MAX_SAFE_INTEGER
}
fn positive(value: u64) -> bool {
    value > 0 && safe(value)
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn tab_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
}
fn content_kind(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
fn plugin_kind(value: &str) -> bool {
    let Some((plugin, kind)) = value.split_once(':') else {
        return false;
    };
    !plugin.is_empty()
        && plugin.len() <= 64
        && plugin.as_bytes()[0].is_ascii_alphanumeric()
        && plugin
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && name(kind)
}
