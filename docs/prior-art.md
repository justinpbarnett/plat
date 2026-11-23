# UML board prior art (2026-11-23)

Goal: agents write UML as data, a small own tool draws it read only on a pan and zoom board with minimap. Python, TypeScript, C#.

Evidence marks: (V) verified today from the README or npm package contents, (K) from my own knowledge, not rechecked today. Sizes were measured by running `npm pack` and gzip -9 on the dist files on 2026-11-23.

## 1. LLM to diagram tools for codebases

| Tool | What the LLM writes | How facts are gathered | Renderer | Good | Bad |
|---|---|---|---|---|---|
| GitDiagram (https://github.com/ahmedkhaleel2004/gitdiagram) (V) | Mermaid source, with each component linked to its file or directory | LLM reads a repo digest (Gitingest style file tree and README); no static analysis | Mermaid in a Next.js app; MCP server at gitdiagram.com/mcp (public repos) | Click through to source, MCP for agents, MIT | Needs OpenAI or OpenRouter key, R2, Redis to self host; one flowchart style, not UML |
| Swark (https://github.com/swark-io/swark) (V) | Mermaid in a markdown file | LLM reads files up to a token cap via the VS Code LM API (Copilot) | Mermaid preview in VS Code | Zero setup in VS Code, logs the files used | AGPL 3.0, file cap, output varies, cycles break Mermaid (has a fix setting) |
| CodeBoarding (https://github.com/CodeBoarding/CodeBoarding) (V) | `analysis.json` (components, relations, source refs); the LLM only names and describes groups | Static analysis plus language servers (LSP), then LLM groups components | Own `codeboarding-render` to md, html, mdx, rst with Mermaid | Facts come from code, incremental updates, nested drill down, MIT | Architecture level, not UML; downloads LSP servers; sends excerpts to a model provider |
| DeepWiki / Devin Wiki (https://docs.devin.ai/work-with-devin/deepwiki) (V for docs, Mermaid is from secondary sources) | Generated wiki pages with diagrams; steer with `.devin/wiki.json` | Index plus LLM, then Ask Devin uses it | Hosted | Good prose plus diagram mix; page list you can steer | Closed hosted service, no UML contract |
| UML-MCP (https://github.com/antoinebou12/uml-mcp) (V) | PlantUML, Mermaid, D2 or Kroki text, or JSON for 15 interactive types | LLM writes; some plugins read `package.json`, SQL | Kroki for 37 types; D3 and HTML for interactive | Real UML families (class, sequence, activity, state, component, deployment); MIT; Claude Code plugin | Needs Kroki (network or Docker); diagram text is the contract, so no model behind it |
| repo-architecture-mcp (https://github.com/vinit-devops/repo-architecture-mcp) (V) | None, tool returns the diagram | Parses Python, JS, TS, Java, Go (method not described) | Mermaid, SVG, PNG | Static facts into class and dependency diagrams; edge cap 400 | Small project, no C#, not full UML |
| repo-cartographer, ProjGraph (https://claudemarketplaces.com/mcp/handys11/projgraph) (search result only) | Tool output | ProjGraph reads .NET code; cartographer builds from repo structure | Mermaid, Graphviz | ProjGraph covers C# class diagrams | Not checked in depth |
| PlantUML MCP (Infobip), draw.io MCP (https://github.com/jgraph/drawio-mcp), diagrams-mcp-server (https://pypi.org/project/diagrams-mcp-server/) (search result only) | PlantUML or Mermaid or draw.io XML | LLM writes | PlantUML server, draw.io | Render only, easy to try | Need server or Java; no model |

Pattern: two camps. Camp A (GitDiagram, Swark, UML-MCP) has the LLM write Mermaid or PlantUML text from reading code. Camp B (CodeBoarding, repo-architecture-mcp) extracts facts with static analysis, and the LLM only labels. None found that gives an agent a validated JSON model with UML 2.5 semantics and a read only pan zoom viewer.

## 2. Text to UML renderers

| Tool | Syntax | UML fidelity | Layout | Install weight | License |
|---|---|---|---|---|---|
| PlantUML (https://plantuml.com) (K) | `class A <|-- B`, `A "1" *-- "many" B`, `[Comp]`, `() Iface`, `node`, `@startuml` | Best of the text tools: all 14 diagram types, real heads, lollipop and socket in component diagrams, stereotypes, visibility icons | Graphviz dot (or built in Smetana port) | Java jar about 10 MB, dot optional; server or Kroki | GPL 3 (also LGPL, Apache, EPL, MIT editions) |
| Mermaid classDiagram, sequenceDiagram, architecture (https://mermaid.js.org) (K) | `A <|-- B`, `A "1" *-- "*" B`, `class A { +op() }` | Class: inheritance, composition, aggregation, association, dependency, realization, lollipop interface; sequence good; no deployment, weak component; architecture is a cloud icon style, not UML | dagre by default, optional ELK plugin | npm unpacked 124 MB (V), browser bundle roughly 2 to 3 MB | MIT |
| D2 (https://d2lang.com) (K) | `a -> b`; `shape: class`, `shape: sequence_diagram` | Class and sequence shapes only; arrowheads include triangle, diamond, cf-one; not a UML complete set | dagre, ELK, TALA (paid) | Single Go binary, WASM npm | MPL 2.0 |
| nomnoml (https://github.com/skanaar/nomnoml) (V sizes) | `[<abstract>Base|+op()]`, `[A]<:-[B]`, `[A]+->[B]` | Class like: inheritance, composition, aggregation, association, dependency, note, package, actor, usecase; no lollipop, no sequence | graphre (dagre fork) | 72 KB min, 13.5 KB gz, own canvas renderer, no dependencies except graphre bundled | MIT |
| yUML (https://yuml.me) (K) | `[A]^-[B]`, `[A]<>-[B]` | Class, use case, activity only; hosted | Hosted Graphviz | Web service only | Service, source GPL |
| Structurizr DSL (https://structurizr.com/dsl, https://c4model.com) (K) | `workspace { model { ... } views { ... } }` | Not UML: C4 (context, container, component, code). Idea: one model, many views | Browser layout, manual positions | Java CLI or Lite server | Apache 2.0 |
| Graphviz dot (https://graphviz.org) (K) | `digraph { A -> B [arrowhead=empty] }` | Arrowheads normal, empty, diamond, odiamond, onormal; `shape=record` or HTML labels for class boxes; no lollipop, you draw it yourself | dot (Sugiyama), clusters, splines or ortho | C binary, WASM 637 KB gz (V) | EPL |

## 3. Graph layout engines

Sizes: (V) measured minified and gzip of the shipped dist file, except where noted. Unpacked size is the npm number.

| Engine | Min / gz | Algorithm | Orthogonal edges | Compound nodes | License | State (GitHub push date) |
|---|---|---|---|---|---|---|
| @dagrejs/dagre 3.1.3 (https://github.com/dagrejs/dagre) | 49 KB / 17 KB | Layered Sugiyama (network simplex ranking, barycenter ordering, Brandes Kopf positions) | No, polyline with bend points | Weak: clusters supported through compound graph, but no cross cluster polish | MIT | active, 2026-10-24 |
| elkjs 0.12.1 (https://github.com/kieler/elkjs) | 1.65 MB / 477 KB (bundled GWT build) | ELK layered (Sugiyama), also stress, mrtree, radial | Yes, built in orthogonal routing with ports | Yes, hierarchical, with port constraints | EPL 2.0 or GPL 3 | active, 2026-11-09 |
| graphre 0.1.3 (https://github.com/skanaar/graphre) | 39 KB / 13 KB | dagre fork, trimmed | No | Limited | MIT | dormant |
| @msagl/core 1.1.25 (https://github.com/microsoft/msagl-js) | 12.9 MB unpacked (bundle size not measured) | MSAGL layered, plus rectilinear router and MDS | Yes, rectilinear router | Yes, clusters | MIT | repo check returned nothing, treat as unknown |
| WebCola 3.4.0 (https://github.com/tgdwyer/WebCola) | 80 KB / 23 KB | Constraint based force directed, with flow layout and overlap removal | No (has a grid router add on) | Groups | MIT | last push 2026-04-30 |
| libavoid-js 0.5.0 beta (https://github.com/Aksem/libavoid-js) | WASM, 0.98 MB unpacked (V) | libavoid router only (no node layout): orthogonal and polyline connector routing around obstacles, incremental, ports | Yes, the best of the lot | n/a | LGPL 2.1 (WASM static link, check obligations) | active, 2026-11-16 |
| @hpcc-js/wasm-graphviz 1.30.0 (https://github.com/hpcc-systems/hpcc-js-wasm) | 820 KB JS with WASM inlined / 637 KB gz | Graphviz dot (Sugiyama), neato, fdp, and others | `splines=ortho` (poor with labels and ports) | Yes, clusters | Apache 2.0 | active |

Own layout cost: no source found that gives a line count. My estimate (K, unverified): a layered layout (longest path ranking, DFS cycle removal, dummy nodes for long edges, barycenter sweeps, simple coordinate assignment) is about 300 to 500 lines of TypeScript. Orthogonal routing with channels and nudging is another 300 to 600. dagre itself is small enough to read (about 3 to 4 thousand lines of source across layout, order, position, rank). Compound nodes (packages containing classes) are the hard part; do layout bottom up, innermost package first, treat each package as one sized node in its parent.

## 4. Pan and zoom references

| Project | Size (V) | Core technique |
|---|---|---|
| d3-zoom 3.0.1 (https://github.com/d3/d3-zoom) | 9.9 KB min / 3.4 KB gz (needs d3-selection, d3-transition, d3-drag, d3-interpolate for full use) | Holds a transform `{k, x, y}` per element; wheel zooms around the pointer, drag pans, pinch handled, `scaleExtent`, `translateExtent`; you apply it as `transform="translate(x,y) scale(k)"` to one `<g>` |
| panzoom (anvaka) 9.4.4 (https://github.com/anvaka/panzoom) | 33.8 KB min / 9.2 KB gz | Same single transform on a DOM or SVG element; wheel, pinch, keyboard, bounds, smooth moves, `transform` events; exposes get and set transform |
| tldraw 5.6 (https://tldraw.dev) | 15.7 MB unpacked; custom license (not MIT, watermark and license key for production) | Canvas of DOM or SVG elements under one camera `{x, y, z}`; culling of off screen shapes; wheel and pinch normalization; zoom dependent rendering |
| React Flow / xyflow 13 (https://reactflow.dev/api-reference/components/minimap) | 1.3 MB unpacked, MIT | Viewport is one CSS transform on a container; MiniMap is a separate small SVG that draws every node as a rect and a mask path for the area outside the viewport; `pannable` and `zoomable` props make the minimap drive the main viewport |

Technique notes (K): (1) one transform on a single `<g>` or a div, never move nodes individually; (2) zoom about the cursor: `x' = px - (px - x) * k'/k`; (3) wheel with ctrlKey is trackpad pinch, so use `deltaY * 0.01` exponent; two finger scroll pans; (4) level of detail: below about 0.4 scale drop member lists and labels (CSS class toggled on the root `<svg>`), below 0.15 draw boxes only; (5) minimap as a second SVG sharing the same node rects scaled to fit with a viewport rectangle you drag; (6) cull elements outside the viewport for 1000+ nodes.

## 5. UML 2.5.1 notation checklist

Primary source: OMG UML 2.5.1, https://www.omg.org/spec/UML/2.5.1 (PDF https://www.omg.org/spec/UML/2.5.1/PDF). Notation sections: Classifiers 9.x, Classes 11, Components 11.6, Deployments 19, Interactions 17, Activities 15, State Machines 14, Packages 12. Easier reference: https://www.uml-diagrams.org (K). Items below are from my knowledge of the spec, check the exact clause when implementing a shape.

### Relationship lines (class, package, component)

| Relationship | Line | Source end | Target end |
|---|---|---|---|
| Association | solid | none | none (plain), or open arrowhead if navigable one way; small x for non navigable |
| Aggregation | solid | hollow diamond at the whole | none or open arrow |
| Composition | solid | filled diamond at the whole | none or open arrow |
| Generalization | solid | none | hollow closed triangle |
| Realization (interface implementation) | dashed | none | hollow closed triangle |
| Dependency (use) | dashed | none | open arrowhead (two line V) |
| Usage dependency | dashed with open arrow, label `<<use>>` | | |
| Package import / access / merge | dashed open arrow with `<<import>>`, `<<access>>`, `<<merge>>` | | |
| Abstraction (`<<derive>>`, `<<trace>>`, `<<refine>>`) | dashed open arrow with keyword | | |
| Template binding | dashed open arrow `<<bind>>(T->Int)` | | |
| Interface provided | lollipop (circle on a short line) from the classifier | | |
| Interface required | socket (half circle) | | |
| Assembly connector | lollipop and socket joined (ball and socket) | | |
| Delegation connector (component ports) | solid line with open arrow from port to inner part | | |
| Association class | dashed line from association line to a class box | | |
| Qualified association | small box at the qualified end | | |
| Nested class / containment | circle with plus at the container end (crosshair) | | |
| Package containment (nested) | circle with plus on the line to the nested package | | |

Labels on lines: name with reading direction triangle, role name at each end, multiplicity (`1`, `0..1`, `*`, `1..*`) at each end, visibility on role, `{ordered}`, `{unique}`, `{subsets x}`, `{redefines x}`, stereotype in guillemets above the name, `/` for derived.

### Node shapes

| Diagram | Nodes |
|---|---|
| Class | Class box (three compartments: name, attributes, operations; italic name for abstract, underline for static members); `<<interface>>` box or circle form; `<<enumeration>>` with literals; `<<datatype>>`, `<<primitive>>`, `<<signal>>`, `<<stereotype>>`; template class with dashed box top right holding parameters; object (underlined `name : Class`); note (folded corner) with dashed anchor; constraint `{ ... }`; visibility `+ - # ~`, derived `/`, property string `{readOnly}`, parameters `name : Type = default`, direction `in`, `out`, `inout` |
| Package | Folder tab shape; model; profile; `<<import>>`, `<<merge>>` lines |
| Component | Rectangle with component icon (two small tabs) or `<<component>>` keyword; ports as small squares on the border; provided and required interface lollipops and sockets; internal parts nested; artifact `<<artifact>>` with page icon |
| Deployment | Node as 3D box; device `<<device>>`; execution environment `<<executionEnvironment>>`; artifact with `<<manifest>>` dashed arrow to component; deployment dashed arrow `<<deploy>>`; communication path solid line with stereotype and multiplicity |
| Sequence | Lifeline (head box `name : Type` and dashed vertical line); actor lifeline; execution specification (thin rectangle); destruction (X); combined fragment (pentagon operator tag: `alt`, `opt`, `loop`, `par`, `break`, `critical`, `ref`, `neg`, `seq`, `strict`, `ignore`, `consider`, `assert`) with guard `[cond]` and dashed operand separators; interaction use (`ref`); state invariant; gate; found and lost message (filled circle) |
| Sequence messages | Synchronous call: solid line, filled triangle head; asynchronous: solid line, open arrowhead; reply: dashed line, open arrowhead; create: dashed open arrow to the head box with `<<create>>`; self message loop; message labelled `seq: name(args) : return` |
| Activity | Initial (filled circle), activity final (bullseye), flow final (circle with X), action (rounded rectangle), call behavior action (rake icon), send signal (convex pentagon), accept event (concave pentagon), time event (hourglass), object node (rectangle), pin (small square on border), decision and merge (diamond), fork and join (thick bar), swimlane partitions, interruptible region (dashed rounded box with lightning bolt), expansion region (dashed box with node pins); edges: control flow solid open arrow, object flow same with object node, guard `[x]`, weight `{weight=n}` |
| State machine | Initial pseudostate (filled circle), final (bullseye), state (rounded rectangle with name, optional `entry /`, `do /`, `exit /` compartment), composite state with regions separated by dashed line, submachine state, choice (diamond), junction (small filled circle), fork and join (bar), shallow history (circle with H), deep history (H*), entry and exit points (circle, circle with X), terminate (X); transition solid open arrow labelled `trigger [guard] / effect` |
| Use case (extra) | Actor stick figure, use case ellipse, system boundary box; include dashed `<<include>>`, extend dashed `<<extend>>`, generalization hollow triangle |

## Borrow list

1. Contract is JSON facts, labels optional: CodeBoarding (https://github.com/CodeBoarding/CodeBoarding). Static analysis writes the `analysis.json`; the LLM only names and groups. Agents then edit or add view definitions, not geometry.
2. One model, many views: Structurizr DSL (https://structurizr.com/dsl). Store elements and relationships once; each diagram is a view that filters and scopes. Fits "describe a codebase" better than one diagram per prompt.
3. Source links on every node: GitDiagram (https://github.com/ahmedkhaleel2004/gitdiagram). Each box carries a file path and line, shown read only, so the board is a code map.
4. Own small notation renderer, dagre class layout: nomnoml (https://github.com/skanaar/nomnoml). 14 KB gzip proves a class diagram renderer fits in one small file; copy its compartment box drawing and arrow end functions, and add lollipop, socket, and the missing UML shapes.
5. Layout: vendor dagre (17 KB gz, MIT) as step one, behind one function `layout(graph) -> boxes + edge points`; swap in own layered layout plus orthogonal router later. Optional: elkjs (https://github.com/kieler/elkjs) loaded only when a diagram needs ports and nested packages (477 KB gz, so lazy load).
6. Single transform viewport: d3-zoom (https://github.com/d3/d3-zoom) and panzoom (https://github.com/anvaka/panzoom). Own about 150 lines: one `<g>` transform, cursor anchored zoom, ctrlKey pinch, bounds off for free pan.
7. Minimap as a second SVG with a mask: React Flow MiniMap (https://reactflow.dev/api-reference/components/minimap). Reuse the same node rects at small scale, viewport rectangle draggable.
8. Level of detail by zoom class: tldraw (https://tldraw.dev) idea of zoom dependent rendering; toggle CSS classes on the root SVG so member compartments disappear when zoomed out, and cull off screen nodes.

Also useful: Swark's `fixMermaidCycles` (https://github.com/swark-io/swark) shows that LLM output needs validation; the tool should reject unknown ids and bad relationship kinds with an error the agent can fix.

## Surprises and cautions

- No tool found that does "agent writes validated UML model, read only pan zoom board". Nearest: UML-MCP (renders through Kroki, so heavy and text based) and nomnoml (tiny, no dependencies, but its own text syntax and no pan or minimap contract).
- elkjs is 477 KB gz and EPL or GPL dual licensed; dagre is 28 times smaller but has no orthogonal routing or ports.
- tldraw is not MIT (custom license), so skip it as a base.
- libavoid-js is LGPL, active, and the only light orthogonal router; a possible later add, though a 300 line own router may be enough.
- Verified sources only for sizes, licenses and push dates (npm and GitHub API on 2026-11-23); the UML notation table and renderer fidelity rows are from memory and should be checked against the OMG PDF before building each shape.
