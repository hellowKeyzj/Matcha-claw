from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any


RUNTIME_FILES = ("agent_browser_flow_runner.py", "openclaw_browser_client.py")


class RuntimeDistributionError(RuntimeError):
    pass


def safe_file_stem(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-") or "flow"


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeDistributionError(f"JSON file must contain an object: {path}")
    return value


def find_recipe(workspace_dir: Path, recipe_id: str, platform_id: str | None) -> tuple[Path, dict[str, Any]]:
    platforms_dir = workspace_dir / "browser-flows" / "platforms"
    platform_dirs = [platforms_dir / platform_id] if platform_id else sorted(path for path in platforms_dir.iterdir() if path.is_dir())
    matches: list[tuple[Path, dict[str, Any]]] = []
    for platform_dir in platform_dirs:
        flows_dir = platform_dir / "flows"
        if not flows_dir.is_dir():
            continue
        for recipe_path in sorted(flows_dir.glob("*.recipe.json")):
            recipe = load_json(recipe_path)
            current_id = recipe.get("recipeId") or recipe.get("id") or recipe_path.name.removesuffix(".recipe.json")
            if current_id == recipe_id or recipe_path.stem == recipe_id or recipe_path.name == recipe_id:
                matches.append((recipe_path, recipe))
    if not matches:
        raise RuntimeDistributionError(f"Recipe not found: {recipe_id}")
    if len(matches) > 1:
        raise RuntimeDistributionError(f"Recipe id is ambiguous: {recipe_id}")
    return matches[0]


def copy_runtime(workspace_dir: Path) -> list[Path]:
    source_dir = Path(__file__).resolve().parent
    target_dir = workspace_dir / "browser-flows" / "_runtime"
    target_dir.mkdir(parents=True, exist_ok=True)
    copied: list[Path] = []
    for file_name in RUNTIME_FILES:
        source = source_dir / file_name
        target = target_dir / file_name
        if not source.is_file():
            raise RuntimeDistributionError(f"Runtime source file not found: {source}")
        shutil.copy2(source, target)
        copied.append(target)
    return copied


def default_output_path(workspace_dir: Path, recipe_path: Path, recipe_id: str) -> Path:
    platform_dir = recipe_path.parent.parent
    return platform_dir / "generated" / "python" / f"{safe_file_stem(recipe_id)}.py"


def entrypoint_source(recipe_id: str, default_mode: str) -> str:
    return f'''from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


RECIPE_ID = {recipe_id!r}
DEFAULT_ASSET_UPDATE_MODE = {default_mode!r}


def find_workspace_dir() -> Path:
    current = Path(__file__).resolve()
    for parent in (current.parent, *current.parents):
        if (parent / "browser-flows").is_dir():
            return parent
    raise RuntimeError("Could not locate workspace directory containing browser-flows")


def load_params(value: str | None) -> dict[str, Any]:
    if not value:
        return {{}}
    if value.startswith("@"):
        raw = Path(value[1:]).read_text(encoding="utf-8")
    else:
        raw = value
    params = json.loads(raw)
    if not isinstance(params, dict):
        raise ValueError("params JSON must be an object")
    return params


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=f"Run Browser Flow {{RECIPE_ID}} through workspace _runtime")
    parser.add_argument("params", nargs="?", help="Params JSON object, or @path/to/params.json")
    parser.add_argument("--asset-update-mode", choices=("execution", "learning"), default=DEFAULT_ASSET_UPDATE_MODE)
    parser.add_argument("--validation-smoke", action="store_true")
    parser.add_argument("--approve-risk", action="store_true")
    args = parser.parse_args(argv or sys.argv[1:])

    workspace_dir = find_workspace_dir()
    runner_path = workspace_dir / "browser-flows" / "_runtime" / "agent_browser_flow_runner.py"
    if not runner_path.is_file():
        raise RuntimeError(f"Browser Flow runtime is missing: {{runner_path}}")

    command = [
        sys.executable,
        str(runner_path),
        "--workspace-dir",
        str(workspace_dir),
        "--recipe-id",
        RECIPE_ID,
        "--params-json",
        json.dumps(load_params(args.params), ensure_ascii=False),
        "--asset-update-mode",
        args.asset_update_mode,
    ]
    if args.validation_smoke:
        command.append("--validation-smoke")
    if args.approve_risk:
        command.append("--approve-risk")

    completed = subprocess.run(command, text=True, encoding="utf-8")
    return int(completed.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
'''


def write_entrypoint(path: Path, recipe_id: str, default_mode: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(entrypoint_source(recipe_id, default_mode), encoding="utf-8")
    return path


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Copy Browser Flow runtime into a workspace and generate a thin Python entrypoint")
    parser.add_argument("--workspace-dir", required=True)
    parser.add_argument("--recipe-id", required=True)
    parser.add_argument("--platform-id")
    parser.add_argument("--output-path")
    parser.add_argument("--default-asset-update-mode", choices=("execution", "learning"), default="execution")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        workspace_dir = Path(args.workspace_dir).resolve()
        recipe_path, recipe = find_recipe(workspace_dir, args.recipe_id, args.platform_id)
        recipe_id = str(recipe.get("recipeId") or recipe.get("id") or args.recipe_id)
        runtime_paths = copy_runtime(workspace_dir)
        output_path = Path(args.output_path).resolve() if args.output_path else default_output_path(workspace_dir, recipe_path, recipe_id)
        entrypoint_path = write_entrypoint(output_path, recipe_id, args.default_asset_update_mode)
        payload = {
            "ok": True,
            "workspaceDir": str(workspace_dir),
            "recipeId": recipe_id,
            "runtimeFiles": [str(path) for path in runtime_paths],
            "entrypointPath": str(entrypoint_path),
        }
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": {"code": exc.__class__.__name__, "message": str(exc)}}, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
