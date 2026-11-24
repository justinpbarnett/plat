import json
import shutil
import sys
from pathlib import Path
from subprocess import TimeoutExpired
from tempfile import mkdtemp

from plat import toolchain
from plat.files import SourceFile


NODE = Path(__file__).with_name("node")
MANIFEST = NODE / "package.json"


def installed(folder: Path, dependencies: dict[str, str]) -> bool:
    for name, version in dependencies.items():
        manifest = folder / "node_modules" / name / "package.json"
        try:
            if json.loads(manifest.read_text(encoding="utf-8")).get("version") != version:
                return False
        except (FileNotFoundError, json.JSONDecodeError):
            return False
    return True


def cached_install(cache: Path, dependencies: dict[str, str]) -> Path | None:
    if installed(cache, dependencies):
        return cache
    try:
        name = (cache / "current").read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    if name.startswith("install-") and Path(name).name == name:
        folder = cache / name
        if installed(folder, dependencies):
            return folder
    return None


def parser_dir(npm: str) -> Path:
    dependencies = json.loads(MANIFEST.read_text(encoding="utf-8"))["dependencies"]
    base = toolchain.cache_dir().resolve()
    cache = base / (
        f"typescript-{dependencies['typescript']}-vue-{dependencies['@vue/compiler-sfc']}"
        f"-babel-{dependencies['@babel/parser']}"
    )
    existing = cached_install(cache, dependencies)
    if existing:
        return existing

    cache.mkdir(exist_ok=True)
    print("installing TypeScript and Vue parsers", file=sys.stderr, flush=True)
    staging = Path(mkdtemp(prefix="install-", dir=cache))
    published = False
    try:
        shutil.copyfile(MANIFEST, staging / "package.json")
        toolchain.run(
            [npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
             "--cache", str(base / "npm")],
            cwd=staging,
        )
        if not installed(staging, dependencies):
            raise toolchain.ExtractorFailed("npm did not install the pinned TypeScript and Vue parsers")
        existing = cached_install(cache, dependencies)
        if existing:
            return existing
        receipt = staging / "current"
        receipt.write_text(staging.name, encoding="utf-8")
        receipt.replace(cache / "current")
        published = True
        return staging
    finally:
        if not published:
            shutil.rmtree(staging, ignore_errors=True)


def extract(root: Path, files: list[SourceFile]) -> dict:
    node = toolchain.require("node")
    npm = toolchain.require("npm")
    try:
        cache = parser_dir(npm)
        request = {"root": str(root.resolve()), "files": [
            {"path": source.path, "language": source.language} for source in files
        ]}
        output = toolchain.run(
            [node, "--preserve-symlinks-main", "--preserve-symlinks", str(NODE / "extract.cjs"), str(cache)],
            stdin=json.dumps(request),
        )
        return json.loads(output)
    except (OSError, TimeoutExpired, json.JSONDecodeError) as problem:
        raise toolchain.ExtractorFailed(str(problem)) from problem
