import argparse
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--host", choices=["127.0.0.1"], default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    if not sys.flags.isolated or sys.version_info[:2] != (3, 12):
        parser.error("SearXNG requires Python 3.12 with -I")
    if not 0 <= args.port <= 65535:
        parser.error("port must be between 0 and 65535")
    root = Path(__file__).resolve().parent
    source = args.source.resolve(strict=True)
    settings = args.settings.resolve(strict=True)
    if not args.source.is_absolute() or source != root / "source":
        parser.error("source must be this resource's absolute source directory")
    if not args.settings.is_absolute() or settings.is_relative_to(root):
        parser.error("settings must be an absolute path outside immutable resources")
    if Path.cwd().resolve().is_relative_to(source):
        parser.error("working directory must not be the downloaded source")
    sys.dont_write_bytecode = True
    os.environ["SEARXNG_SETTINGS_PATH"] = str(settings)

    # Only searx is loaded from source: a planted json.py must never shadow stdlib.
    from waitress import create_server

    spec = importlib.machinery.PathFinder.find_spec("searx", [str(source)])
    if spec is None or spec.loader is None or spec.origin != str(source / "searx" / "__init__.py"):
        raise RuntimeError("invalid SearXNG source package")
    package = importlib.util.module_from_spec(spec)
    sys.modules["searx"] = package
    spec.loader.exec_module(package)
    from searx.webapp import app
    from searx.search.processors import PROCESSORS

    deadline = time.monotonic() + 30
    while not PROCESSORS:
        if time.monotonic() >= deadline:
            raise RuntimeError("SearXNG engine initialization timed out")
        time.sleep(0.1)
    server = create_server(app, host=args.host, port=args.port, threads=8)
    print(f"MATCHA_SEARXNG_READY {server.effective_port}", flush=True)
    server.run()


if __name__ == "__main__":
    main()
