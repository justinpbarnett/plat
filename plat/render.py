import base64
import json
import re
from pathlib import Path

BOARD = Path(__file__).parent / "board"
SCRIPTS = ["symbols.js", "layout.js", "board.js"]


def inline_fonts(css: str) -> str:
    def data_uri(match: re.Match) -> str:
        font = BOARD / "fonts" / match.group(1)
        encoded = base64.b64encode(font.read_bytes()).decode("ascii")
        return f"url(data:font/woff2;base64,{encoded})"

    return re.sub(r"url\(fonts/([\w.-]+\.woff2)\)", data_uri, css)


def safe_json(data) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def html(root: Path, model: dict, config: dict, mode: str) -> str:
    page = (BOARD / "index.html").read_text()
    style = "<style>\n" + inline_fonts((BOARD / "board.css").read_text()) + "\n</style>"
    data = {"model": model, "config": config, "root": str(root), "name": root.name, "mode": mode}
    script = "\n".join(f"<script>\n{(BOARD / name).read_text()}\n</script>" for name in SCRIPTS if (BOARD / name).exists())
    page = page.replace("<!--PLAT:STYLE-->", style)
    page = page.replace("<!--PLAT:DATA-->", f"<script>window.PLAT = {safe_json(data)};</script>")
    page = page.replace("<!--PLAT:SCRIPT-->", script)
    return page


def run(root: Path, model: dict, config: dict, output: Path) -> int:
    output.write_text(html(root, model, config, "file"))
    print(f"wrote {output} ({output.stat().st_size // 1024} KB)")
    return 0
