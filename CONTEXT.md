# Plat

A tool that turns a codebase into UML diagrams on a read only board. Static analysis gathers the facts first; LLMs add only what code cannot know.

## Language

### Pipeline

**Model**:
The one portable document that describes a codebase, made of two sections: its facts and its overlay.
_Avoid_: diagram file, spec, graph

**Facts**:
The section of the model that extractors own and rewrite on every run: elements, relationships and source locations found by static analysis.
_Avoid_: skeleton, raw data, index

**Overlay**:
The section of the model that the LLM owns: groupings, one line roles, links code cannot show, and what to hide, keyed by qualified name.
_Avoid_: notes (a UML Note is a shape on the board), annotations (clashes with type annotations), enrichment

**Extractor**:
A static analysis program that runs one language's most popular parser, fetched on first use, and writes facts, with no LLM involved.
_Avoid_: parser (the parser is what an extractor runs), scanner, indexer

### Viewing

**View**:
A named perspective on the model, such as Architecture, System design or Data design, shown as one tab and switched on or off in configuration.
_Avoid_: diagram type, mode, layer

**Architecture view**:
The first view: packages nested as UML folders the way the code nests, with classes and their members inside, joined by UML relationship arrows.
_Avoid_: architecture diagram (not a UML diagram type), code map

**Symbol**:
A fixed UML or system glyph, such as an arrowhead, diamond, lollipop, socket, actor or language logo, taken from a credited outside source and never drawn by hand.
_Avoid_: icon, glyph, marker

**Shape**:
A box or line that the layout sizes to its content, such as a class compartment, a package body or a connector.
_Avoid_: node, figure

**Board**:
The read only surface that shows one view, panned freely in any direction and zoomed in and out.
_Avoid_: canvas, page, diagram
