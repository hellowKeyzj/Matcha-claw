from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import struct
import time
import uuid
from dataclasses import dataclass
from typing import Any


class OpenClawBrowserGatewayError(RuntimeError):
    def __init__(self, message: str, *, code: str | int | None = None, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


def _read_env(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


@dataclass(frozen=True)
class OpenClawBrowserGatewayClient:
    port: int
    token: str | None = None
    host: str = "127.0.0.1"
    timeout: float = 10.0

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

        timeout = 10.0
        raw_timeout = _read_env("MATCHACLAW_BROWSER_GATEWAY_TIMEOUT_SECONDS")
        if raw_timeout is not None:
            try:
                timeout = float(raw_timeout)
            except ValueError as exc:
                raise OpenClawBrowserGatewayError(
                    f"Invalid gateway timeout: {raw_timeout}",
                    code="invalid_gateway_timeout",
                ) from exc
            if timeout <= 0:
                raise OpenClawBrowserGatewayError(
                    f"Invalid gateway timeout: {raw_timeout}",
                    code="invalid_gateway_timeout",
                )

        return cls(
            port=port,
            token=(
                _read_env("MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN")
                or _read_env("OPENCLAW_GATEWAY_TOKEN")
                or _read_env("CLAWDBOT_GATEWAY_TOKEN")
            ),
            host=_read_env("MATCHACLAW_RUNTIME_HOST_GATEWAY_HOST") or "127.0.0.1",
            timeout=timeout,
        )

    def request(self, params: dict[str, Any]) -> dict[str, Any]:
        result = self.gateway_rpc("browser.request", params)
        if isinstance(result, dict):
            return result
        return {"ok": True, "result": result}

    def gateway_rpc(self, method: str, params: dict[str, Any] | None = None) -> Any:
        with _GatewayWebSocket(self.host, self.port, self.timeout) as ws:
            ws.connect(self._connect_params())
            return ws.rpc(method, params or {})

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
    def __init__(self, host: str, port: int, timeout: float) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout
        self.socket: socket.socket | None = None

    def __enter__(self) -> "_GatewayWebSocket":
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        self.close()

    def close(self) -> None:
        if self.socket is None:
            return
        try:
            self.socket.close()
        finally:
            self.socket = None

    def connect(self, connect_params: dict[str, Any]) -> None:
        sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        sock.settimeout(self.timeout)
        self.socket = sock
        self._send_http_upgrade()
        self._read_http_upgrade_response()

        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            frame = self._recv_json()
            if frame.get("type") == "event" and frame.get("event") == "connect.challenge":
                request_id = f"connect-{uuid.uuid4().hex}"
                self._send_json({
                    "type": "req",
                    "id": request_id,
                    "method": "connect",
                    "params": connect_params,
                })
                response = self._wait_for_response(request_id, deadline)
                if response.get("ok") is False or response.get("error"):
                    raise _gateway_error("Gateway connect failed", response.get("error"))
                return
        raise OpenClawBrowserGatewayError("Gateway connect timeout", code="connect_timeout")

    def rpc(self, method: str, params: dict[str, Any]) -> Any:
        request_id = f"req-{uuid.uuid4().hex}"
        deadline = time.monotonic() + self.timeout
        self._send_json({
            "type": "req",
            "id": request_id,
            "method": method,
            "params": params,
        })
        response = self._wait_for_response(request_id, deadline)
        if response.get("ok") is False or response.get("error"):
            raise _gateway_error(f"Gateway RPC failed: {method}", response.get("error"))
        return response.get("payload", {})

    def _wait_for_response(self, request_id: str, deadline: float) -> dict[str, Any]:
        while time.monotonic() < deadline:
            frame = self._recv_json()
            if frame.get("type") == "res" and frame.get("id") == request_id:
                return frame
        raise OpenClawBrowserGatewayError("Gateway RPC timeout", code="rpc_timeout")

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

    def _read_http_upgrade_response(self) -> None:
        buffer = b""
        while b"\r\n\r\n" not in buffer:
            chunk = self._recv_raw(4096)
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

    def _recv_json(self) -> dict[str, Any]:
        opcode, payload = self._recv_frame()
        if opcode == 0x8:
            raise OpenClawBrowserGatewayError("Gateway websocket closed", code="websocket_closed")
        if opcode == 0x9:
            self._send_frame(payload, opcode=0xA)
            return self._recv_json()
        if opcode != 0x1:
            return self._recv_json()
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

    def _recv_frame(self) -> tuple[int, bytes]:
        first_two = self._recv_exact(2)
        first, second = first_two[0], first_two[1]
        opcode = first & 0x0F
        masked = (second & 0x80) != 0
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else b""
        payload = self._recv_exact(length) if length else b""
        if masked:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        return opcode, payload

    def _recv_exact(self, length: int) -> bytes:
        chunks = bytearray()
        while len(chunks) < length:
            chunk = self._recv_raw(length - len(chunks))
            if not chunk:
                raise OpenClawBrowserGatewayError("Gateway socket closed", code="socket_closed")
            chunks.extend(chunk)
        return bytes(chunks)

    def _send_raw(self, payload: bytes) -> None:
        if self.socket is None:
            raise OpenClawBrowserGatewayError("Gateway socket unavailable", code="socket_unavailable")
        self.socket.sendall(payload)

    def _recv_raw(self, size: int) -> bytes:
        if self.socket is None:
            raise OpenClawBrowserGatewayError("Gateway socket unavailable", code="socket_unavailable")
        return self.socket.recv(size)


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

    result = OpenClawBrowserGatewayClient.from_environment().request(params)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
