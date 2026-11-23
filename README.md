# Plat

Plat draws a codebase as a UML class diagram on a board you can pan and zoom. Static analysis finds the packages, classes, members and relationships. An LLM adds only what code cannot show: what each part is for, how packages group into components, and links such as HTTP calls.

Status: under construction. The commands below are the plan; [docs/spec.md](docs/spec.md) is the full design.

## Install

```sh
uv tool install git+https://github.com/justinpbarnett/plat
```

Python 3.11 or later. TypeScript, JavaScript and Vue need Node; C# needs the .NET SDK. Plat downloads each parser on first use into `~/.cache/plat/parsers/`.

## Use

```sh
plat extract          # read the code in this repo into .plat/model.json
plat enrich           # ask an LLM (claude -p by default) to fill roles and components
plat serve            # open the board; it reloads when the model changes
plat render -o board.html   # or write one HTML file to share
```

`plat check` validates the model, and `plat brief` prints what an agent needs to fill the overlay by hand. Plat keeps its files in `.plat/` in your repo, which ignores itself in git.

On the board, the wheel zooms, drag pans, a click lights an element and its links, `/` finds, `f` fits, `h` shows hidden elements, and `Esc` clears. In `plat serve`, the open button jumps to the line in VS Code.

Languages: Python, TypeScript, JavaScript, Vue and C# (.NET Core and .NET Framework).

## Credits

See [NOTICE](NOTICE). The model format is [plat/model.md](plat/model.md).

## License

MIT
