import fnmatch
import os
import re
import subprocess
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

LANGUAGES = {
    ".py": "python",
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".vue": "vue",
    ".cs": "csharp",
}

FAMILIES = {"python": "python", "typescript": "typescript", "javascript": "typescript", "vue": "typescript", "csharp": "csharp"}

UNSUPPORTED = {
    ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".rb": "ruby", ".php": "php",
    ".swift": "swift", ".c": "c", ".h": "c", ".cc": "c++", ".cpp": "c++", ".hpp": "c++", ".cxx": "c++",
    ".m": "objective-c", ".scala": "scala", ".dart": "dart", ".ex": "elixir", ".exs": "elixir", ".erl": "erlang",
    ".hs": "haskell", ".lua": "lua", ".r": "r", ".jl": "julia", ".fs": "f#", ".vb": "visual basic", ".svelte": "svelte",
    ".zig": "zig", ".clj": "clojure", ".ml": "ocaml", ".gd": "gdscript",
}

VENDORED_DIRS = {"node_modules", "vendor", "third_party", "thirdparty", "bower_components", ".venv", "venv", "site-packages"}
GENERATED_DIRS = {"dist", "build", "out", "bin", "obj", ".next", ".nuxt", ".output", "coverage", "__pycache__", "generated", ".svelte-kit", ".angular"}
GENERATED_FILE = re.compile(r"(\.min\.js|\.g\.cs|\.g\.i\.cs|\.designer\.cs|\.generated\.\w+|\.d\.ts|\.d\.mts|\.d\.cts|_pb2\.py|_pb2_grpc\.py|\.pb\.go)$", re.IGNORECASE)
TEST_PART = re.compile(r"^(tests?|__tests__|testing|spec|specs|e2e|cypress|playwright)$|(^|[._])tests?$|^tests?[._]", re.IGNORECASE)
TEST_FILE = re.compile(r"(^test_.*\.py$|_test\.py$|^conftest\.py$|\.(test|spec)\.[cm]?[jt]sx?$|\.(test|spec)\.vue$)", re.IGNORECASE)
CSHARP_TEST_FILE = re.compile(r"[a-z0-9]Tests?\.cs$")


@dataclass(frozen=True)
class SourceFile:
    path: str
    language: str
    test: bool


def git_files(root: Path, ignored: bool) -> list[str] | None:
    command = ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others"]
    if not ignored:
        command.append("--exclude-standard")
    result = subprocess.run(command, capture_output=True)
    if result.returncode != 0:
        return None
    return [name for name in result.stdout.decode("utf-8", "surrogateescape").split("\0") if name]


def walked_files(root: Path) -> list[str]:
    found = []
    for folder, subfolders, names in os.walk(root):
        subfolders[:] = [name for name in subfolders if not name.startswith(".")]
        for name in names:
            found.append(Path(folder, name).relative_to(root).as_posix())
    return found


def is_test(path: str) -> bool:
    parts = path.split("/")
    return any(TEST_PART.search(part) for part in parts[:-1]) or bool(TEST_FILE.search(parts[-1]) or CSHARP_TEST_FILE.search(parts[-1]))


def is_vendored(path: str) -> bool:
    return any(part.lower() in VENDORED_DIRS for part in path.split("/")[:-1])


def is_generated(path: str) -> bool:
    parts = path.split("/")
    return any(part.lower() in GENERATED_DIRS for part in parts[:-1]) or bool(GENERATED_FILE.search(parts[-1]))


def matches(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) or path.startswith(pattern.rstrip("/") + "/") for pattern in patterns)


def list_files(root: Path, scan: dict) -> tuple[list[SourceFile], Counter]:
    names = git_files(root, scan.get("ignored", False))
    if names is None:
        names = walked_files(root)
    include = scan.get("include", [])
    exclude = scan.get("exclude", [])
    sources, skipped = [], Counter()
    for path in sorted(set(names)):
        if path.startswith(".plat/") or "/.git/" in path:
            continue
        suffix = os.path.splitext(path)[1].lower()
        language = LANGUAGES.get(suffix)
        if language is None:
            if suffix in UNSUPPORTED and not is_vendored(path) and not is_generated(path):
                skipped[UNSUPPORTED[suffix]] += 1
            continue
        forced = matches(path, include)
        if not forced:
            if matches(path, exclude):
                continue
            if is_vendored(path) and not scan.get("vendored", False):
                continue
            if is_generated(path) and not scan.get("generated", False):
                continue
        if not (root / path).is_file():
            continue
        sources.append(SourceFile(path, language, is_test(path)))
    return sources, skipped
