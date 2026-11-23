import os
import shutil
import subprocess
import sys
from pathlib import Path

INSTALL = {
    "node": {
        "darwin": "brew install node",
        "linux": "curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs",
        "win32": "winget install OpenJS.NodeJS.LTS",
    },
    "npm": {
        "darwin": "brew install node",
        "linux": "sudo apt-get install -y npm",
        "win32": "winget install OpenJS.NodeJS.LTS",
    },
    "dotnet": {
        "darwin": "brew install --cask dotnet-sdk",
        "linux": "sudo apt-get install -y dotnet-sdk-8.0",
        "win32": "winget install Microsoft.DotNet.SDK.8",
    },
}


class ToolMissing(Exception):
    pass


class ExtractorFailed(Exception):
    pass


def cache_dir() -> Path:
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    folder = base / "plat" / "parsers"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def install_command(tool: str) -> str:
    commands = INSTALL.get(tool, {})
    return commands.get(sys.platform, commands.get("linux", f"install {tool}"))


def require(tool: str) -> str:
    found = shutil.which(tool)
    if not found:
        raise ToolMissing(f"{tool} is not installed. Install it with: {install_command(tool)}")
    return found


def run(command: list[str], stdin: str | None = None, cwd: Path | None = None, timeout: int = 3600) -> str:
    result = subprocess.run(command, input=stdin, capture_output=True, text=True, cwd=cwd, timeout=timeout)
    if result.returncode != 0:
        tail = "\n".join((result.stderr or result.stdout).strip().splitlines()[-25:])
        raise ExtractorFailed(f"{' '.join(command[:3])} failed with exit {result.returncode}:\n{tail}")
    return result.stdout
