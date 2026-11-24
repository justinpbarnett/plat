import copy
import json
import os
import subprocess
import tempfile
from pathlib import Path

FORMAT = "plat/1"

DEFAULT_CONFIG = {
    "views": {"architecture": True},
    "show": {"tests": False, "private": False, "dunder": False},
    "scan": {"generated": False, "vendored": False, "ignored": False, "include": [], "exclude": []},
    "enrich": {"command": "claude -p --model sonnet", "batch": 150},
    "editor": "code",
}


def find_root(path: str | os.PathLike = ".") -> Path:
    start = Path(path).resolve()
    probe = start if start.is_dir() else start.parent
    for folder in (probe, *probe.parents):
        if (folder / ".plat").is_dir():
            return folder
    result = subprocess.run(["git", "-C", str(probe), "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    if result.returncode == 0:
        return Path(result.stdout.strip())
    return probe


def plat_dir(root: Path) -> Path:
    folder = root / ".plat"
    folder.mkdir(exist_ok=True)
    ignore = folder / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n")
    return folder


def model_path(root: Path) -> Path:
    return root / ".plat" / "model.json"


def config_path(root: Path) -> Path:
    return root / ".plat" / "config.json"


def empty_overlay() -> dict:
    return {"components": [], "roles": {}, "links": [], "hidden": [], "layout": {}, "basis": {}}


def empty_model() -> dict:
    return {"format": FORMAT, "facts": {"elements": {}, "relationships": []}, "overlay": empty_overlay()}


def load_model(root: Path) -> dict:
    path = model_path(root)
    if not path.exists():
        return empty_model()
    return json.loads(path.read_text())


def has_model(root: Path) -> bool:
    return model_path(root).exists()


def write_json(path: Path, data: dict) -> None:
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    with os.fdopen(handle, "w") as stream:
        stream.write(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)


def save_model(root: Path, model: dict) -> None:
    plat_dir(root)
    write_json(model_path(root), model)


def merged(base: dict, override: dict) -> dict:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merged(result[key], value)
        else:
            result[key] = value
    return result


def load_config(root: Path) -> dict:
    path = config_path(root)
    if not path.exists():
        if path.parent.is_dir():
            write_json(path, DEFAULT_CONFIG)
        return copy.deepcopy(DEFAULT_CONFIG)
    return merged(DEFAULT_CONFIG, json.loads(path.read_text()))
