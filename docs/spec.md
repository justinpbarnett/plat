# Plat v1 spec

Plat is a read only board that shows how a codebase is built, drawn in UML 2.5 notation. Static analysis finds the facts. An LLM fills only the gaps that code cannot answer. Terms follow [CONTEXT.md](../CONTEXT.md). Research: [prior-art.md](prior-art.md), [icon-sources.md](icon-sources.md). Look: [look/](look/), look C ([screenshot](look/look-c.png)); open `look/index.html` and pick C.

## Pipeline

| Command | Effect |
|---------|--------|
| `plat extract [path]` | Runs the extractor for every language found and rewrites the facts section |
| `plat check` | Validates the model; each error names the exact key and is written for an LLM to fix; flags overlay entries whose target is gone |
| `plat brief` | Prints the elements changed since the last overlay pass plus the overlay format, for any agent to fill |
| `plat enrich` | Pipes the brief into a configured command (default `claude -p` with Sonnet on the Max login) and writes the overlay |
| `plat render -o board.html` | Writes one HTML file with the model and viewer inside |
| `plat serve` | Serves the board, reloads it when the model changes, opens source in VS Code |

## Storage

- `<repo>/.plat/` holds `model.json` and `config.json`, plus a `.gitignore` containing `*`, so git never sees the folder and nothing is committed.
- Parsers download on first use to `~/.cache/plat/parsers/`, at pinned versions.

## Model (JSON)

- **Facts**, owned by extractors: packages, classes, interfaces and enums with members, relationships (generalization, realization, composition, aggregation, association, dependency), language, and `path:line` for each element. Ids are qualified names (`arete.tracker.Ticket`, `Shop.Model.Order`).
- **Overlay**, owned by the LLM: components (groups of packages), a one line role per element, links code cannot show (HTTP calls, tables written), hidden ids, layout hints (direction). Keyed by id.

## Extractors

| Language | Parser |
|----------|--------|
| Python | `ast` (standard library) |
| TypeScript, JavaScript | TypeScript compiler |
| Vue | `@vue/compiler-sfc` pulls out the script block, then the TypeScript compiler |
| C# (.NET Core and .NET Framework) | Roslyn, reading `.cs` files directly, no MSBuild project load |

Node and dotnet must be installed; when one is missing, the CLI prints its install command. Files in a language with no extractor are skipped and listed in a warning.

Hidden by default: tests, private members, Python dunder methods except `__init__`, generated and vendored code, anything `.gitignore` ignores. `config.json` overrides.

## Views

- **v1, Architecture view:** packages nested as UML folders the way the code nests, classes with members inside, UML relationship arrows, LLM components drawn around package groups.
- **Later:** System design (component, deployment), Data design (stored entities), Behavior (sequence from LSP call graphs, activity, state). Each view is a tab with its own board and is switched on or off in `config.json`.

## Layout

Our own layered layout, run inside each package first and then for packages within their parent, with right angle connectors. The LLM gives hints only. No dragging.

## Board

- Plain JavaScript and SVG, no libraries, no build step.
- Look C (Console), per the Arete dashboard brief: dark, gray until selection, one accent, field and method counts in each class header.
- The mouse wheel and trackpad scroll zoom, anchored at the cursor; pinch zooms; drag and arrow keys pan.
- Detail by zoom: far shows packages and their dependency arrows; middle shows class names with counts; close shows members.
- Click: the element and its direct links stay lit, the rest dims; a side panel shows name, role, members and source.
- Source: `serve` runs `code <repo root> -g <file>:<line>` (opens or focuses the project window, then jumps to the line); the single HTML file copies that command instead.
- Keys: `/` fuzzy find, `f` fit, `1` `2` `3` views, `h` show hidden, `Esc` clear. Minimap in a corner.
- Must stay smooth at the size of a 10,000 file C# repo (thousands of classes): shapes off screen are not drawn, and members are drawn only up close.

## Symbols

Every fixed symbol comes from a credited source, never drawn by hand ([icon-sources.md](icon-sources.md)): Mermaid (MIT) for relationship ends and activity symbols, geometry ported from nomnoml (MIT) or draw.io (Apache 2.0) for the component glyph, socket, node, package tab and actor, Lucide (ISC) for system icons, Simple Icons (CC0) and Devicon (MIT, C# only) for language logos. A NOTICE file credits them. Shapes sized to their text are drawn by the layout.

## Stack and repo

- CLI in Python with the standard library only; installed with `uv tool install` from the GitHub repo. The TypeScript, Vue and C# extractors are small scripts in the repo that run the fetched parsers.
- No tests, comments or docstrings; names explain. A README for users.
- Public repo `justinpbarnett/plat`, built by Arete from GitHub issues labeled `agent`. The first commit holds the contracts the issues share: the model format ([plat/model.md](../plat/model.md)), the CLI, storage, the file scan, the extract orchestrator and the render step.
