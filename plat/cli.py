import argparse
import sys
from pathlib import Path

from plat import store


def need_model(root: Path) -> bool:
    if store.has_model(root):
        return True
    print(f"no model at {store.model_path(root)}; run plat extract first", file=sys.stderr)
    return False


def extract(args) -> int:
    from plat import extract as extraction

    root = store.find_root(args.path)
    store.plat_dir(root)
    return extraction.run(root, store.load_config(root))


def check(args) -> int:
    from plat import check as checking

    root = store.find_root(args.path)
    return checking.run(root) if need_model(root) else 1


def brief(args) -> int:
    from plat import brief as briefing

    root = store.find_root(args.path)
    return briefing.run(root, limit=args.limit, everything=args.all) if need_model(root) else 1


def enrich(args) -> int:
    from plat import enrich as enriching

    root = store.find_root(args.path)
    if not need_model(root):
        return 1
    return enriching.run(root, reply=args.reply, command=args.command, max_batches=args.max_batches)


def render(args) -> int:
    from plat import render as rendering

    root = store.find_root(args.path)
    if not need_model(root):
        return 1
    return rendering.run(root, store.load_model(root), store.load_config(root), Path(args.output).resolve())


def serve(args) -> int:
    from plat import serve as serving

    root = store.find_root(args.path)
    return serving.run(root, port=args.port, open_browser=not args.no_open) if need_model(root) else 1


def parser() -> argparse.ArgumentParser:
    main_parser = argparse.ArgumentParser(prog="plat", description="Draw a codebase as UML on a read only board.")
    commands = main_parser.add_subparsers(dest="command", required=True)

    def command(name: str, handler, help_text: str) -> argparse.ArgumentParser:
        sub = commands.add_parser(name, help=help_text, description=help_text)
        sub.add_argument("path", nargs="?", default=".", help="a folder inside the repo (default: here)")
        sub.set_defaults(handler=handler)
        return sub

    command("extract", extract, "Run the extractor for every language found and rewrite the facts.")
    command("check", check, "Validate the model; every error names the exact key to fix.")
    sub = command("brief", brief, "Print what changed since the last overlay pass, and the overlay format, for an agent to fill.")
    sub.add_argument("--limit", type=int, default=None, help="elements per brief (default: config enrich.batch)")
    sub.add_argument("--all", action="store_true", help="brief every element, not only the changed ones")
    sub = command("enrich", enrich, "Pipe the brief into an LLM command and write its reply into the overlay.")
    sub.add_argument("--reply", help="merge a reply an agent already wrote to this file ('-' reads stdin) instead of running a command")
    sub.add_argument("--command", help="the LLM command that reads the brief on stdin (default: config enrich.command)")
    sub.add_argument("--max-batches", type=int, default=None, help="stop after this many briefs")
    sub = command("render", render, "Write one HTML file with the model and the board inside.")
    sub.add_argument("-o", "--output", default="board.html", help="output file (default: board.html)")
    sub = command("serve", serve, "Serve the board, reload it when the model changes, and open source in your editor.")
    sub.add_argument("--port", type=int, default=8740)
    sub.add_argument("--no-open", action="store_true", help="do not open a browser")
    return main_parser


def main() -> None:
    args = parser().parse_args()
    try:
        sys.exit(args.handler(args))
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
