from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from openclaw_browser_client import OpenClawBrowserGatewayClient, OpenClawBrowserGatewayError


SUPPORTED_BROWSER_ACTIONS = {
    "open",
    "close",
    "stop",
    "start",
    "status",
    "console",
    "focus",
    "snapshot",
    "navigate",
    "profiles",
    "dialog",
    "tabs",
    "screenshot",
    "pdf",
    "upload",
    "act",
    "scroll",
    "errors",
    "requests",
    "cookies",
    "storage",
    "highlight",
    "closeagenttabs",
    "close_agent_tabs",
}

ACT_REQUEST_KINDS = {
    "select",
    "type",
    "fill",
    "close",
    "resize",
    "wait",
    "hover",
    "click",
    "press",
    "drag",
    "evaluate",
    "scroll",
    "scrollIntoView",
}

ACT_STEP_KINDS = {
    "click",
    "type",
    "fill",
    "select",
    "press",
    "hover",
    "drag",
    "scrollIntoView",
    "resize",
}

DIRECT_STEP_ACTIONS = {
    "status": "status",
    "start": "start",
    "stop": "stop",
    "profiles": "profiles",
    "tabs": "tabs",
    "open": "open",
    "navigate": "navigate",
    "snapshot": "snapshot",
    "screenshot": "screenshot",
    "pdf": "pdf",
    "upload": "upload",
    "dialog": "dialog",
    "collectRequests": "requests",
    "requests": "requests",
    "collectErrors": "errors",
    "errors": "errors",
    "collectConsole": "console",
    "console": "console",
    "readStorage": "storage",
    "writeStorage": "storage",
    "storage": "storage",
    "cookies": "cookies",
    "highlight": "highlight",
    "focus": "focus",
    "close": "close",
    "scroll": "scroll",
}

SAFE_RISKS = {"read-only", "extract", "download", "draft", "unknown", ""}
RISKY_BOUNDARY_VALUES = {
    "write",
    "upload",
    "approval",
    "destructive",
    "payment",
    "purchase",
    "social-action",
    "permission-change",
    "external-message",
    "production-write",
}
BLOCKING_EXECUTION_MODES = {"manual-confirm", "dry-run", "blocked", "not-suitable"}
SECRET_NAME_PATTERN = re.compile(r"(token|secret|password|cookie|credential|api[_-]?key|authorization)", re.IGNORECASE)
PLACEHOLDER_PATTERN = re.compile(r"\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}")
INDEX_START_PATTERN = re.compile(r"<!-- browser-flow:index:start platform=([^ >]+) -->")
INDEX_END_TEMPLATE = "<!-- browser-flow:index:end platform={platform_id} -->"
RUNTIME_REF_PATTERN = re.compile(r"^(?:ref=)?[A-Za-z_-]+-?\d+$")
RPC_TIMEOUT_PADDING_SECONDS = 2.0
MIN_RPC_TIMEOUT_SECONDS = 1.0


class BrowserFlowRunnerError(RuntimeError):
    def __init__(self, message: str, *, code: str = "runner_error", details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


class BrowserFlowBlocked(BrowserFlowRunnerError):
    pass


@dataclass(frozen=True)
class ParamSpec:
    name: str
    type: str
    required: bool = False
    default: Any = None
    enum: list[Any] | None = None
    secret: bool = False
    description: str = ""


@dataclass
class BrowserFlowAssets:
    workspace_dir: Path
    browser_flows_dir: Path
    platform_dir: Path
    platform_path: Path
    recipe_path: Path
    index_path: Path
    platform: dict[str, Any]
    recipe: dict[str, Any]
    atlas: dict[str, dict[str, Any]] = field(default_factory=dict)
    atlas_paths: dict[str, Path] = field(default_factory=dict)

    @property
    def platform_id(self) -> str:
        value = self.recipe.get("platformId") or self.platform.get("platformId") or self.platform.get("id")
        if isinstance(value, str) and value.strip():
            return value.strip()
        return self.platform_dir.name

    @property
    def recipe_id(self) -> str:
        value = self.recipe.get("recipeId") or self.recipe.get("id")
        if isinstance(value, str) and value.strip():
            return value.strip()
        raise BrowserFlowRunnerError("Recipe is missing recipeId", code="invalid_recipe")

    @property
    def capability_id(self) -> str:
        value = self.recipe.get("capabilityId")
        if isinstance(value, str) and value.strip():
            return value.strip()
        return ""


@dataclass
class RunnerContext:
    assets: BrowserFlowAssets
    params: dict[str, Any]
    param_specs: dict[str, ParamSpec]
    approve_risk: bool
    asset_update_mode: str = "execution"
    validation_smoke: bool = False
    client: OpenClawBrowserGatewayClient | None = None
    step_results: list[dict[str, Any]] = field(default_factory=list)
    blockers: list[dict[str, Any]] = field(default_factory=list)
    outputs: dict[str, Any] = field(default_factory=dict)
    unknowns: list[str] = field(default_factory=list)
    patch_suggestions: list[dict[str, Any]] = field(default_factory=list)
    applied_patches: list[dict[str, Any]] = field(default_factory=list)
    rejected_patches: list[dict[str, Any]] = field(default_factory=list)
    changed_assets: list[str] = field(default_factory=list)
    patch_status: str = "not_requested"
    post_write_back_validation: dict[str, Any] = field(default_factory=dict)
    status: str = "success"
    started_at: float = field(default_factory=time.time)

    def request_browser(self, request: dict[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
        if self.client is None:
            self.client = OpenClawBrowserGatewayClient.from_environment()
        return self.client.request(request, timeout=timeout)

    def close_browser(self) -> None:
        if self.client is None:
            return
        try:
            self.client.close()
        finally:
            self.client = None


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BrowserFlowRunnerError(f"Invalid JSON: {path}", code="invalid_json", details=str(exc)) from exc
    if not isinstance(value, dict):
        raise BrowserFlowRunnerError(f"JSON file must contain an object: {path}", code="invalid_json")
    return value


def load_assets(workspace_dir: Path, recipe_id: str, platform_id: str | None = None) -> BrowserFlowAssets:
    browser_flows_dir = workspace_dir / "browser-flows"
    platforms_dir = browser_flows_dir / "platforms"
    if not platforms_dir.is_dir():
        raise BrowserFlowRunnerError(f"Browser Flow platforms directory not found: {platforms_dir}", code="missing_assets")

    platform_dirs = [platforms_dir / platform_id] if platform_id else sorted(path for path in platforms_dir.iterdir() if path.is_dir())
    matches: list[tuple[Path, Path, dict[str, Any]]] = []
    for platform_dir in platform_dirs:
        flows_dir = platform_dir / "flows"
        if not flows_dir.is_dir():
            continue
        for recipe_path in sorted(flows_dir.glob("*.recipe.json")):
            recipe = load_json(recipe_path)
            current_id = recipe.get("recipeId") or recipe.get("id") or recipe_path.name.removesuffix(".recipe.json")
            if current_id == recipe_id or recipe_path.stem == recipe_id or recipe_path.name == recipe_id:
                matches.append((platform_dir, recipe_path, recipe))

    if not matches:
        raise BrowserFlowRunnerError(f"Recipe not found: {recipe_id}", code="recipe_not_found")
    if len(matches) > 1:
        raise BrowserFlowRunnerError(f"Recipe id is ambiguous: {recipe_id}", code="ambiguous_recipe")

    platform_dir, recipe_path, recipe = matches[0]
    platform_path = platform_dir / "platform.json"
    if not platform_path.is_file():
        raise BrowserFlowRunnerError(f"platform.json not found: {platform_path}", code="missing_platform")

    atlas: dict[str, dict[str, Any]] = {}
    atlas_paths: dict[str, Path] = {}
    atlas_dir = platform_dir / "atlas"
    if atlas_dir.is_dir():
        for atlas_path in sorted(atlas_dir.glob("**/*.json")):
            asset = load_json(atlas_path)
            asset_id = first_string(
                asset.get("capabilityId"),
                asset.get("componentId"),
                asset.get("viewId"),
                asset.get("surfaceId"),
                asset.get("entityId"),
                asset.get("contextId"),
                asset.get("id"),
                atlas_path.stem,
            )
            atlas[asset_id] = asset
            atlas_paths[asset_id] = atlas_path

    return BrowserFlowAssets(
        workspace_dir=workspace_dir,
        browser_flows_dir=browser_flows_dir,
        platform_dir=platform_dir,
        platform_path=platform_path,
        recipe_path=recipe_path,
        index_path=browser_flows_dir / "INDEX.md",
        platform=load_json(platform_path),
        recipe=recipe,
        atlas=atlas,
        atlas_paths=atlas_paths,
    )


def first_string(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def require_runtime_contract(recipe: dict[str, Any]) -> None:
    runtime = recipe.get("runtime")
    if not isinstance(runtime, dict):
        raise BrowserFlowRunnerError("Recipe is missing runtime declaration", code="invalid_runtime")
    if runtime.get("kind") != "agent-side" or runtime.get("protocol") != "agent-browser-flow-v1":
        raise BrowserFlowRunnerError("Recipe runtime must be agent-side agent-browser-flow-v1", code="invalid_runtime")
    required_actions = runtime.get("requiredBrowserActions", [])
    if not isinstance(required_actions, list) or any(not isinstance(item, str) for item in required_actions):
        raise BrowserFlowRunnerError("runtime.requiredBrowserActions must be a string array", code="invalid_runtime")
    unsupported = [action for action in required_actions if action not in SUPPORTED_BROWSER_ACTIONS]
    if unsupported:
        raise BrowserFlowRunnerError(
            "Recipe requires unsupported Browser Relay actions",
            code="unsupported_browser_action",
            details={"actions": unsupported},
        )


def normalize_param_specs(recipe: dict[str, Any]) -> dict[str, ParamSpec]:
    params = recipe.get("params") or recipe.get("inputs") or recipe.get("paramsSchema") or {}
    required_names: set[str] = set()
    properties: dict[str, Any]

    if isinstance(params, dict) and isinstance(params.get("schema"), dict):
        schema = params["schema"]
    else:
        schema = params

    if isinstance(schema, dict) and schema.get("type") == "object" and isinstance(schema.get("properties"), dict):
        properties = schema["properties"]
        required = schema.get("required", [])
        if isinstance(required, list):
            required_names = {item for item in required if isinstance(item, str)}
    elif isinstance(schema, dict):
        properties = schema
    else:
        properties = {}

    specs: dict[str, ParamSpec] = {}
    for name, raw_spec in properties.items():
        if not isinstance(name, str):
            continue
        spec = raw_spec if isinstance(raw_spec, dict) else {"type": raw_spec}
        param_type = spec.get("type") if isinstance(spec.get("type"), str) else "string"
        specs[name] = ParamSpec(
            name=name,
            type=param_type,
            required=spec.get("required") is True or name in required_names,
            default=spec.get("default"),
            enum=spec.get("enum") if isinstance(spec.get("enum"), list) else None,
            secret=spec.get("secret") is True or SECRET_NAME_PATTERN.search(name) is not None,
            description=spec.get("description") if isinstance(spec.get("description"), str) else "",
        )
    return specs


def validate_params(param_specs: dict[str, ParamSpec], supplied: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(supplied, dict):
        raise BrowserFlowRunnerError("params must be a JSON object", code="invalid_params")
    params: dict[str, Any] = {}
    for name, spec in param_specs.items():
        if name in supplied:
            value = supplied[name]
        elif spec.default is not None:
            value = spec.default
        elif spec.required:
            raise BrowserFlowRunnerError(f"Missing required param: {name}", code="missing_required_param", details={"param": name})
        else:
            continue
        validate_param_type(name, value, spec.type)
        if spec.enum is not None and value not in spec.enum:
            raise BrowserFlowRunnerError(f"Param {name} must be one of {spec.enum}", code="invalid_param_enum", details={"param": name})
        params[name] = value

    for name, value in supplied.items():
        if name not in params and name not in param_specs:
            params[name] = value
    return params


def validate_param_type(name: str, value: Any, expected_type: str) -> None:
    normalized = expected_type.lower()
    ok = False
    if normalized == "string":
        ok = isinstance(value, str)
    elif normalized == "number":
        ok = isinstance(value, (int, float)) and not isinstance(value, bool)
    elif normalized == "boolean":
        ok = isinstance(value, bool)
    elif normalized == "object":
        ok = isinstance(value, dict)
    elif normalized in {"array", "string[]"}:
        ok = isinstance(value, list) and (normalized == "array" or all(isinstance(item, str) for item in value))
    elif normalized == "number[]":
        ok = isinstance(value, list) and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value)
    elif normalized == "boolean[]":
        ok = isinstance(value, list) and all(isinstance(item, bool) for item in value)
    else:
        ok = True
    if not ok:
        raise BrowserFlowRunnerError(f"Param {name} must be {expected_type}", code="invalid_param_type", details={"param": name})


def enforce_risk_boundary(ctx: RunnerContext, step: dict[str, Any] | None = None) -> None:
    source = step if step is not None else ctx.assets.recipe
    capability = ctx.assets.atlas.get(ctx.assets.capability_id, {})
    risk = first_string(source.get("risk") if isinstance(source, dict) else None, ctx.assets.recipe.get("risk"), capability.get("risk"))
    mode = first_string(
        source.get("executionMode") if isinstance(source, dict) else None,
        ctx.assets.recipe.get("executionMode"),
        capability.get("executionMode"),
    )
    if ctx.approve_risk:
        return
    if risk in RISKY_BOUNDARY_VALUES or (risk and risk not in SAFE_RISKS):
        raise BrowserFlowBlocked(
            f"Risk boundary requires explicit approval: {risk}",
            code="risk_boundary",
            details={"risk": risk, "stepId": step_id(step)},
        )
    if mode in BLOCKING_EXECUTION_MODES:
        raise BrowserFlowBlocked(
            f"Execution mode requires explicit approval or cannot run automatically: {mode}",
            code="execution_boundary",
            details={"executionMode": mode, "stepId": step_id(step)},
        )


def execute_recipe(ctx: RunnerContext) -> dict[str, Any]:
    require_runtime_contract(ctx.assets.recipe)
    enforce_risk_boundary(ctx)
    steps = ctx.assets.recipe.get("steps")
    if not isinstance(steps, list) or not steps:
        raise BrowserFlowRunnerError("Recipe must contain a non-empty steps array", code="invalid_recipe")

    for index, raw_step in enumerate(steps):
        if not isinstance(raw_step, dict):
            raise BrowserFlowRunnerError(f"Step {index + 1} must be an object", code="invalid_step")
        step = render_templates(raw_step, ctx.params)
        execute_step(ctx, step, index)

    verify_success_criteria(ctx)
    return build_report(ctx)


def execute_step(ctx: RunnerContext, step: dict[str, Any], index: int) -> None:
    started = time.time()
    record: dict[str, Any] = {
        "id": step_id(step) or f"step-{index + 1}",
        "kind": step_kind(step),
        "status": "running",
        "startedAt": timestamp(started),
    }
    ctx.step_results.append(record)
    try:
        enforce_risk_boundary(ctx, step)
        result = dispatch_step(ctx, step, record)
        record["status"] = "success"
        if result is not None:
            record["result"] = sanitize_result(result)
    except BrowserFlowBlocked as exc:
        record["status"] = "blocked"
        record["error"] = error_payload(exc)
        ctx.blockers.append(error_payload(exc))
        ctx.status = "blocked"
        raise
    except Exception as exc:
        record["status"] = "failed"
        record["error"] = error_payload(exc)
        ctx.status = "failed"
        raise
    finally:
        record["durationMs"] = round((time.time() - started) * 1000)


def dispatch_step(ctx: RunnerContext, step: dict[str, Any], record: dict[str, Any]) -> Any:
    kind = step_kind(step)
    if not kind:
        raise BrowserFlowRunnerError("Step is missing kind", code="invalid_step")
    if kind in ACT_STEP_KINDS:
        return run_act_step(ctx, step, kind, record)
    if kind in {"waitForText", "waitForUrl", "waitForLoadState", "wait"}:
        return run_wait_step(ctx, step, kind, record)
    if kind == "evaluate":
        if step.get("allowEvaluate") is not True and step.get("boundedEvaluate") is not True:
            raise BrowserFlowBlocked("evaluate requires explicit boundedEvaluate/allowEvaluate declaration", code="evaluate_boundary", details={"stepId": step_id(step)})
        return run_act_request(ctx, {"kind": "evaluate", **copy_known(step, {"targetId", "ref", "fn", "expression", "timeoutMs"})}, step, record)
    if kind in DIRECT_STEP_ACTIONS:
        return run_direct_step(ctx, step, kind, record)
    if kind == "extract":
        return run_extract_step(ctx, step, record)
    if kind == "assertText":
        return run_assert_text(ctx, step, record)
    if kind == "assertVisible":
        return run_assert_visible(ctx, step, record)
    if kind == "assertNoErrors":
        return run_assert_no_errors(ctx, step, record)
    raise BrowserFlowRunnerError(f"Unsupported Browser Flow step kind: {kind}", code="unsupported_step", details={"kind": kind})


def run_direct_step(ctx: RunnerContext, step: dict[str, Any], kind: str, record: dict[str, Any]) -> Any:
    action = DIRECT_STEP_ACTIONS[kind]
    request = {"action": action}
    if action == "open":
        copy_fields(step, request, {"url", "retain", "sessionKey"})
    elif action == "navigate":
        copy_fields(step, request, {"url", "targetId", "connectionMode", "waitUntil", "timeoutMs"})
    elif action == "snapshot":
        copy_fields(step, request, {"targetId", "connectionMode", "selector", "frame", "interactive", "compact", "efficient", "depth", "scope", "filter"})
    elif action in {"screenshot", "pdf"}:
        copy_fields(step, request, {"targetId", "connectionMode", "savePath", "ref", "element", "fullPage", "type", "quality", "animations", "caret", "scale", "omitBackground"})
        if "target" in step and "ref" not in request:
            resolved = resolve_target(ctx, step.get("target"), record)
            if resolved:
                request["ref"] = resolved
    elif action == "upload":
        copy_fields(step, request, {"targetId", "connectionMode", "paths", "inputRef", "element"})
        if "target" in step and "inputRef" not in request and "element" not in request:
            resolved = resolve_target(ctx, step.get("target"), record)
            if resolved:
                request["inputRef"] = resolved
    elif action == "dialog":
        copy_fields(step, request, {"targetId", "connectionMode", "accept", "promptText"})
    elif action in {"requests", "errors"}:
        copy_fields(step, request, {"targetId", "connectionMode", "filter", "clear"})
    elif action == "console":
        copy_fields(step, request, {"targetId", "connectionMode", "expression", "ref", "level", "savePath"})
    elif action == "storage":
        copy_fields(step, request, {"targetId", "connectionMode", "storageType", "operation", "key", "value"})
    elif action == "cookies":
        copy_fields(step, request, {"targetId", "connectionMode", "operation", "cookies"})
    elif action == "highlight":
        copy_fields(step, request, {"targetId", "connectionMode", "ref", "durationMs"})
        if "target" in step and "ref" not in request:
            resolved = resolve_target(ctx, step.get("target"), record)
            if resolved:
                request["ref"] = resolved
    elif action == "scroll":
        copy_fields(step, request, {"targetId", "connectionMode", "scrollDirection", "scrollAmount"})
    else:
        copy_fields(step, request, {"targetId", "connectionMode", "timeoutMs"})
    return browser_call(ctx, request, record)


def run_act_step(ctx: RunnerContext, step: dict[str, Any], kind: str, record: dict[str, Any]) -> Any:
    request: dict[str, Any] = {"kind": kind}
    copy_fields(step, request, {"targetId", "timeoutMs", "ref", "selector", "doubleClick", "button", "modifiers", "text", "submit", "slowly", "clearFirst", "key", "delayMs", "startRef", "endRef", "values", "fields", "width", "height", "scrollDirection", "scrollAmount"})
    if kind == "type" and "text" not in request and "value" in step:
        request["text"] = step["value"]
    if kind in {"click", "type", "hover", "scrollIntoView", "select"} and "ref" not in request and "selector" not in request:
        resolved = resolve_target(ctx, step.get("target"), record)
        if resolved:
            request["ref"] = resolved
        elif "target" in step:
            raise BrowserFlowRunnerError("Target could not be resolved to an executable browser ref", code="target_unresolved", details={"stepId": step_id(step)})
    if kind == "drag":
        if "startRef" not in request:
            start_ref = resolve_target(ctx, step.get("startTarget") or step.get("target"), record)
            if start_ref:
                request["startRef"] = start_ref
        if "endRef" not in request:
            end_ref = resolve_target(ctx, step.get("endTarget"), record)
            if end_ref:
                request["endRef"] = end_ref
    if kind == "fill" and "fields" in request and isinstance(request["fields"], list):
        request["fields"] = resolve_fill_fields(ctx, request["fields"], record)
    return run_act_request(ctx, request, step, record)


def run_wait_step(ctx: RunnerContext, step: dict[str, Any], kind: str, record: dict[str, Any]) -> Any:
    request: dict[str, Any] = {"kind": "wait"}
    copy_fields(step, request, {"targetId", "timeoutMs", "timeMs", "text", "textGone", "selector", "url", "loadState", "fn"})
    if kind == "waitForText" and "text" not in request and "value" in step:
        request["text"] = step["value"]
    if kind == "waitForUrl" and "url" not in request and "value" in step:
        request["url"] = step["value"]
    if kind == "waitForLoadState" and "loadState" not in request and "value" in step:
        request["loadState"] = step["value"]
    return run_act_request(ctx, request, step, record)


def run_act_request(ctx: RunnerContext, request: dict[str, Any], step: dict[str, Any], record: dict[str, Any]) -> Any:
    request_kind = request.get("kind")
    if request_kind not in ACT_REQUEST_KINDS:
        raise BrowserFlowRunnerError(f"Unsupported Browser Relay act request kind: {request_kind}", code="unsupported_act_request")
    browser_request: dict[str, Any] = {"action": "act", "request": request}
    copy_fields(step, browser_request, {"targetId", "connectionMode"})
    return browser_call(ctx, browser_request, record)


def run_extract_step(ctx: RunnerContext, step: dict[str, Any], record: dict[str, Any]) -> Any:
    if step.get("method") == "evaluate":
        if step.get("allowEvaluate") is not True and step.get("boundedEvaluate") is not True:
            raise BrowserFlowBlocked("evaluate extraction requires explicit boundedEvaluate/allowEvaluate declaration", code="evaluate_boundary", details={"stepId": step_id(step)})
        result = run_act_request(ctx, {"kind": "evaluate", **copy_known(step, {"targetId", "ref", "fn", "expression", "timeoutMs"})}, step, record)
        output_name = first_string(step.get("output"), step.get("name"), step_id(step), "extract")
        ctx.outputs[output_name] = result
        return result

    snapshot = browser_call(ctx, snapshot_request(step), record, note="extract.snapshot")
    text = snapshot_text(snapshot)
    value: Any = None
    pattern = step.get("pattern")
    if isinstance(pattern, str) and pattern:
        match = re.search(pattern, text, re.MULTILINE)
        value = match.group(1) if match and match.groups() else (match.group(0) if match else None)
    else:
        value = text[:4000]
    output_name = first_string(step.get("output"), step.get("name"), step_id(step), "extract")
    ctx.outputs[output_name] = value
    return {"output": output_name, "value": truncate(value)}


def run_assert_text(ctx: RunnerContext, step: dict[str, Any], record: dict[str, Any]) -> Any:
    expected = first_string(step.get("text"), step.get("value"))
    if not expected:
        raise BrowserFlowRunnerError("assertText requires text", code="invalid_step")
    snapshot = browser_call(ctx, snapshot_request(step), record, note="assertText.snapshot")
    text = snapshot_text(snapshot)
    if expected not in text:
        raise BrowserFlowRunnerError(f"Text not found in snapshot: {expected}", code="assertion_failed", details={"text": expected})
    return {"text": expected, "found": True}


def run_assert_visible(ctx: RunnerContext, step: dict[str, Any], record: dict[str, Any]) -> Any:
    resolved = resolve_target(ctx, step.get("target"), record)
    if not resolved:
        raise BrowserFlowRunnerError("Visible target could not be resolved", code="target_not_found", details={"target": step.get("target")})
    return {"ref": resolved, "visible": True}


def run_assert_no_errors(ctx: RunnerContext, step: dict[str, Any], record: dict[str, Any]) -> Any:
    request = {"action": "errors"}
    copy_fields(step, request, {"targetId", "connectionMode", "clear"})
    result = browser_call(ctx, request, record)
    errors = extract_error_items(result)
    if errors:
        raise BrowserFlowRunnerError("Browser errors were captured", code="assertion_failed", details={"count": len(errors)})
    return {"errors": 0}


def browser_call(ctx: RunnerContext, request: dict[str, Any], record: dict[str, Any], note: str | None = None) -> dict[str, Any]:
    rpc_timeout = browser_rpc_timeout_seconds(request)
    call_record = {"request": redact(request), **({"note": note} if note else {})}
    if rpc_timeout is not None:
        call_record["rpcTimeoutMs"] = round(rpc_timeout * 1000)
    record.setdefault("calls", []).append(call_record)
    try:
        result = ctx.request_browser(request, timeout=rpc_timeout)
    except OpenClawBrowserGatewayError as exc:
        raise BrowserFlowRunnerError(str(exc), code=str(exc.code or "gateway_error"), details=exc.details) from exc
    record["calls"][-1]["result"] = sanitize_result(result)
    return result


def _timeout_ms_to_seconds(value: Any) -> float | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not value > 0:
        return None
    return max(MIN_RPC_TIMEOUT_SECONDS, (float(value) / 1000.0) + RPC_TIMEOUT_PADDING_SECONDS)


def browser_rpc_timeout_seconds(request: dict[str, Any]) -> float | None:
    direct_timeout = _timeout_ms_to_seconds(request.get("timeoutMs"))
    if direct_timeout is not None:
        return direct_timeout

    nested = request.get("request")
    if request.get("action") != "act" or not isinstance(nested, dict):
        return None

    nested_timeout = _timeout_ms_to_seconds(nested.get("timeoutMs"))
    if nested_timeout is not None:
        return nested_timeout
    if nested.get("kind") == "wait":
        return _timeout_ms_to_seconds(nested.get("timeMs"))
    return None


def snapshot_request(step: dict[str, Any]) -> dict[str, Any]:
    request: dict[str, Any] = {"action": "snapshot", "interactive": True, "compact": True}
    copy_fields(step, request, {"targetId", "connectionMode", "selector", "frame", "interactive", "compact", "efficient", "depth", "scope", "filter"})
    return request


def normalize_match_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    normalized = value.strip().lower()
    normalized = normalized.replace("*", "")
    normalized = normalized.replace("：", ":")
    normalized = normalized.replace("（", "(").replace("）", ")")
    normalized = re.sub(r"\s+", "", normalized)
    return normalized


def snapshot_with_retry(ctx: RunnerContext, record: dict[str, Any], *, note: str, attempts: int = 3, delay_seconds: float = 0.35) -> dict[str, Any]:
    last_snapshot: dict[str, Any] = {}
    for attempt in range(attempts):
        snapshot = browser_call(ctx, {"action": "snapshot", "interactive": True, "compact": True}, record, note=f"{note}#{attempt + 1}")
        last_snapshot = snapshot
        refs = snapshot.get("refs") if isinstance(snapshot, dict) else None
        if isinstance(refs, dict) and refs:
            return snapshot
        if attempt < attempts - 1:
            time.sleep(delay_seconds)
    return last_snapshot


def resolve_target(ctx: RunnerContext, target: Any, record: dict[str, Any]) -> str | None:
    if isinstance(target, str) and target.strip():
        return target.strip()
    if not isinstance(target, dict):
        return None
    direct_ref = first_string(target.get("ref"), target.get("runtimeRef"))
    if direct_ref:
        return direct_ref

    snapshot = snapshot_with_retry(ctx, record, note="resolveTarget.snapshot")
    refs = snapshot.get("refs") if isinstance(snapshot, dict) else None
    wanted_role = normalize_match_text(first_string(target.get("role"), target.get("kind")))
    wanted_label = normalize_match_text(first_string(target.get("label"), target.get("name"), target.get("text"), target.get("title")))
    wanted_context = normalize_match_text(first_string(target.get("componentId"), target.get("businessContext"), target.get("actionMeaning"), target.get("field")))

    best_ref: str | None = None
    best_meta: dict[str, Any] | None = None
    best_score = -1
    best_exactness = -1

    if isinstance(refs, dict):
        for ref, meta in refs.items():
            if not isinstance(meta, dict):
                continue
            role_value = normalize_match_text(meta.get("role"))
            name_value = normalize_match_text(first_string(meta.get("name"), meta.get("label"), meta.get("title"), meta.get("text")))
            haystack = normalize_match_text(json.dumps(meta, ensure_ascii=False))

            score = 0
            exactness = 0
            if wanted_role and role_value == wanted_role:
                score += 3
                exactness += 1
            elif wanted_role and wanted_role in haystack:
                score += 1

            if wanted_label:
                if name_value == wanted_label:
                    score += 5
                    exactness += 3
                elif wanted_label in name_value:
                    score += 4
                    exactness += 2
                elif name_value and name_value in wanted_label:
                    score += 4
                    exactness += 1
                elif wanted_label in haystack:
                    score += 2

            if wanted_context and wanted_context in haystack:
                score += 2
                exactness += 1

            if score > best_score or (score == best_score and exactness > best_exactness):
                best_score = score
                best_exactness = exactness
                best_ref = str(ref)
                best_meta = meta

        if best_ref and best_score >= 4:
            resolved = {
                "target": redact(target),
                "ref": best_ref,
                "strategy": "snapshot.refs.scored",
                "semantic": stable_target_semantics(target),
                "metadata": stable_ref_metadata(best_meta),
                "score": best_score,
            }
            record.setdefault("resolvedTargets", []).append(resolved)
            collect_target_observation(ctx, target, best_meta, record)
            return best_ref

    snapshot_body = normalize_match_text(snapshot_text(snapshot))
    wanted_parts = [item for item in (wanted_role, wanted_label, wanted_context) if item]
    if wanted_parts and all(item in snapshot_body for item in wanted_parts if item != wanted_role):
        ctx.unknowns.append("Target matched snapshot text but no executable ref was available")
    record.setdefault("resolvedTargets", []).append({"target": redact(target), "ref": None, "strategy": "unresolved", "bestScore": best_score})
    return None


def resolve_fill_fields(ctx: RunnerContext, fields: list[Any], record: dict[str, Any]) -> list[dict[str, Any]]:
    resolved_fields: list[dict[str, Any]] = []
    for field in fields:
        if not isinstance(field, dict):
            continue
        next_field = dict(field)
        if "ref" not in next_field:
            ref = resolve_target(ctx, next_field.get("target"), record)
            if ref:
                next_field["ref"] = ref
        next_field.pop("target", None)
        resolved_fields.append(next_field)
    return resolved_fields


def stable_target_semantics(target: dict[str, Any]) -> dict[str, Any]:
    keys = ("surfaceId", "viewId", "regionId", "componentId", "capabilityId", "role", "kind", "label", "name", "text", "title", "scope", "businessContext", "actionMeaning", "field")
    return {key: target[key] for key in keys if isinstance(target.get(key), (str, int, float, bool)) and str(target[key]).strip()}


def stable_ref_metadata(meta: Any) -> dict[str, Any]:
    if not isinstance(meta, dict):
        return {}
    keys = ("role", "name", "label", "title", "text", "componentId", "kind")
    return {key: meta[key] for key in keys if isinstance(meta.get(key), (str, int, float, bool)) and str(meta[key]).strip()}


def collect_target_observation(ctx: RunnerContext, target: dict[str, Any], meta: Any, record: dict[str, Any]) -> None:
    component_id = first_string(target.get("componentId"), meta.get("componentId") if isinstance(meta, dict) else None)
    if not component_id:
        return
    observation = {
        "componentId": component_id,
        "stepId": record.get("id"),
        "semantic": stable_target_semantics(target),
        "metadata": stable_ref_metadata(meta),
    }
    if observation["metadata"]:
        ctx.patch_suggestions.append({
            "op": "observe-component",
            "assetKind": "component",
            "assetId": component_id,
            "reason": "resolved target metadata observed during execution",
            "value": observation,
        })


def verify_success_criteria(ctx: RunnerContext) -> None:
    criteria = ctx.assets.recipe.get("successCriteria") or ctx.assets.recipe.get("successSignals") or []
    if not criteria:
        return
    items = criteria if isinstance(criteria, list) else [criteria]
    for item in items:
        if isinstance(item, str):
            run_assert_text(ctx, {"id": f"success-{len(ctx.step_results) + 1}", "kind": "assertText", "text": item}, {"id": "successCriteria", "kind": "assertText", "status": "running"})
        elif isinstance(item, dict):
            kind = first_string(item.get("kind"), item.get("type"))
            if kind in {"text", "visibleText", "assertText"}:
                synthetic_record = {"id": f"success-{len(ctx.step_results) + 1}", "kind": "assertText", "status": "running"}
                ctx.step_results.append(synthetic_record)
                run_assert_text(ctx, {**item, "kind": "assertText"}, synthetic_record)
                synthetic_record["status"] = "success"


def build_report(ctx: RunnerContext) -> dict[str, Any]:
    report = {
        "ok": ctx.status == "success",
        "status": ctx.status,
        "protocol": "agent-browser-flow-v1",
        "platformId": ctx.assets.platform_id,
        "recipeId": ctx.assets.recipe_id,
        "capabilityId": ctx.assets.capability_id,
        "params": redact_params(ctx.params, ctx.param_specs),
        "outputs": redact(ctx.outputs),
        "steps": ctx.step_results,
        "blockers": ctx.blockers,
        "unknowns": sorted(set(ctx.unknowns)),
        "patchStatus": ctx.patch_status,
        "patchSuggestions": redact(ctx.patch_suggestions),
        "appliedPatches": redact(ctx.applied_patches),
        "rejectedPatches": redact(ctx.rejected_patches),
        "changedAssets": ctx.changed_assets,
        "postWriteBackValidation": ctx.post_write_back_validation,
        "durationMs": round((time.time() - ctx.started_at) * 1000),
    }
    return report


def make_trace_path(ctx: RunnerContext) -> Path:
    traces_dir = ctx.assets.platform_dir / "evidence" / "traces"
    traces_dir.mkdir(parents=True, exist_ok=True)
    safe_recipe_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", ctx.assets.recipe_id)
    return traces_dir / f"{time.strftime('%Y%m%d-%H%M%S')}-{safe_recipe_id}.trace.json"


def write_trace(ctx: RunnerContext, report: dict[str, Any], trace_path: Path | None = None) -> Path:
    trace_path = trace_path or make_trace_path(ctx)
    trace_path.parent.mkdir(parents=True, exist_ok=True)
    trace = {
        "runtime": {"protocol": "agent-browser-flow-v1", "runner": "agent_browser_flow_runner.py"},
        "createdAt": timestamp(time.time()),
        "platformId": ctx.assets.platform_id,
        "recipeId": ctx.assets.recipe_id,
        "capabilityId": ctx.assets.capability_id,
        "surfaceId": ctx.assets.recipe.get("surfaceId"),
        "viewId": ctx.assets.recipe.get("viewId"),
        "componentIds": ctx.assets.recipe.get("componentIds"),
        "report": report,
    }
    trace_path.write_text(json.dumps(trace, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return trace_path


def stable_observed_signature(ctx: RunnerContext) -> dict[str, Any]:
    runtime = ctx.assets.recipe.get("runtime") if isinstance(ctx.assets.recipe.get("runtime"), dict) else {}
    steps = ctx.assets.recipe.get("steps") if isinstance(ctx.assets.recipe.get("steps"), list) else []
    resolved_targets: list[dict[str, Any]] = []
    for step in ctx.step_results:
        for target in step.get("resolvedTargets", []) if isinstance(step, dict) else []:
            if isinstance(target, dict):
                resolved_targets.append({
                    "semantic": target.get("semantic") if isinstance(target.get("semantic"), dict) else {},
                    "metadata": target.get("metadata") if isinstance(target.get("metadata"), dict) else {},
                    "strategy": target.get("strategy"),
                })
    return {
        "recipeId": ctx.assets.recipe_id,
        "capabilityId": ctx.assets.capability_id,
        "surfaceId": ctx.assets.recipe.get("surfaceId"),
        "viewId": ctx.assets.recipe.get("viewId"),
        "componentIds": sorted(item for item in normalize_string_list(ctx.assets.recipe.get("componentIds")) if item),
        "requiredBrowserActions": sorted(item for item in runtime.get("requiredBrowserActions", []) if isinstance(item, str)),
        "stepKinds": [step_kind(step) for step in steps if isinstance(step, dict)],
        "resolvedTargets": sorted(resolved_targets, key=lambda item: json.dumps(item, ensure_ascii=False, sort_keys=True)),
        "status": ctx.status,
        "failureCodes": sorted(error.get("code") for error in collect_errors(ctx) if isinstance(error.get("code"), str)),
    }


def signature_digest(signature: dict[str, Any]) -> str:
    encoded = json.dumps(signature, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def classify_model_delta(ctx: RunnerContext) -> str:
    if ctx.status == "blocked":
        return "blocked"
    risk = first_string(
        ctx.assets.recipe.get("risk"),
        ctx.assets.atlas.get(ctx.assets.capability_id, {}).get("risk") if ctx.assets.capability_id else "",
    )
    if risk not in SAFE_RISKS:
        return "suggest_only" if ctx.status == "success" else "blocked"
    if ctx.asset_update_mode == "execution":
        if ctx.status == "success" and not ctx.unknowns:
            return "no_changes"
        return "suggest_only"
    if ctx.status != "success":
        return "write_back"

    signature = stable_observed_signature(ctx)
    digest = signature_digest(signature)
    runtime = ctx.assets.recipe.get("runtime") if isinstance(ctx.assets.recipe.get("runtime"), dict) else {}
    required_actions = [item for item in runtime.get("requiredBrowserActions", []) if isinstance(item, str)]

    if not asset_has_success_evidence(ctx.assets.recipe, digest):
        return "write_back"
    if ctx.assets.capability_id and ctx.assets.capability_id not in ctx.assets.atlas:
        return "write_back"
    capability = ctx.assets.atlas.get(ctx.assets.capability_id, {}) if ctx.assets.capability_id else {}
    if capability and not asset_has_success_evidence(capability, digest):
        return "write_back"
    supported_actions = normalize_string_list(ctx.assets.platform.get("supportedBrowserActions"))
    if any(action not in supported_actions for action in required_actions):
        return "write_back"
    for suggestion in ctx.patch_suggestions:
        if component_observation_needs_update(ctx, suggestion, digest):
            return "write_back"
    if ctx.unknowns:
        return "suggest_only"
    return "no_changes"


def asset_has_success_evidence(asset: dict[str, Any], digest: str) -> bool:
    freshness = asset.get("freshness") if isinstance(asset.get("freshness"), dict) else {}
    return (
        isinstance(freshness.get("lastValidatedAt"), str)
        and freshness.get("failureCount") == 0
        and digest in normalize_string_list(asset.get("observedSignatures"))
    )


def component_observation_needs_update(ctx: RunnerContext, suggestion: dict[str, Any], digest: str) -> bool:
    component_id = first_string(suggestion.get("assetId"))
    if not component_id:
        return False
    component = ctx.assets.atlas.get(component_id)
    if not isinstance(component, dict):
        return True
    value = suggestion.get("value") if isinstance(suggestion.get("value"), dict) else {}
    metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
    role = first_string(metadata.get("role"), metadata.get("kind"))
    label = first_string(metadata.get("label"), metadata.get("name"), metadata.get("title"), metadata.get("text"))
    return (
        (role and role not in normalize_string_list(component.get("observedRoles")))
        or (label and label not in normalize_string_list(component.get("observedLabels")))
        or digest not in normalize_string_list(component.get("observedSignatures"))
    )


def apply_incremental_patch(ctx: RunnerContext, trace_path: Path) -> None:
    signature = stable_observed_signature(ctx)
    digest = signature_digest(signature)
    patch_path = patch_bundle_path(ctx)
    evidence_refs = [relative_asset_path(ctx, trace_path), relative_asset_path(ctx, patch_path)]
    changed_paths: list[Path] = []
    now = timestamp(time.time())

    if ctx.status == "success":
        ensure_capability_asset(ctx)
        changed_paths.extend(apply_success_patch(ctx, digest, evidence_refs, now))
        changed_paths.extend(apply_component_observations(ctx, digest, evidence_refs, now))
        changed_paths.extend(update_index(ctx, now))
    else:
        changed_paths.extend(apply_failure_patch(ctx, digest, evidence_refs, now))

    for path in dedupe_paths(changed_paths):
        if path == patch_path:
            continue
        validate_write_path(ctx, path)
    ctx.changed_assets = [relative_asset_path(ctx, path) for path in dedupe_paths(changed_paths)]
    write_patch_bundle(ctx, patch_path, signature, digest, trace_path)
    if relative_asset_path(ctx, patch_path) not in ctx.changed_assets:
        ctx.changed_assets.append(relative_asset_path(ctx, patch_path))
    validate_changed_assets(ctx)
    if ctx.validation_smoke and ctx.status == "success":
        run_validation_smoke(ctx)


def apply_success_patch(ctx: RunnerContext, digest: str, evidence_refs: list[str], now: str) -> list[Path]:
    changed: list[Path] = []
    runtime = ctx.assets.recipe.get("runtime") if isinstance(ctx.assets.recipe.get("runtime"), dict) else {}
    required_actions = [item for item in runtime.get("requiredBrowserActions", []) if isinstance(item, str)]

    merge_success_fields(ctx.assets.recipe, digest, evidence_refs, now)
    changed.append(ctx.assets.recipe_path) if write_json_asset(ctx, ctx.assets.recipe_path, ctx.assets.recipe) else None

    if ctx.assets.capability_id:
        capability = ctx.assets.atlas.get(ctx.assets.capability_id)
        if isinstance(capability, dict):
            if first_string(capability.get("risk"), ctx.assets.recipe.get("risk")) in SAFE_RISKS:
                capability["automationStatus"] = "validated"
            merge_success_fields(capability, digest, evidence_refs, now)
            path = ctx.assets.atlas_paths.get(ctx.assets.capability_id)
            if path and write_json_asset(ctx, path, capability):
                changed.append(path)

    append_unique_list(ctx.assets.platform, "supportedBrowserActions", required_actions)
    freshness = ctx.assets.platform.setdefault("freshness", {})
    if isinstance(freshness, dict):
        freshness["lastObservedAt"] = now
    if write_json_asset(ctx, ctx.assets.platform_path, ctx.assets.platform):
        changed.append(ctx.assets.platform_path)
    return changed


def apply_failure_patch(ctx: RunnerContext, digest: str, evidence_refs: list[str], now: str) -> list[Path]:
    changed: list[Path] = []
    blockers = [error.get("code") for error in collect_errors(ctx) if isinstance(error.get("code"), str)] or [ctx.status]
    for asset, path in ((ctx.assets.recipe, ctx.assets.recipe_path), (ctx.assets.atlas.get(ctx.assets.capability_id), ctx.assets.atlas_paths.get(ctx.assets.capability_id))):
        if not isinstance(asset, dict) or path is None:
            continue
        freshness = asset.setdefault("freshness", {})
        if isinstance(freshness, dict):
            freshness["lastFailureAt"] = now
            freshness["failureCount"] = int(freshness.get("failureCount") or 0) + 1
        append_unique_list(asset, "blockers", blockers)
        append_unique_list(asset, "evidenceRefs", evidence_refs)
        append_unique_list(asset, "observedSignatures", [digest])
        if write_json_asset(ctx, path, asset):
            changed.append(path)
    return changed


def apply_component_observations(ctx: RunnerContext, digest: str, evidence_refs: list[str], now: str) -> list[Path]:
    changed: list[Path] = []
    for suggestion in ctx.patch_suggestions:
        component_id = first_string(suggestion.get("assetId"))
        if not component_id:
            continue
        component = ctx.assets.atlas.get(component_id)
        if not isinstance(component, dict):
            component = {"componentId": component_id, "platformId": ctx.assets.platform_id}
            ctx.assets.atlas[component_id] = component
            ctx.assets.atlas_paths[component_id] = ctx.assets.platform_dir / "atlas" / "components" / f"{safe_file_stem(component_id)}.component.json"
        value = suggestion.get("value") if isinstance(suggestion.get("value"), dict) else {}
        metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
        role = first_string(metadata.get("role"), metadata.get("kind"))
        label = first_string(metadata.get("label"), metadata.get("name"), metadata.get("title"), metadata.get("text"))
        if role:
            append_unique_list(component, "observedRoles", [role])
        if label:
            append_unique_list(component, "observedLabels", [label])
        append_unique_list(component, "evidenceRefs", evidence_refs)
        append_unique_list(component, "observedSignatures", [digest])
        freshness = component.setdefault("freshness", {})
        if isinstance(freshness, dict):
            freshness["lastObservedAt"] = now
        path = ctx.assets.atlas_paths[component_id]
        if write_json_asset(ctx, path, component):
            changed.append(path)
        ctx.applied_patches.append({"op": "observe-component", "assetId": component_id, "path": relative_asset_path(ctx, path)})
    return changed


def ensure_capability_asset(ctx: RunnerContext) -> None:
    capability_id = ctx.assets.capability_id
    if not capability_id or capability_id in ctx.assets.atlas:
        return
    capability = {
        "capabilityId": capability_id,
        "platformId": ctx.assets.platform_id,
        "risk": first_string(ctx.assets.recipe.get("risk"), "unknown"),
        "executionMode": first_string(ctx.assets.recipe.get("executionMode"), "auto"),
    }
    path = ctx.assets.platform_dir / "atlas" / "capabilities" / f"{safe_file_stem(capability_id)}.capability.json"
    ctx.assets.atlas[capability_id] = capability
    ctx.assets.atlas_paths[capability_id] = path
    ctx.applied_patches.append({"op": "create-capability", "assetId": capability_id, "path": relative_asset_path(ctx, path)})


def merge_success_fields(asset: dict[str, Any], digest: str, evidence_refs: list[str], now: str) -> None:
    freshness = asset.setdefault("freshness", {})
    if isinstance(freshness, dict):
        freshness["lastValidatedAt"] = now
        freshness["failureCount"] = 0
        freshness.pop("lastFailureAt", None)
    append_unique_list(asset, "evidenceRefs", evidence_refs)
    append_unique_list(asset, "observedSignatures", [digest])
    if isinstance(asset.get("blockers"), list):
        asset["blockers"] = []


def append_unique_list(asset: dict[str, Any], key: str, values: list[Any]) -> None:
    current = asset.get(key)
    items = current if isinstance(current, list) else []
    for value in values:
        if value not in items:
            items.append(value)
    asset[key] = items


def write_json_asset(ctx: RunnerContext, path: Path, data: dict[str, Any]) -> bool:
    validate_write_path(ctx, path)
    path.parent.mkdir(parents=True, exist_ok=True)
    next_content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == next_content:
        return False
    path.write_text(next_content, encoding="utf-8")
    return True


def write_patch_bundle(ctx: RunnerContext, patch_path: Path, signature: dict[str, Any], digest: str, trace_path: Path) -> None:
    validate_write_path(ctx, patch_path)
    patch_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "patchProtocol": "browser-flow-atlas-patch-v1",
        "createdAt": timestamp(time.time()),
        "platformId": ctx.assets.platform_id,
        "recipeId": ctx.assets.recipe_id,
        "capabilityId": ctx.assets.capability_id,
        "patchStatus": ctx.patch_status,
        "observedSignature": signature,
        "observedSignatureHash": digest,
        "tracePath": relative_asset_path(ctx, trace_path),
        "suggestions": redact(ctx.patch_suggestions),
        "appliedPatches": redact(ctx.applied_patches),
        "rejectedPatches": redact(ctx.rejected_patches),
        "changedAssets": ctx.changed_assets,
    }
    patch_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def patch_bundle_path(ctx: RunnerContext) -> Path:
    safe_recipe_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", ctx.assets.recipe_id)
    return ctx.assets.platform_dir / "evidence" / "patches" / f"{time.strftime('%Y%m%d-%H%M%S')}-{safe_recipe_id}.atlas-patch.json"


def update_index(ctx: RunnerContext, now: str) -> list[Path]:
    start = f"<!-- browser-flow:index:start platform={ctx.assets.platform_id} -->"
    end = INDEX_END_TEMPLATE.format(platform_id=ctx.assets.platform_id)
    actions = ", ".join(normalize_string_list(ctx.assets.platform.get("supportedBrowserActions"))) or "none"
    body = "\n".join([
        start,
        f"## {ctx.assets.platform.get('displayName') or ctx.assets.platform_id}",
        "",
        f"- Platform: `{ctx.assets.platform_id}`",
        f"- Last observed: {now}",
        f"- Supported Browser Relay actions: {actions}",
        f"- Recipes: {len(list(ctx.assets.platform_dir.glob('flows/*.recipe.json'))) if (ctx.assets.platform_dir / 'flows').is_dir() else 0}",
        f"- Atlas assets: {len(ctx.assets.atlas)}",
        end,
        "",
    ])
    existing = ctx.assets.index_path.read_text(encoding="utf-8") if ctx.assets.index_path.exists() else "# Browser Flow Index\n\n"
    match = INDEX_START_PATTERN.search(existing)
    next_content = existing
    if match and match.group(1) == ctx.assets.platform_id:
        end_marker = INDEX_END_TEMPLATE.format(platform_id=ctx.assets.platform_id)
        end_index = existing.find(end_marker, match.start())
        if end_index >= 0:
            next_content = existing[:match.start()] + body + existing[end_index + len(end_marker):].lstrip("\n")
    elif existing.endswith("\n"):
        next_content = existing + "\n" + body
    else:
        next_content = existing + "\n\n" + body
    if next_content != existing:
        validate_write_path(ctx, ctx.assets.index_path)
        ctx.assets.index_path.parent.mkdir(parents=True, exist_ok=True)
        ctx.assets.index_path.write_text(next_content, encoding="utf-8")
        return [ctx.assets.index_path]
    return []


def validate_changed_assets(ctx: RunnerContext) -> None:
    for rel_path in ctx.changed_assets:
        path = (ctx.assets.browser_flows_dir / rel_path.removeprefix("browser-flows/")).resolve() if rel_path.startswith("browser-flows/") else (ctx.assets.browser_flows_dir / rel_path).resolve()
        if path.suffix == ".json":
            load_json(path)
    refreshed = load_assets(ctx.assets.workspace_dir, ctx.assets.recipe_id, ctx.assets.platform_id)
    require_runtime_contract(refreshed.recipe)
    normalize_param_specs(refreshed.recipe)
    if refreshed.capability_id and refreshed.capability_id not in refreshed.atlas:
        raise BrowserFlowRunnerError("Recipe capability reference is missing after write-back", code="invalid_write_back")


def run_validation_smoke(ctx: RunnerContext) -> None:
    risk = first_string(ctx.assets.recipe.get("risk"), ctx.assets.atlas.get(ctx.assets.capability_id, {}).get("risk") if ctx.assets.capability_id else "")
    if risk not in SAFE_RISKS:
        ctx.post_write_back_validation = {"ok": True, "status": "skipped", "reason": "risk boundary"}
        return
    try:
        refreshed = load_assets(ctx.assets.workspace_dir, ctx.assets.recipe_id, ctx.assets.platform_id)
        smoke_ctx = RunnerContext(
            assets=refreshed,
            params=ctx.params,
            param_specs=normalize_param_specs(refreshed.recipe),
            approve_risk=ctx.approve_risk,
            asset_update_mode="execution",
            client=ctx.client,
        )
        execute_recipe(smoke_ctx)
        ctx.post_write_back_validation = {"ok": True, "status": smoke_ctx.status, "calls": sum(len(step.get("calls", [])) for step in smoke_ctx.step_results)}
    except Exception as exc:
        ctx.post_write_back_validation = {"ok": False, "status": "failed", "error": error_payload(exc)}
        raise BrowserFlowRunnerError("Post write-back validation failed", code="post_write_back_validation_failed", details=error_payload(exc)) from exc


def maybe_apply_asset_updates(ctx: RunnerContext, trace_path: Path) -> None:
    ctx.patch_status = classify_model_delta(ctx)
    if ctx.asset_update_mode == "learning" and ctx.patch_status == "write_back":
        apply_incremental_patch(ctx, trace_path)


def collect_errors(ctx: RunnerContext) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    errors.extend(error for error in ctx.blockers if isinstance(error, dict))
    for step in ctx.step_results:
        error = step.get("error") if isinstance(step, dict) else None
        if isinstance(error, dict):
            errors.append(error)
    return errors


def normalize_string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [item.strip() for item in value if isinstance(item, str) and item.strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def safe_file_stem(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-") or "asset"


def dedupe_paths(paths: list[Path]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for path in paths:
        key = str(path.resolve())
        if key not in seen:
            seen.add(key)
            result.append(path)
    return result


def validate_write_path(ctx: RunnerContext, path: Path) -> None:
    resolved = path.resolve()
    allowed_roots = [ctx.assets.browser_flows_dir.resolve(), ctx.assets.platform_dir.resolve()]
    if not any(is_relative_to(resolved, root) for root in allowed_roots):
        raise BrowserFlowRunnerError("Write-back path is outside browser-flows", code="invalid_write_path", details=str(path))


def is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def relative_asset_path(ctx: RunnerContext, path: Path) -> str:
    try:
        return path.resolve().relative_to(ctx.assets.browser_flows_dir.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def finish_with_context(ctx: RunnerContext, extra: dict[str, Any] | None = None, exit_code: int | None = None) -> int:
    trace_path = make_trace_path(ctx)
    report = build_report(ctx)
    if extra:
        report.update(extra)
    report["tracePath"] = str(trace_path)
    maybe_apply_asset_updates(ctx, trace_path)
    report = build_report(ctx)
    if extra:
        report.update(extra)
    report["tracePath"] = str(trace_path)
    write_trace(ctx, report, trace_path)
    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    if exit_code is not None:
        return exit_code
    return 0 if report["ok"] else 1


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run an agent-side Browser Flow v1 recipe")
    parser.add_argument("--workspace-dir", default=".")
    parser.add_argument("--platform-id")
    parser.add_argument("--recipe-id", required=True)
    parser.add_argument("--params-json", default="{}")
    parser.add_argument("--approve-risk", action="store_true")
    parser.add_argument("--asset-update-mode", choices=("execution", "learning"), default="execution")
    parser.add_argument("--validation-smoke", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    ctx: RunnerContext | None = None
    try:
        supplied_params = json.loads(args.params_json)
        if not isinstance(supplied_params, dict):
            raise BrowserFlowRunnerError("--params-json must be a JSON object", code="invalid_params")
        assets = load_assets(Path(args.workspace_dir).resolve(), args.recipe_id, args.platform_id)
        param_specs = normalize_param_specs(assets.recipe)
        params = validate_params(param_specs, supplied_params)
        ctx = RunnerContext(
            assets=assets,
            params=params,
            param_specs=param_specs,
            approve_risk=args.approve_risk,
            asset_update_mode=args.asset_update_mode,
            validation_smoke=args.validation_smoke,
        )
        execute_recipe(ctx)
        return finish_with_context(ctx)
    except BrowserFlowBlocked as exc:
        if ctx is not None:
            ctx.status = "blocked"
            if error_payload(exc) not in ctx.blockers:
                ctx.blockers.append(error_payload(exc))
            return finish_with_context(ctx, {"error": error_payload(exc)}, exit_code=3)
        return emit_failure(args, exc, status="blocked", exit_code=3)
    except BrowserFlowRunnerError as exc:
        if ctx is not None:
            ctx.status = "failed"
            return finish_with_context(ctx, {"error": error_payload(exc)}, exit_code=2)
        return emit_failure(args, exc, status="failed", exit_code=2)
    except Exception as exc:
        if ctx is not None:
            ctx.status = "failed"
            return finish_with_context(ctx, {"error": error_payload(exc)}, exit_code=2)
        return emit_failure(args, exc, status="failed", exit_code=2)
    finally:
        if ctx is not None:
            ctx.close_browser()


def emit_failure(args: argparse.Namespace, exc: Exception, *, status: str, exit_code: int) -> int:
    payload = {
        "ok": False,
        "status": status,
        "protocol": "agent-browser-flow-v1",
        "recipeId": getattr(args, "recipe_id", ""),
        "error": error_payload(exc),
        "blockers": [error_payload(exc)] if status == "blocked" else [],
    }
    try:
        assets = load_assets(Path(args.workspace_dir).resolve(), args.recipe_id, args.platform_id)
        param_specs = normalize_param_specs(assets.recipe)
        supplied = json.loads(args.params_json) if isinstance(args.params_json, str) else {}
        ctx = RunnerContext(
            assets=assets,
            params=redact_params(supplied if isinstance(supplied, dict) else {}, param_specs),
            param_specs=param_specs,
            approve_risk=args.approve_risk,
            status=status,
        )
        if status == "blocked":
            ctx.blockers.append(error_payload(exc))
        payload.update({
            "platformId": assets.platform_id,
            "capabilityId": assets.capability_id,
            "params": redact_params(supplied if isinstance(supplied, dict) else {}, param_specs),
        })
        payload["tracePath"] = str(write_trace(ctx, payload))
    except Exception:
        pass
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return exit_code


def step_kind(step: dict[str, Any]) -> str:
    return first_string(step.get("kind"), step.get("type"), step.get("action"))


def step_id(step: dict[str, Any] | None) -> str:
    if not isinstance(step, dict):
        return ""
    return first_string(step.get("id"), step.get("stepId"), step.get("name"))


def render_templates(value: Any, params: dict[str, Any]) -> Any:
    if isinstance(value, str):
        exact = PLACEHOLDER_PATTERN.fullmatch(value.strip())
        if exact:
            return lookup_param(params, exact.group(1))
        return PLACEHOLDER_PATTERN.sub(lambda match: str(lookup_param(params, match.group(1))), value)
    if isinstance(value, list):
        return [render_templates(item, params) for item in value]
    if isinstance(value, dict):
        return {key: render_templates(item, params) for key, item in value.items()}
    return value


def lookup_param(params: dict[str, Any], name: str) -> Any:
    current: Any = params
    for part in name.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            raise BrowserFlowRunnerError(f"Unknown template param: {name}", code="unknown_param", details={"param": name})
    return current


def copy_fields(source: dict[str, Any], target: dict[str, Any], fields: set[str]) -> None:
    for field_name in fields:
        if field_name in source:
            target[field_name] = source[field_name]


def copy_known(source: dict[str, Any], fields: set[str]) -> dict[str, Any]:
    target: dict[str, Any] = {}
    copy_fields(source, target, fields)
    return target


def snapshot_text(result: Any) -> str:
    if isinstance(result, dict):
        for key in ("snapshot", "text", "content"):
            value = result.get(key)
            if isinstance(value, str):
                return value
        return json.dumps(result, ensure_ascii=False)
    return str(result)


def extract_error_items(result: Any) -> list[Any]:
    if isinstance(result, dict):
        for key in ("errors", "items", "entries", "logs"):
            value = result.get(key)
            if isinstance(value, list):
                return value
        if result.get("ok") is False:
            return [result]
    if isinstance(result, list):
        return result
    return []


def redact_params(params: dict[str, Any], specs: dict[str, ParamSpec]) -> dict[str, Any]:
    redacted: dict[str, Any] = {}
    for key, value in params.items():
        spec = specs.get(key)
        if (spec and spec.secret) or SECRET_NAME_PATTERN.search(key):
            redacted[key] = "[REDACTED]"
        else:
            redacted[key] = redact(value)
    return redacted


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            if SECRET_NAME_PATTERN.search(str(key)) or str(key).lower() in {"cookies", "cookie", "authorization"}:
                redacted[key] = "[REDACTED]"
            else:
                redacted[key] = redact(item)
        return redacted
    if isinstance(value, list):
        return [redact(item) for item in value[:50]]
    return truncate(value)


def sanitize_result(result: Any) -> Any:
    redacted = redact(result)
    if isinstance(redacted, dict):
        for key in ("snapshot", "html", "dom", "body"):
            if isinstance(redacted.get(key), str):
                redacted[key] = truncate(redacted[key], 1200)
    return redacted


def truncate(value: Any, limit: int = 2000) -> Any:
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + "…[truncated]"
    return value


def error_payload(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, BrowserFlowRunnerError):
        return {"code": exc.code, "message": str(exc), "details": redact(exc.details)}
    return {"code": exc.__class__.__name__, "message": str(exc)}


def timestamp(seconds: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(seconds))


if __name__ == "__main__":
    raise SystemExit(main())
