"""Run real-model App Server regression tests in a new isolated home."""

import argparse
import ctypes
import getpass
import json
import os
from pathlib import Path
import queue
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
SERVER = HERE.parents[1]
AGENT = SERVER.parent


def executable(value, name):
    resolved = shutil.which(value or name)
    if not resolved:
        raise ValueError(f"{name} not found; install it or provide its executable path")
    path = Path(resolved).resolve()
    if name == "bun" and path.suffix.lower() in (".cmd", ".ps1"):
        path = path.parent / "node_modules/bun/bin/bun.exe"
    if not path.is_file() or path.suffix.lower() in (".cmd", ".ps1"):
        raise ValueError(f"Provide the real {name} executable, not a shell shim")
    return str(path)


def build(args, bun):
    build_env = os.environ.copy()
    build_env.pop("MATCHA_TEST_KEY", None)
    if args.server:
        server = Path(args.server).resolve(strict=True)
    else:
        subprocess.run(
            ["cargo", "build", "--release", "--manifest-path", str(SERVER / "Cargo.toml")],
            cwd=AGENT, env=build_env, check=True,
        )
        server = SERVER / "target/release" / (
            "matcha-app-server.exe" if os.name == "nt" else "matcha-app-server"
        )
    if args.cli:
        cli = Path(args.cli).resolve(strict=True)
    else:
        (SERVER / "target").mkdir(exist_ok=True)
        output = Path(tempfile.mkdtemp(prefix="live-cli-", dir=SERVER / "target"))
        subprocess.run(
            [bun, str(AGENT / "node_modules/vite/bin/vite.js"), "build", "--outDir", str(output), "--logLevel", "warn"],
            cwd=AGENT, env=build_env, check=True,
        )
        cli = output / "cli.js"
    return server, cli.resolve(strict=True)


def isolated_env(root, models, base_url, key, timeout, require_thinking):
    inherited = {
        "SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP",
        "SYSTEMDRIVE", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
    }
    env = {k: v for k, v in os.environ.items() if k.upper() in inherited}
    env.update(
        HOME=str(root / "home"), USERPROFILE=str(root / "home"),
        APPDATA=str(root / "appdata"), LOCALAPPDATA=str(root / "local"),
        MATCHA_TEST_ROOT=str(root), MATCHA_TEST_BASE_URL=base_url,
        MATCHA_TEST_MODELS=json.dumps(models), MATCHA_TEST_KEY=key,
        MATCHA_TEST_AUTH=secrets.token_hex(24),
        MATCHA_TEST_TIMEOUT=str(timeout),
        MATCHA_TEST_REQUIRE_THINKING="1" if require_thinking else "0",
        MATCHA_TEST_MAX_TOKENS="4096",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", CLAUDE_CODE_DISABLE_CRON="1",
        DISABLE_TELEMETRY="1", DISABLE_ERROR_REPORTING="1",
    )
    for index, model in enumerate(models):
        env[f"MATCHA_TEST_FAST_{index}"] = model
    return env


class ChildHandles:
    """Retain Windows process identity before exit, rather than trusting reused PIDs."""

    def __init__(self, root):
        self.root = root
        self.handles = {}
        self.stopped = threading.Event()
        self.kernel = None
        if os.name == "nt":
            self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            self.kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
            self.kernel.OpenProcess.restype = ctypes.c_void_p
            self.kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            self.kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        self.thread = threading.Thread(target=self.observe, daemon=True)
        self.thread.start()

    def observe(self):
        seen = set()
        while not self.stopped.wait(0.02):
            children = self.root / "children.jsonl"
            if not children.exists():
                continue
            for line in children.read_text(encoding="utf-8").splitlines():
                try:
                    child = json.loads(line)
                except ValueError:
                    continue  # A concurrently appended final line may still be incomplete.
                pid = child["pid"]
                if pid in seen:
                    continue
                if self.kernel:
                    handle = self.kernel.OpenProcess(0x100000, False, pid)
                    if handle:
                        self.handles[pid] = handle
                        seen.add(pid)
                else:
                    self.handles[pid] = None
                    seen.add(pid)

    def finish(self):
        self.stopped.set()
        self.thread.join()
        remaining = []
        for pid, handle in self.handles.items():
            if self.kernel:
                if self.kernel.WaitForSingleObject(handle, 0) != 0:
                    remaining.append(pid)
                self.kernel.CloseHandle(handle)
            else:
                try:
                    os.kill(pid, 0)
                    remaining.append(pid)
                except ProcessLookupError:
                    pass
        children = self.root / "children.jsonl"
        expected = len(children.read_text(encoding="utf-8").splitlines()) if children.exists() else 0
        return {
            "observedCliProcesses": len(self.handles),
            "expectedCliProcesses": expected,
            "processIdentityCheck": "heldWindowsHandles" if self.kernel else "pidLivenessOnly",
            "remainingKnownCliPids": remaining,
        }


def run(args, server_path, cli, bun, node, models, base_url, key):
    root = Path(tempfile.mkdtemp(prefix="matcha-model-tests-"))
    for name in ("server", "home", "cwd", "raw", "appdata", "local"):
        (root / name).mkdir()
    env = isolated_env(root, models, base_url, key, args.timeout, args.require_thinking)
    config = {
        "listen": "127.0.0.1:0", "authTokenEnv": "MATCHA_TEST_AUTH",
        "cli": {"command": bun, "args": [str(HERE / "capture.mjs"), str(cli)], "env": {}},
    }
    (root / "server/matcha-agent.json").write_text(json.dumps(config), encoding="utf-8")
    server = subprocess.Popen(
        [str(server_path), "--home", str(root / "server")], cwd=root / "cwd", env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        text=True, encoding="utf-8",
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )
    addresses = queue.Queue()

    def read_address():
        for line in server.stderr:
            prefix = "matcha-app-server listening on http://"
            if line.startswith(prefix):
                addresses.put(line.strip()[len(prefix):])
        addresses.put(None)

    threading.Thread(target=read_address, daemon=True).start()
    handles = ChildHandles(root)
    client = None
    passed = False
    forced = False
    failure = None
    print(f"Real model tests (billable); isolated report directory: {root}", flush=True)
    try:
        address = addresses.get(timeout=30)
        if address is None:
            raise RuntimeError("server_exited_before_listen")
        client = subprocess.Popen(
            [node, str(HERE / "scenarios.mjs"), "http://" + address], cwd=root / "cwd", env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        )
        output, _ = client.communicate(timeout=args.timeout * (len(models) * 6 + 14))
        print(output.replace(key, "[REDACTED]"), end="", flush=True)
        passed = client.returncode == 0
    except queue.Empty:
        failure = "server_start_deadline"
    except subprocess.TimeoutExpired:
        failure = "test_suite_deadline"
    except KeyboardInterrupt:
        failure = "test_interrupted"
    except (OSError, RuntimeError):
        failure = "test_process_failed"
    finally:
        if client is not None and client.poll() is None:
            client.terminate()
            client.communicate(timeout=10)
        if server.poll() is None:
            try:
                server.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
                server.wait(timeout=40)
            except (OSError, subprocess.TimeoutExpired):
                forced = True
                server.terminate()
                server.wait(timeout=15)
        cleanup = handles.finish()
        leaks = []
        for file in root.rglob("*"):
            if file.is_file() and key.encode() in file.read_bytes():
                leaks.append(str(file.relative_to(root)))
        cleanup.update(
            clientPassed=passed, serverExit=server.returncode, forced=forced,
            failure=failure, credentialLeakFiles=leaks,
        )
        (root / "cleanup.json").write_text(json.dumps(cleanup, indent=2), encoding="utf-8")
        print(json.dumps({"cleanup": cleanup, "reportDirectory": str(root)}), flush=True)
    return 0 if (
        passed and server.returncode == 0 and not forced and not failure and not leaks
        and not cleanup["remainingKnownCliPids"]
        and cleanup["observedCliProcesses"] == cleanup["expectedCliProcesses"]
    ) else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", help="Use an existing built cli.js; otherwise build current Vite source")
    parser.add_argument("--server", help="Use an existing App Server binary; otherwise cargo build --release")
    parser.add_argument("--bun", help="Real Bun executable path")
    parser.add_argument("--node", help="Node 22+ executable path")
    parser.add_argument("--timeout", type=int, default=180, help="Per-run test deadline in seconds")
    parser.add_argument("--require-thinking", action="store_true", help="Fail if no thinking deltas are observed")
    args = parser.parse_args()
    try:
        base_url = os.environ.get("MATCHA_TEST_BASE_URL", "").strip()
        url = urlsplit(base_url)
        if (
            url.scheme not in ("http", "https") or not url.hostname or url.username or url.password
            or url.query or url.fragment
            or url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1")
        ):
            raise ValueError("Set MATCHA_TEST_BASE_URL to an HTTPS OpenAI-compatible base URL")
        models = [m.strip() for m in os.environ.get("MATCHA_TEST_MODELS", "").split(",") if m.strip()]
        if not models or len(set(models)) != len(models):
            raise ValueError("Set MATCHA_TEST_MODELS to one model or a comma-separated unique model list")
        if args.timeout <= 0:
            raise ValueError("--timeout must be positive")
        key = os.environ.get("MATCHA_TEST_KEY", "")
        if not key and sys.stdin.isatty():
            key = getpass.getpass("Model API key (not saved): ")
        if not key or key.strip() != key or any(ord(c) < 32 for c in key):
            raise ValueError("Set MATCHA_TEST_KEY or enter it at the hidden prompt")
        bun = executable(args.bun, "bun")
        node = executable(args.node, "node")
        version = subprocess.check_output([node, "--version"], text=True).strip()
        if int(version.lstrip("v").split(".")[0]) < 22:
            raise ValueError("Node 22+ is required for the built-in WebSocket client")
        server, cli = build(args, bun)
        return run(args, server, cli, bun, node, models, base_url, key)
    except ValueError as error:
        print(str(error), file=sys.stderr)
    except (OSError, subprocess.CalledProcessError):
        print("Test prerequisites/build failed; check Rust, Bun, Node and installed CLI dependencies", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
