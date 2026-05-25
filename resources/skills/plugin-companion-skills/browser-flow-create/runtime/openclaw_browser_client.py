from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import struct
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any


DEFAULT_CONNECT_TIMEOUT_SECONDS = 10.0
DEFAULT_RPC_TIMEOUT_SECONDS = 60.0
MIN_SOCKET_TIMEOUT_SECONDS = 0.001
READER_SOCKET_TIMEOUT_SECONDS = 1.0


class OpenClawBrowserGatewayError(RuntimeError):
    def __init__(self, message: str, *, code: str | int | None = None, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


class _SocketReadTimeout(TimeoutError):
    pass


@dataclass
class _PendingRpc:
    response: dict[str, Any] | None = None
    error: OpenClawBrowserGatewayError | None = None


def _read_env(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _read_positive_float_env(name: str, default: float, code: str) -> float:
    raw_value = _read_env(name)
    if raw_value is None:
        return default
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise OpenClawBrowserGatewayError(
            f"Invalid gateway timeout {name}: {raw_value}",
            code=code,
        ) from exc
    if value <= 0:
        raise OpenClawBrowserGatewayError(
            f"Invalid gateway timeout {name}: {raw_value}",
            code=code,
        )
    return value


@dataclass
class OpenClawBrowserGatewayClient:
    port: int
    token: str | None = None
    host: str = "127.0.0.1"
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT_SECONDS
    default_rpc_timeout: float = DEFAULT_RPC_TIMEOUT_SECONDS
    _ws: "_GatewayWebSocket | None" = field(default=None, init=False, repr=False)

    @classmethod
    def from_environment(cls) -> "OpenClawBrowserGatewayClient":
        raw_port = _read_env("MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT") or _read_env("OPENCLAW_GATEWAY_PORT")
        if raw_port is None:
            raise OpenClawBrowserGatewayError(
                "Missing required gateway port: MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT or OPENCLAW_GATEWAY_PORT",
                code="missing_gateway_port",
            )
        try:
            port = int(raw_port, 10)
        except ValueError as exc:
            raise OpenClawBrowserGatewayError(
                f"Invalid gateway port: {raw_port}",
                code="invalid_gateway_port",
            ) from exc
        if port <= 0 or port > 65535:
            raise OpenClawBrowserGatewayError(
                f"Invalid gateway port: {raw_port}",
                code="invalid_gateway_port",
            )

        return cls(
            port=port,
            token=(
                _read_env("MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN")
                or _read_env("OPENCLAW_GATEWAY_TOKEN")
                or _read_env("CLAWDBOT_GATEWAY_TOKEN")
            ),
            host=_read_env("MATCHACLAW_RUNTIME_HOST_GATEWAY_HOST") or "127.0.0.1",
            connect_timeout=_read_positive_float_env(
                "MATCHACLAW_BROWSER_GATEWAY_CONNECT_TIMEOUT_SECONDS",
                DEFAULT_CONNECT_TIMEOUT_SECONDS,
                "invalid_gateway_connect_timeout",
            ),
            default_rpc_timeout=_read_positive_float_env(
                "MATCHACLAW_BROWSER_GATEWAY_RPC_TIMEOUT_SECONDS",
                DEFAULT_RPC_TIMEOUT_SECONDS,
                "invalid_gateway_rpc_timeout",
            ),
        )

    def __enter__(self) -> "OpenClawBrowserGatewayClient":
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        self.close()

    def close(self) -> None:
        if self._ws is None:
            return
        try:
            self._ws.close()
        finally:
            self._ws = None

    def request(self, params: dict[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
        result = self.gateway_rpc("browser.request", params, timeout=timeout)
        if isinstance(result, dict):
            return result
        return {"ok": True, "result": result}

    def gateway_rpc(self, method: str, params: dict[str, Any] | None = None, *, timeout: float | None = None) -> Any:
        ws = self._ensure_connected()
        return ws.rpc(method, params or {}, timeout if timeout is not None else self.default_rpc_timeout)

    def _ensure_connected(self) -> "_GatewayWebSocket":
        if self._ws is not None and self._ws.is_connected():
            return self._ws
        self.close()
        ws = _GatewayWebSocket(self.host, self.port, self.connect_timeout)
        try:
            ws.connect(self._connect_params())
        except Exception:
            ws.close()
            raise
        self._ws = ws
        return ws

    def _connect_params(self) -> dict[str, Any]:
        params: dict[str, Any] = {
            "minProtocol": 3,
            "maxProtocol": 3,
            "client": {
                "id": "gateway-client",
                "displayName": "Browser Flow Python Runner",
                "version": "0.1.0",
                "platform": "python",
                "mode": "backend",
                "deviceFamily": "desktop",
            },
            "caps": [],
            "role": "operator",
            "scopes": ["operator.read", "operator.write", "operator.admin", "operator.approvals"],
        }
        if self.token:
            params["auth"] = {"token": self.token}
        return params


class _GatewayWebSocket:
    def __init__(self, host: str, port: int, connect_timeout: float) -> None:
        self.host = host
        self.port = port
        self.connect_timeout = connect_timeout
        self.socket: socket.socket | None = None
        self._condition = threading.Condition()
        self._pending: dict[str, _PendingRpc] = {}
        self._reader_thread: threading.Thread | None = None
        self._send_lock = threading.Lock()
        self._closed = False
        self._close_error: OpenClawBrowserGatewayError | None = None

    def is_connected(self) -> bool:
        return self.socket is not None and not self._closed

    def close(self) -> None:
        with self._condition:
            if not self._closed:
                self._closed = True
                error = OpenClawBrowserGatewayError("Gateway websocket closed", code="websocket_closed")
                self._fail_pending_locked(error)
        sock = self.socket
        self.socket = None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass
        reader = self._reader_thread
        if reader is not None and reader is not threading.current_thread():
            reader.join(timeout=1.0)

    def connect(self, connect_params: dict[str, Any]) -> None:
        try:
            sock = socket.create_connection((self.host, self.port), timeout=self.connect_timeout)
        except socket.timeout as exc:
            raise OpenClawBrowserGatewayError("Gateway connect timeout", code="connect_timeout") from exc
        sock.settimeout(self.connect_timeout)
        self.socket = sock
        deadline = time.monotonic() + self.connect_timeout
        try:
            self._send_http_upgrade()
            self._read_http_upgrade_response(deadline)

            while time.monotonic() < deadline:
                frame = self._recv_json(deadline, timeout_code="connect_timeout")
                if frame.get("type") == "event" and frame.get("event") == "connect.challenge":
                    request_id = f"connect-{uuid.uuid4().hex}"
                    self._send_json({
                        "type": "req",
                        "id": request_id,
                        "method": "connect",
                        "params": connect_params,
                    })
                    response = self._wait_for_response(request_id, deadline, timeout_code="connect_timeout")
                    if response.get("ok") is False or response.get("error"):
                        raise _gateway_error("Gateway connect failed", response.get("error"))
                    self._start_reader()
                    return
        except socket.timeout as exc:
            raise OpenClawBrowserGatewayError("Gateway connect timeout", code="connect_timeout") from exc
        raise OpenClawBrowserGatewayError("Gateway connect timeout", code="connect_timeout")

    def rpc(self, method: str, params: dict[str, Any], timeout: float) -> Any:
        request_id = f"req-{uuid.uuid4().hex}"
        deadline = time.monotonic() + timeout
        pending = _PendingRpc()
        with self._condition:
            if self._closed:
                raise self._close_error or OpenClawBrowserGatewayError("Gateway websocket closed", code="websocket_closed")
            self._pending[request_id] = pending
        try:
            self._send_json({
                "type": "req",
                "id": request_id,
                "method": method,
                "params": params,
            })
        except Exception as exc:
            with self._condition:
                self._pending.pop(request_id, None)
            if isinstance(exc, OpenClawBrowserGatewayError):
                raise
            raise OpenClawBrowserGatewayError("Gateway socket send failed", code="socket_send_failed") from exc

        with self._condition:
            while pending.response is None and pending.error is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._pending.pop(request_id, None)
                    raise OpenClawBrowserGatewayError(_timeout_message("rpc_timeout"), code="rpc_timeout")
                self._condition.wait(remaining)
            if pending.error is not None:
                raise pending.error
            response = pending.response
        if response is None:
            raise OpenClawBrowserGatewayError("Gateway RPC failed: missing response", code="missing_response")
        if response.get("ok") is False or response.get("error"):
            raise _gateway_error(f"Gateway RPC failed: {method}", response.get("error"))
        return response.get("payload", {})

    def _start_reader(self) -> None:
        self._reader_thread = threading.Thread(target=self._reader_loop, name="openclaw-gateway-reader", daemon=True)
        self._reader_thread.start()

    def _reader_loop(self) -> None:
        try:
            while True:
                with self._condition:
                    if self._closed:
                        return
                opcode, payload = self._recv_frame_blocking()
                if opcode == 0x8:
                    self._fail_all(OpenClawBrowserGatewayError("Gateway websocket closed", code="websocket_closed"))
                    return
                if opcode == 0x9:
                    self._send_frame(payload, opcode=0xA)
                    continue
                if opcode != 0x1:
                    continue
                try:
                    value = json.loads(payload.decode("utf-8"))
                except json.JSONDecodeError as exc:
                    raise OpenClawBrowserGatewayError("Gateway sent invalid JSON", code="invalid_json") from exc
                if not isinstance(value, dict):
                    raise OpenClawBrowserGatewayError("Gateway sent non-object JSON", code="invalid_json")
                if value.get("type") != "res" or not isinstance(value.get("id"), str):
                    continue
                with self._condition:
                    pending = self._pending.pop(value["id"], None)
                    if pending is None:
                        continue
                    pending.response = value
                    self._condition.notify_all()
        except Exception as exc:
            if isinstance(exc, OpenClawBrowserGatewayError):
                error = exc
            else:
                error = OpenClawBrowserGatewayError("Gateway socket read failed", code="socket_read_failed")
            self._fail_all(error)

    def _fail_all(self, error: OpenClawBrowserGatewayError) -> None:
        with self._condition:
            self._closed = True
            self._close_error = error
            self._fail_pending_locked(error)

    def _fail_pending_locked(self, error: OpenClawBrowserGatewayError) -> None:
        self._close_error = error
        for pending in self._pending.values():
            pending.error = error
        self._pending.clear()
        self._condition.notify_all()

    def _wait_for_response(self, request_id: str, deadline: float, *, timeout_code: str) -> dict[str, Any]:
        while time.monotonic() < deadline:
            frame = self._recv_json(deadline, timeout_code=timeout_code)
            if frame.get("type") == "res" and frame.get("id") == request_id:
                return frame
        raise OpenClawBrowserGatewayError(_timeout_message(timeout_code), code=timeout_code)

    def _send_http_upgrade(self) -> None:
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET /ws HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"\r\n"
        )
        self._send_raw(request.encode("ascii"))

    def _read_http_upgrade_response(self, deadline: float) -> None:
        buffer = b""
        while b"\r\n\r\n" not in buffer:
            chunk = self._recv_raw(4096, deadline, timeout_code="connect_timeout")
            if not chunk:
                break
            buffer += chunk
            if len(buffer) > 65536:
                break
        status_line = buffer.split(b"\r\n", 1)[0]
        if not status_line.startswith(b"HTTP/1.1 101") and not status_line.startswith(b"HTTP/1.0 101"):
            raise OpenClawBrowserGatewayError(
                f"Gateway websocket upgrade failed: {status_line.decode('latin1', errors='replace')}",
                code="websocket_upgrade_failed",
            )

    def _send_json(self, payload: dict[str, Any]) -> None:
        self._send_frame(json.dumps(payload, separators=(",", ":")).encode("utf-8"), opcode=0x1)

    def _recv_json(self, deadline: float, *, timeout_code: str) -> dict[str, Any]:
        opcode, payload = self._recv_frame(deadline, timeout_code=timeout_code)
        if opcode == 0x8:
            raise OpenClawBrowserGatewayError("Gateway websocket closed", code="websocket_closed")
        if opcode == 0x9:
            self._send_frame(payload, opcode=0xA)
            return self._recv_json(deadline, timeout_code=timeout_code)
        if opcode != 0x1:
            return self._recv_json(deadline, timeout_code=timeout_code)
        try:
            value = json.loads(payload.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise OpenClawBrowserGatewayError("Gateway sent invalid JSON", code="invalid_json") from exc
        if not isinstance(value, dict):
            raise OpenClawBrowserGatewayError("Gateway sent non-object JSON", code="invalid_json")
        return value

    def _send_frame(self, payload: bytes, *, opcode: int) -> None:
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length <= 0xFFFF:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self._send_raw(bytes(header) + mask + masked)

    def _recv_frame(self, deadline: float, *, timeout_code: str) -> tuple[int, bytes]:
        first_two = self._recv_exact(2, deadline, timeout_code=timeout_code)
        first, second = first_two[0], first_two[1]
        opcode = first & 0x0F
        masked = (second & 0x80) != 0
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2, deadline, timeout_code=timeout_code))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8, deadline, timeout_code=timeout_code))[0]
        mask = self._recv_exact(4, deadline, timeout_code=timeout_code) if masked else b""
        payload = self._recv_exact(length, deadline, timeout_code=timeout_code) if length else b""
        if masked:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        return opcode, payload

    def _recv_frame_blocking(self) -> tuple[int, bytes]:
        first_two = self._recv_exact_blocking(2)
        first, second = first_two[0], first_two[1]
        opcode = first & 0x0F
        masked = (second & 0x80) != 0
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact_blocking(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact_blocking(8))[0]
        mask = self._recv_exact_blocking(4) if masked else b""
        payload = self._recv_exact_blocking(length) if length else b""
        if masked:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        return opcode, payload

    def _recv_exact(self, length: int, deadline: float, *, timeout_code: str) -> bytes:
        chunks = bytearray()
        while len(chunks) < length:
            chunk = self._recv_raw(length - len(chunks), deadline, timeout_code=timeout_code)
            if not chunk:
                raise OpenClawBrowserGatewayError("Gateway socket closed", code="socket_closed")
            chunks.extend(chunk)
        return bytes(chunks)

    def _recv_exact_blocking(self, length: int) -> bytes:
        chunks = bytearray()
        while len(chunks) < length:
            try:
                chunk = self._recv_raw_blocking(length - len(chunks))
            except _SocketReadTimeout:
                with self._condition:
                    if self._closed:
                        raise OpenClawBrowserGatewayError("Gateway websocket closed", code="websocket_closed")
                continue
            if not chunk:
                raise OpenClawBrowserGatewayError("Gateway socket closed", code="socket_closed")
            chunks.extend(chunk)
        return bytes(chunks)

    def _send_raw(self, payload: bytes) -> None:
        if self.socket is None:
            raise OpenClawBrowserGatewayError("Gateway socket unavailable", code="socket_unavailable")
        with self._send_lock:
            self.socket.sendall(payload)

    def _recv_raw(self, size: int, deadline: float, *, timeout_code: str) -> bytes:
        if self.socket is None:
            raise OpenClawBrowserGatewayError("Gateway socket unavailable", code="socket_unavailable")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise OpenClawBrowserGatewayError(_timeout_message(timeout_code), code=timeout_code)
        self.socket.settimeout(max(MIN_SOCKET_TIMEOUT_SECONDS, remaining))
        try:
            return self.socket.recv(size)
        except socket.timeout as exc:
            raise OpenClawBrowserGatewayError(_timeout_message(timeout_code), code=timeout_code) from exc

    def _recv_raw_blocking(self, size: int) -> bytes:
        if self.socket is None:
            raise OpenClawBrowserGatewayError("Gateway socket unavailable", code="socket_unavailable")
        self.socket.settimeout(READER_SOCKET_TIMEOUT_SECONDS)
        try:
            return self.socket.recv(size)
        except socket.timeout as exc:
            raise _SocketReadTimeout() from exc


def _timeout_message(timeout_code: str) -> str:
    return "Gateway connect timeout" if timeout_code == "connect_timeout" else "Gateway RPC timeout"


def _gateway_error(prefix: str, error: Any) -> OpenClawBrowserGatewayError:
    if isinstance(error, dict):
        message = error.get("message") if isinstance(error.get("message"), str) else str(error)
        return OpenClawBrowserGatewayError(
            f"{prefix}: {message}",
            code=error.get("code"),
            details=error.get("details"),
        )
    if error is None:
        return OpenClawBrowserGatewayError(prefix)
    return OpenClawBrowserGatewayError(f"{prefix}: {error}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Call OpenClaw Browser Relay through browser.request")
    parser.add_argument("--action", default="status")
    parser.add_argument("--params", help="JSON object with Browser Relay action params")
    args = parser.parse_args()

    params: dict[str, Any]
    if args.params:
        parsed = json.loads(args.params)
        if not isinstance(parsed, dict):
            raise SystemExit("--params must be a JSON object")
        params = parsed
    else:
        params = {"action": args.action}

    with OpenClawBrowserGatewayClient.from_environment() as client:
        result = client.request(params)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
