"""Python 3.12 MCP stdio backend; stdout is reserved for newline JSON-RPC."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import math
from pathlib import Path
import sys
from typing import Literal, TypeAlias

Json: TypeAlias = None | bool | int | float | str | list["Json"] | dict[str, "Json"]
ModelOperation = Literal["list", "generate", "generateText", "submitVideo", "queryVideo", "collectVideo"]
PROTOCOL_VERSIONS = {"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}
MAX_FRAME_BYTES = 128 * 1024 * 1024
MAX_PENDING = 128
CANCEL_REASON = "Request cancelled; external effects or charges may already have occurred. No rollback or retry."


@dataclass(frozen=True)
class Context:
    plugin_id: str
    version: str
    package_path: str
    storage_path: str


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Json = None):
        super().__init__(message)
        self.code, self.data = code, data


class ModelError(RpcError):
    """Host model failure; an executing tool returns it as a rich error result."""


def is_request_id(value: object) -> bool:
    return (isinstance(value, str) and 0 < len(value) <= 128) or (
        type(value) is int and abs(value) <= 9007199254740991
    )


def reject_non_json_number(value: str) -> None:
    raise ValueError(f"Non-JSON number: {value}")


def parse_json_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("JSON number must be finite.")
    return number


class Backend:
    def __init__(self, manifest: dict):
        self.manifest = manifest
        self.context: Context | None = None
        self.phase = "waiting"
        self.calls: dict[str | int, asyncio.Task] = {}
        self.pending: dict[str, asyncio.Future] = {}
        self.next_id = 0
        self.write_lock = asyncio.Lock()

    async def send(self, message: dict) -> None:
        if self.phase == "closed":
            return
        frame = json.dumps(message, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(frame) > MAX_FRAME_BYTES:
            raise RpcError(-32603, "Outgoing JSON-RPC frame exceeds 128 MiB.")
        async with self.write_lock:
            # Keep a cancelled writer from releasing the lock while its thread still writes.
            writer = asyncio.create_task(asyncio.to_thread(self.write_frame, frame + b"\n"))
            try:
                await asyncio.shield(writer)
            except asyncio.CancelledError:
                await writer
                raise

    @staticmethod
    def write_frame(frame: bytes) -> None:
        sys.stdout.buffer.write(frame)
        sys.stdout.buffer.flush()

    async def notify(self, method: str, params: dict) -> None:
        await self.send({"jsonrpc": "2.0", "method": method, "params": params})

    async def reject(self, request_id: str | int | None, error: RpcError) -> None:
        body = {"code": error.code, "message": str(error)}
        if error.data is not None:
            body["data"] = error.data
        await self.send({"jsonrpc": "2.0", "id": request_id, "error": body})

    async def log(self, level: Literal["info", "error"], message: str) -> None:
        await self.notify("notifications/message", {
            "level": level, "logger": self.manifest["id"], "data": message[:2000],
        })

    async def publish(self, topic: str, data: Json) -> None:
        if not isinstance(topic, str) or not 0 < len(topic) <= 200:
            raise ValueError("Event topic must contain 1 to 200 characters.")
        await self.notify("notifications/matcha/event", {"topic": topic, "data": data})

    async def report_progress(self, token: str | int | None, progress: float,
                              total: float | None = None, message: str | None = None) -> None:
        if token is None:
            return
        if not is_request_id(token) or not math.isfinite(progress) or progress < 0:
            raise ValueError("Invalid progress token or progress value.")
        params = {"progressToken": token, "progress": progress}
        if total is not None:
            if not math.isfinite(total) or total < progress:
                raise ValueError("Progress total must be finite and at least progress.")
            params["total"] = total
        if message is not None:
            params["message"] = message[:1000]
        await self.notify("notifications/progress", params)

    async def request_model(self, operation: ModelOperation, request: dict[str, Json]) -> Json:
        """Forward the original request; await the complete result without stopping the read loop."""
        if self.phase != "ready":
            raise RpcError(-32002, "Model requests require completed initialization.")
        if operation not in {"list", "generate", "generateText", "submitVideo", "queryVideo", "collectVideo"}:
            raise ValueError(f"Unknown model operation: {operation}")
        if not isinstance(request, dict):
            raise ValueError("Model request must be an object, not a wrapped request.")
        if len(self.pending) >= MAX_PENDING:
            raise RpcError(-32000, "At most 128 concurrent model requests are allowed.")
        self.next_id += 1
        request_id = f"python-model-{self.next_id}"
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            await self.send({"jsonrpc": "2.0", "id": request_id,
                             "method": f"matcha/models/{operation}", "params": request})
            return await future
        except asyncio.CancelledError:
            if self.pending.get(request_id) is future:
                await self.notify("notifications/cancelled", {"requestId": request_id, "reason": CANCEL_REASON})
            raise
        finally:
            self.pending.pop(request_id, None)
            if not future.done():
                future.cancel()

    async def initialize(self, params: dict) -> dict:
        if self.phase != "waiting":
            raise RpcError(-32600, "initialize was already accepted.")
        protocol_version = params.get("protocolVersion")
        if not isinstance(protocol_version, str) or protocol_version not in PROTOCOL_VERSIONS:
            raise RpcError(-32602, "initialize.protocolVersion is unsupported.")
        meta = params.get("_meta")
        identity = meta.get("matcha") if isinstance(meta, dict) else None
        if not isinstance(identity, dict) or any(
            not isinstance(identity.get(key), str) or not identity[key] or "\0" in identity[key]
            for key in ("pluginId", "version", "packagePath", "storagePath")
        ):
            raise RpcError(-32602, "initialize._meta.matcha requires pluginId, version, packagePath and storagePath strings.")
        if identity["pluginId"] != self.manifest["id"] or identity["version"] != self.manifest["version"]:
            raise RpcError(-32602, "initialize._meta.matcha identity does not match manifest.json.")
        if not all(Path(identity[key]).is_absolute() for key in ("packagePath", "storagePath")):
            raise RpcError(-32602, "initialize._meta.matcha paths must be absolute.")
        self.context = Context(identity["pluginId"], identity["version"], identity["packagePath"], identity["storagePath"])
        self.phase = "accepted"
        return {"protocolVersion": params["protocolVersion"], "capabilities": {"tools": {}, "logging": {}},
                "serverInfo": {"name": self.context.plugin_id, "version": self.context.version}}

    async def call_tool(self, params: dict) -> dict:
        if params.get("name") != "echo":
            raise RpcError(-32602, "tools/call.name must be the declared local tool 'echo'.")
        arguments = params.get("arguments", {})
        if (not isinstance(arguments, dict) or set(arguments) != {"message"}
                or not isinstance(arguments["message"], str) or len(arguments["message"]) > 4096):
            raise RpcError(-32602, "echo.arguments must contain only a message string of at most 4096 characters.")
        meta = params.get("_meta", {})
        if not isinstance(meta, dict) or ("progressToken" in meta and not is_request_id(meta["progressToken"])):
            raise RpcError(-32602, "tools/call._meta.progressToken must be a string or integer.")
        message = arguments["message"]
        await self.publish("echo", {"message": message})
        await self.report_progress(meta.get("progressToken"), 1, 1, "Echo complete")
        return {"content": [{"type": "text", "text": message}], "structuredContent": {"message": message}}

    async def serve_request(self, request_id: str | int, method: str, params: dict) -> None:
        try:
            if method == "tools/list":
                result = {"tools": self.manifest["contributes"]["tools"]}
            elif method == "tools/call":
                result = await self.call_tool(params)
            else:
                raise RpcError(-32601, f"Unknown method: {method}")
        except asyncio.CancelledError:
            await self.reject(request_id, RpcError(-32800, f"{method}: {CANCEL_REASON}"))
            return
        except ModelError as error:
            result = {"content": [{"type": "text", "text": str(error)}], "isError": True,
                      "_meta": {"requestId": request_id, "modelError": {"code": error.code, "data": error.data}}}
        except RpcError as error:
            await self.reject(request_id, RpcError(error.code, f"{method}: {error}", error.data))
            return
        except Exception as error:
            await self.log("error", f"method={method} requestId={request_id} errorType={type(error).__name__}")
            if method != "tools/call":
                await self.reject(request_id, RpcError(-32603, f"{method}: internal error; see plugin log."))
                return
            result = {"content": [{"type": "text", "text": f"echo failed ({type(error).__name__}); see plugin log."}],
                      "isError": True, "_meta": {"requestId": request_id}}
        await self.send({"jsonrpc": "2.0", "id": request_id, "result": result})

    def finish_call(self, request_id: str | int, task: asyncio.Task) -> None:
        self.calls.pop(request_id, None)
        if not task.cancelled():
            error = task.exception()
            if error is not None:
                sys.stderr.write(f"[python-backend] requestId={request_id} transportError={type(error).__name__}\n")

    async def receive(self, message: object) -> None:
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            await self.reject(None, RpcError(-32600, "Expected one JSON-RPC 2.0 object per line."))
            return
        request_id = message.get("id")
        if "method" not in message:
            if not is_request_id(request_id):
                await self.reject(None, RpcError(-32600, "Response id must be a string or integer."))
                return
            future = self.pending.pop(request_id, None)
            if future is None or future.done():
                return
            if ("result" in message) == ("error" in message):
                future.set_exception(RpcError(-32600, "Host response must contain exactly one of result or error."))
            elif "error" in message:
                error = message["error"]
                if not isinstance(error, dict) or type(error.get("code")) is not int or not isinstance(error.get("message"), str):
                    future.set_exception(RpcError(-32600, "Host response contains an invalid JSON-RPC error."))
                else:
                    future.set_exception(ModelError(error["code"], error["message"], error.get("data")))
            else:
                future.set_result(message["result"])
            return
        method, params = message["method"], message.get("params", {})
        if not isinstance(method, str) or ("id" in message and not is_request_id(request_id)):
            await self.reject(request_id if is_request_id(request_id) else None,
                              RpcError(-32600, "Request requires a method string and a string/integer id if present."))
            return
        if not isinstance(params, dict):
            if "id" in message:
                await self.reject(request_id, RpcError(-32602, f"{method}: params must be an object."))
            else:
                await self.log("error", f"Notification method={method[:200]} requires object params.")
            return
        if "id" not in message:
            if method == "notifications/initialized":
                if self.phase == "accepted":
                    self.phase = "ready"
                    await self.log("info", "Python backend initialized.")
                else:
                    await self.log("error", "notifications/initialized received before initialize or more than once.")
            elif method == "notifications/cancelled":
                cancelled_id = params.get("requestId")
                if not is_request_id(cancelled_id):
                    await self.log("error", "notifications/cancelled.requestId must be a string or integer.")
                    return
                reason = params.get("reason", CANCEL_REASON)
                future = self.pending.pop(cancelled_id, None)
                if future is not None and not future.done():
                    future.cancel(reason)
                task = self.calls.get(cancelled_id)
                if task is not None and not task.cancelling():
                    task.cancel(reason)
            else:
                await self.log("info", f"Ignored notification method={method[:200]}")
            return
        if request_id in self.calls:
            await self.reject(request_id, RpcError(-32600, "Request id is already active."))
            return
        if method == "ping":
            await self.send({"jsonrpc": "2.0", "id": request_id, "result": {}})
            return
        if method == "initialize":
            try:
                result = await self.initialize(params)
            except RpcError as error:
                await self.reject(request_id, error)
                return
            await self.send({"jsonrpc": "2.0", "id": request_id, "result": result})
            return
        if self.phase != "ready":
            await self.reject(request_id, RpcError(-32002, f"{method}: initialization is incomplete."))
            return
        if len(self.calls) >= MAX_PENDING:
            await self.reject(request_id, RpcError(-32000, "At most 128 concurrent tool requests are allowed."))
            return
        task = asyncio.create_task(self.serve_request(request_id, method, params))
        self.calls[request_id] = task
        task.add_done_callback(lambda done: self.finish_call(request_id, done))

    async def run(self) -> None:
        try:
            while True:
                # A thread handles Windows pipes; handlers and host responses keep running independently.
                frame = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_FRAME_BYTES + 2)
                if not frame:
                    return
                if len(frame.rstrip(b"\r\n")) > MAX_FRAME_BYTES:
                    await self.reject(None, RpcError(-32600, "Incoming JSON-RPC frame exceeds 128 MiB; closing stdio."))
                    return
                try:
                    message = json.loads(frame.decode("utf-8"), parse_constant=reject_non_json_number,
                                         parse_float=parse_json_float)
                except (ValueError, UnicodeError, RecursionError):
                    await self.reject(None, RpcError(-32700, "Invalid UTF-8 JSON in stdio frame."))
                    continue
                await self.receive(message)
        finally:
            self.phase = "closed"
            running = list(self.calls.values())
            for task in running:
                task.cancel("Host stdin closed; external effects are not rolled back.")
            for future in self.pending.values():
                future.cancel("Host stdin closed.")
            await asyncio.gather(*running, return_exceptions=True)
            self.calls.clear()
            self.pending.clear()


if __name__ == "__main__":
    manifest = json.loads(Path(__file__).with_name("manifest.json").read_text(encoding="utf-8"))
    asyncio.run(Backend(manifest).run())
