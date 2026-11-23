# UML board symbol sources

Researched 2026-11-23. Licenses were read from each repo's LICENSE file (not memory). Rule: no symbol drawn by hand or by an LLM. Every fixed symbol is copied or ported from a credited source.

Raw URL bases used below:
- MERMAID = https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/rendering-util/rendering-elements
- DRAWIO = https://github.com/jgraph/drawio/blob/dev/src/main/webapp/js/grapheditor/Shapes.js
- NOMNOML = https://github.com/skanaar/nomnoml/blob/master/src

## Licenses verified

| Source | License | Evidence | Verdict |
|---|---|---|---|
| mermaid-js/mermaid | MIT, (c) 2014 to 2022 Knut Sveidqvist | https://github.com/mermaid-js/mermaid/blob/develop/LICENSE | usable |
| jgraph/drawio | Apache 2.0 (Shapes.js header: (c) 2006 to 2015 JGraph Holdings Ltd) | https://github.com/jgraph/drawio/blob/dev/LICENSE | usable; keep notice, mark changes. Do not take `img/lib/*` (vendor clipart, mixed provenance) |
| skanaar/nomnoml | MIT, (c) 2020 Daniel Kallin | https://github.com/skanaar/nomnoml/blob/master/LICENSE | usable |
| tabler/tabler-icons | MIT, (c) 2020 to 2026 Pawel Kuna | https://github.com/tabler/tabler-icons/blob/main/LICENSE | usable |
| lucide-icons/lucide | ISC (c) Lucide Icons and Contributors; Feather derived icons are MIT (c) 2013 Cole Bemis | https://github.com/lucide-icons/lucide/blob/main/LICENSE (GitHub reports NOASSERTION because it is two licenses; both permissive) | usable |
| simple-icons/simple-icons | CC0 1.0 | https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md | usable, but brand marks stay trademarks, see https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md |
| devicons/devicon | MIT, (c) 2015 konpa (note the org is `devicons`, not `devicon`) | https://github.com/devicons/devicon/blob/master/LICENSE | usable; README says logos belong to their owners, follow each brand policy |
| plantuml/plantuml | GPL 3 by default; multi licensed at your option (MIT, Apache, BSD, LGPL, EPL, GPL 2) | https://github.com/plantuml/plantuml/blob/master/LICENSES.md | MIT variant is allowed, but symbols are Java code (UGraphic), poor extraction target. Skip |
| Eclipse Papyrus UML icons | EPL | not fetched | copyleft (file level). Unusable |
| Wikimedia Commons UML SVGs | per file (CC BY SA, PD, GPL mix) | per file page | Skip: license differs per file, many are CC BY SA (share alike) |

## 1. Relationship ends

| Symbol | Source | File or URL | License | Extraction |
|---|---|---|---|---|
| Open arrowhead (navigable association, dependency) | Mermaid `openArrow` marker | MERMAID/markers.js, function `openArrow`, path `M 1 1 L 11 6 L 1 11` (end) and `M 11 1 L 1 6 L 11 11` (start) | MIT | Copy the marker element and path `d`. Also Mermaid `barb` / `barbNeo`. Fallback: nomnoml `drawArrow(..., empty)` in NOMNOML/terminators.ts |
| Filled arrowhead (sync message) | Mermaid `point` marker | MERMAID/markers.js, function `point`, path `M 0 0 L 10 5 L 0 10 z` | MIT | Copy marker path, `fill` set to the line color. Fallback: nomnoml `drawArrow(..., filled)` |
| Hollow triangle (generalization, realization) | Mermaid `extension` marker | MERMAID/markers.js, function `extension`, path `M 1,1 V 13 L18,7 Z` (end), `M 1,7 L18,13 V 1 Z` (start) | MIT | Copy marker path, `fill` white or background. Fallback: nomnoml `:>` terminator |
| Hollow diamond (aggregation) | Mermaid `aggregation` marker | MERMAID/markers.js, function `aggregation`, path `M 18,7 L9,13 L1,7 L9,1 Z` | MIT | Copy marker path, fill white. Fallback: nomnoml `o` terminator |
| Filled diamond (composition) | Mermaid `composition` marker | MERMAID/markers.js, function `composition`, same path as aggregation, filled | MIT | Copy marker path, fill line color. Fallback: nomnoml `+` terminator |
| Crossed circle (nesting, containment) | Mermaid `requirement_contains` marker | MERMAID/markers.js, function `requirement_contains`: circle cx 10 cy 10 r 9, plus two lines x 1 to 19 at y 10 and y 1 to 19 at x 10 (this is the UML "anchor" circle with plus, exactly the UML 2.5.1 containment end) | MIT | Port the circle and two lines. Alternative: draw.io marker `circlePlus` in DRAWIO (Apache 2.0), code lines 8371 to 8390 |
| X end (non navigable, sequence destroy) | Mermaid `cross` marker | MERMAID/markers.js, function `cross`, path `M 1,1 l 9,9 M 10,1 l -9,9` | MIT | Copy marker path, stroke only. Alternative: draw.io shape `umlDestroy` (DRAWIO, `UmlDestroyShape`) for the sequence destroy glyph; draw.io marker `cross` |

## 2. Component and interface

| Symbol | Source | File or URL | License | Extraction |
|---|---|---|---|---|
| Component icon (box with two tabs) | draw.io `ComponentShape` and `ModuleShape` | DRAWIO, `function ComponentShape` (registered `component`, line ~5049) | Apache 2.0 | Port the `paintBackground` and `paintForeground` path calls to SVG path data. Alternative: Tabler `outline/components.svg` or Lucide `component.json` are puzzle style, not the UML glyph. No SVG file source for the exact UML glyph |
| Provided interface lollipop (ball) | nomnoml `lollipop` visual; draw.io `LollipopShape` | NOMNOML/visuals.ts, visual `lollipop`; DRAWIO `function LollipopShape` (line ~4884); Mermaid `lollipop` marker (circle) in MERMAID/markers.js | MIT (nomnoml, Mermaid), Apache 2.0 (draw.io) | Copy the circle plus stem. Mermaid's `lollipop` marker is the simplest to copy |
| Required interface socket (half circle) | nomnoml `socket` visual; draw.io `RequiresShape`, `RequiredInterfaceShape`, marker `halfCircle` | NOMNOML/visuals.ts, visual `socket`; DRAWIO lines ~4911, ~4945, ~8392 | MIT / Apache 2.0 | Port the arc path from `halfCircle` marker (two quadratic curves) or nomnoml `socket` |
| Port square | none needed as a symbol: a small square | DRAWIO has no dedicated shape; a square is a primitive rect | n/a | Treat as layout sized rect (out of scope per brief) |

## 3. Package, note, node, artifact, actor, use case

| Symbol | Source | File or URL | License | Extraction |
|---|---|---|---|---|
| Package tab (folder tab) | draw.io `FolderShape`; nomnoml `package` visual | DRAWIO `function FolderShape` (registered `folder`, line ~1717); NOMNOML/visuals.ts `package` | Apache 2.0 / MIT | Port tab path. nomnoml `package` draws the tab with a plain path |
| Note (dog eared corner) | draw.io `NoteShape`; nomnoml `note` visual; Mermaid `note.ts` | DRAWIO `function NoteShape` (line ~1470); NOMNOML/visuals.ts `note`; MERMAID/shapes/note.ts | Apache 2.0 / MIT | Port the fold path. nomnoml `note` is closest to UML (a cut corner plus fold) |
| Deployment node (3D box) | draw.io `CubeShape` | DRAWIO `function CubeShape` (registered `cube`, line ~1134) | Apache 2.0 | Port the cube path (front face plus two skewed faces). Alternative: Lucide `box` / `cuboid` / Tabler `box` outline icons (not UML proportions, icon scale only) |
| Artifact icon (document, folded corner) | Tabler `file`; Lucide `file`; draw.io `NoteShape` | https://github.com/tabler/tabler-icons/blob/main/icons/outline/file.svg ; https://github.com/lucide-icons/lucide/blob/main/icons/file.svg | MIT / ISC | Download SVG, copy the `<path>` data |
| Actor stick figure | draw.io `UmlActorShape`; nomnoml `actor` visual | DRAWIO `function UmlActorShape` (line ~3466): head ellipse, torso, arms, legs; NOMNOML/visuals.ts `actor` | Apache 2.0 / MIT | Port the head ellipse and lines to SVG (about 6 primitives) |
| Use case ellipse | any SVG ellipse; nomnoml `usecase` visual | NOMNOML/visuals.ts `ellipse` | MIT | A primitive `<ellipse>` sized by the layout, out of scope per brief |

## 4. Activity and state

| Symbol | Source | File or URL | License | Extraction |
|---|---|---|---|---|
| Initial node (filled circle) | Mermaid `stateStart.ts`, `filledCircle.ts`; draw.io `StartStateShape`; nomnoml `start` | MERMAID/shapes/stateStart.ts; DRAWIO `function StartStateShape` (line ~5157); NOMNOML/visuals.ts `start` | MIT / Apache 2.0 | Primitive circle, fill set. Port from any |
| Activity final (bullseye) | Mermaid `stateEnd.ts`, `doubleCircle.ts`; draw.io `StateShape` registered `endState`; nomnoml `end` | MERMAID/shapes/stateEnd.ts; DRAWIO `function StateShape` (line ~5127); NOMNOML/visuals.ts `end` | MIT / Apache 2.0 | Outer ring plus inner filled circle, radius ratio from source |
| Flow final (circle with X) | Mermaid `crossedCircle.ts` | MERMAID/shapes/crossedCircle.ts: circle r, lines at 45 degrees, length 2r (`createLine`) | MIT | Port the two diagonal lines inside a circle. Mermaid wraps in roughjs; drop that and keep the geometry |
| Decision / merge diamond | Mermaid `choice.ts`; nomnoml `rhomb` | MERMAID/shapes/choice.ts; NOMNOML/visuals.ts `rhomb` | MIT | Four point polygon, layout sized, out of scope |
| Fork / join bar | Mermaid `forkJoin.ts`; nomnoml `sync` | MERMAID/shapes/forkJoin.ts; NOMNOML/visuals.ts `sync` | MIT | A filled rect, layout sized, out of scope |
| History pseudostate (H in circle) | Lucide `circle-letter-h`; Tabler `circle-letter-h` | https://github.com/lucide-icons/lucide/blob/main/icons/circle-letter-h.svg ; https://github.com/tabler/tabler-icons/blob/main/icons/outline/circle-letter-h.svg | ISC / MIT | Download SVG, copy `<path>` data. Deep history (H*) has no source: a Lucide `asterisk` would be a second glyph placed by code, not drawn |
| Entry point (small circle) | primitive circle | n/a | n/a | Layout sized primitive |
| Exit point (circle with X) | Same geometry as flow final | MERMAID/shapes/crossedCircle.ts | MIT | Reuse the flow final port at smaller radius |

## 5. System design icons

| Symbol | Source | File or URL | License | Extraction |
|---|---|---|---|---|
| Database cylinder | Lucide `database`; Tabler `database`; draw.io `CylinderShape`; Mermaid `cylinder.ts` | https://github.com/lucide-icons/lucide/blob/main/icons/database.svg ; https://github.com/tabler/tabler-icons/blob/main/icons/outline/database.svg | ISC / MIT | Download SVG. For a UML cylinder with layout sized height, port draw.io `cylinder2` or Mermaid `cylinder.ts` |
| Queue | draw.io `SeqQueueShape`; Lucide `list-end`, `rows-3` | DRAWIO `function SeqQueueShape` (line ~3725); https://github.com/lucide-icons/lucide/blob/main/icons/rows-3.svg | Apache 2.0 / ISC | Port from draw.io, or take Lucide `rows-3` as a plain queue icon |
| Cloud / external system | Lucide `cloud`; Tabler `cloud`; Mermaid `cloud.ts` | https://github.com/lucide-icons/lucide/blob/main/icons/cloud.svg ; https://github.com/tabler/tabler-icons/blob/main/icons/outline/cloud.svg | ISC / MIT | Download SVG, copy path |
| Browser | Lucide `app-window`; Tabler `browser` | https://github.com/lucide-icons/lucide/blob/main/icons/app-window.svg ; https://github.com/tabler/tabler-icons/blob/main/icons/outline/browser.svg | ISC / MIT | Download SVG, copy path |
| Server | Lucide `server`; Tabler `server` | https://github.com/lucide-icons/lucide/blob/main/icons/server.svg ; https://github.com/tabler/tabler-icons/blob/main/icons/outline/server.svg | ISC / MIT | Download SVG, copy path |

Lucide and Tabler share the 24 px, 2 px stroke grid, so one of them alone gives a consistent icon set. Lucide has every item above except none missing; Tabler has all too.

## 6. Language and framework logos

| Symbol | Source | File or URL | License | Extraction |
|---|---|---|---|---|
| Python | Simple Icons | https://github.com/simple-icons/simple-icons/blob/develop/icons/python.svg | CC0 | Download. Trademark: PSF policy, https://www.python.org/psf/trademarks/ |
| TypeScript | Simple Icons | .../icons/typescript.svg | CC0 | Download. Trademark of Microsoft |
| JavaScript | Simple Icons | .../icons/javascript.svg | CC0 | Download. Unofficial logo, no owner brand rules |
| Vue | Simple Icons (`vuedotjs`) | .../icons/vuedotjs.svg | CC0 | Download. Vue brand guide applies |
| .NET | Simple Icons | .../icons/dotnet.svg | CC0 | Download. Trademark of Microsoft (.NET Foundation) |
| C# | Devicon (`csharp-plain.svg`) or Tabler `brand-c-sharp` | https://github.com/devicons/devicon/blob/master/icons/csharp/csharp-plain.svg ; https://github.com/tabler/tabler-icons/blob/main/icons/outline/brand-c-sharp.svg | MIT | Download. Simple Icons has NO C# icon (its `sharp.svg` is the Sharp image library, `fsharp` is F#). Trademark note: Microsoft |

Devicon also has all six (`python`, `typescript`, `javascript`, `vuejs`, `csharp`, `dot-net` or `dotnetcore`) with colored and monochrome variants, MIT. Choose Simple Icons for monochrome single path marks (CC0, one `<path>` per file, easy to recolor) and Devicon only for C#.

Brand caveat: licensing the SVG file does not license the trademark. Show logos only to identify the language or framework (nominative use), keep the shapes unmodified, and add a line in NOTICE.

## Symbols with no permissive SVG file source

- Component icon (UML two tab glyph): no ready SVG in any permissive library. Source is code only (draw.io `ComponentShape`, Apache 2.0). Port the path calls.
- Required interface socket, provided ball, deployment node cube, package tab, actor: same, code only (draw.io, nomnoml). No SVG files in permissive repos for the UML specific versions.
- Deep history (H*): no source; compose from History H plus a font free glyph, or skip.
- C#: not in Simple Icons. Use Devicon or Tabler.
- Papyrus UML icons: EPL, not usable. PlantUML: multi license but symbols live in Java drawing code.

## Recommended source set

Fewest sources that cover everything:

1. Mermaid (MIT): all relationship ends (open arrow, filled arrow, hollow triangle, both diamonds, crossed circle via `requirement_contains`, X), lollipop ball, flow final X circle, start, end, choice, fork. https://github.com/mermaid-js/mermaid
2. draw.io Shapes.js (Apache 2.0): component glyph, required interface socket, deployment cube, package folder tab, note, actor, destroy X, queue. https://github.com/jgraph/drawio
3. Lucide (ISC, Feather icons MIT): database, server, cloud, browser (`app-window`), artifact file, history (`circle-letter-h`). https://github.com/lucide-icons/lucide
4. Simple Icons (CC0): Python, TypeScript, JavaScript, Vue, .NET. https://github.com/simple-icons/simple-icons
5. Devicon (MIT): C# only. https://github.com/devicons/devicon

Option to drop one: use nomnoml (MIT) instead of draw.io for socket, package, note, actor (it is plain TypeScript, easier to read than mxGraph calls), leaving only the cube and component glyph for draw.io. If you want strictly four sources, take C# from Tabler `brand-c-sharp` and use Tabler in place of Lucide for the icons (Tabler has all icons plus `brand-python`, `brand-typescript`, `brand-javascript`, `brand-vue`, `brand-c-sharp`, but not .NET, so Simple Icons stays).

## NOTICE draft

```
UML board bundles symbols taken from the following projects. Each is
used under its license. Symbols were copied or ported, not redrawn.

Mermaid (MIT License)
  Copyright (c) 2014 - 2022 Knut Sveidqvist
  https://github.com/mermaid-js/mermaid
  Used for: relationship end markers (arrowheads, diamonds, crossed
  circle, cross), lollipop, start, end, flow final, choice and fork
  geometry.

draw.io / mxGraph shapes (Apache License 2.0)
  Copyright (c) 2006 - 2015 JGraph Holdings Ltd
  https://github.com/jgraph/drawio
  Used for: component, required interface, cube, folder, note, actor
  and queue shapes. Path calls were converted to SVG path data.
  Modified from the originals. Licensed copy:
  https://www.apache.org/licenses/LICENSE-2.0

Lucide (ISC License)
  Copyright (c) Lucide Icons and Contributors
  Portions derived from Feather (MIT License)
  Copyright (c) 2013 - present Cole Bemis
  https://github.com/lucide-icons/lucide
  Used for: database, server, cloud, browser, file and history icons.

Simple Icons (CC0 1.0 Universal)
  https://github.com/simple-icons/simple-icons
  Used for: Python, TypeScript, JavaScript, Vue and .NET logos.

Devicon (MIT License)
  Copyright (c) 2015 konpa
  https://github.com/devicons/devicon
  Used for: C# logo.

Logos and brand marks are trademarks of their respective owners. They
appear only to identify the language or framework they represent, and
use does not imply endorsement.
```
(Add the full MIT, ISC and Apache 2.0 license texts in a LICENSES folder beside NOTICE.)
