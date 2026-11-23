# Plat model format

A model is one JSON file, `.plat/model.json`, with two sections. Extractors own `facts` and rewrite it on every `plat extract`. The LLM owns `overlay`. Every id is a qualified name, such as `arete.tracker.Ticket` or `Shop.Model.Order`.

```json
{
  "format": "plat/1",
  "facts": {},
  "overlay": {}
}
```

## Facts

```json
"facts": {
  "extracted": "2026-11-23T18:00:00Z",
  "files": {"python": 267},
  "skipped": {"go": 3},
  "elements": {
    "arete": {"kind": "package", "name": "arete", "parent": null, "language": "python", "path": "arete"},
    "arete.tracker": {"kind": "package", "name": "tracker", "parent": "arete", "language": "python", "path": "arete/tracker.py", "line": 1},
    "arete.tracker:utility": {"kind": "utility", "name": "tracker", "parent": "arete.tracker", "language": "python", "path": "arete/tracker.py", "line": 1,
      "members": [{"kind": "method", "name": "load", "params": [{"name": "path", "type": "Path"}], "type": "Ticket", "visibility": "+", "static": true, "line": 30}]},
    "arete.tracker.Ticket": {
      "kind": "class", "name": "Ticket", "parent": "arete.tracker", "language": "python",
      "path": "arete/tracker.py", "line": 66,
      "stereotypes": ["dataclass"], "doc": "One ticket as any tracker returns it.",
      "members": [
        {"kind": "field", "name": "images", "type": "list[Image]", "visibility": "+", "line": 80},
        {"kind": "method", "name": "close", "params": [{"name": "reason", "type": "str"}], "type": "None", "visibility": "+", "line": 90},
        {"kind": "method", "name": "_cache", "params": [], "type": "", "visibility": "-", "hidden": "private", "line": 95}
      ]
    }
  },
  "relationships": [
    {"kind": "aggregation", "from": "arete.tracker.Ticket", "to": "arete.tracker.Image", "label": "images", "multiplicity": "0..*", "line": 80},
    {"kind": "dependency", "from": "arete.triage", "to": "arete.tracker"}
  ]
}
```

### Elements

`elements` maps each id to one element.

| Key | Required | Value |
|-----|----------|-------|
| `kind` | yes | `package`, `class`, `interface`, `enum`, `struct`, `record` or `utility` |
| `name` | yes | The name shown on the board. A nested type is named `Outer.Inner` |
| `parent` | yes | The id of the enclosing package, or `null` at the top |
| `language` | classifiers | `python`, `typescript`, `javascript`, `vue` or `csharp` |
| `path` | classifiers | File path from the repo root, with forward slashes |
| `line` | no | Line of the declaration, counted from 1 |
| `stereotypes` | no | Extra stereotypes shown in guillemets, such as `dataclass` or `vue` |
| `abstract` | no | `true` for an abstract class, shown in italics |
| `doc` | no | The first sentence of the docstring or doc comment |
| `hidden` | no | Why the board hides it by default: `test`, `private` or `dunder` |
| `members` | no | The members of a classifier, in source order |

Kinds:

- `package`: a directory or a module file (Python, TypeScript, JavaScript, Vue) or a namespace (C#). Packages nest the way the code nests.
- `class`, `interface`, `enum`, `struct`, `record`: the classifier of that name. A Vue single file component is a `class` with the stereotype `vue`.
- `utility`: the module level functions and variables of one module, with the id `<module id>:utility` and the module's name, or a C# static class.

The parent of a classifier is a package, or `null` for a C# type in the global namespace. A nested type keeps its own qualified id (`arete.tracker.Ticket.Meta`) and its parent is the package of its outer type.

### Members

| Key | Required | Value |
|-----|----------|-------|
| `kind` | yes | `field`, `method` or `literal` (an enum value) |
| `name` | yes | The member name |
| `type` | no | The field type or the method return type, as written in the code |
| `params` | methods | A list of `{"name", "type"}` |
| `visibility` | no | `+` public, `-` private, `#` protected, `~` package or internal |
| `static` | no | `true` for a static or class level member, shown underlined |
| `abstract` | no | `true` for an abstract member, shown in italics |
| `hidden` | no | `private` or `dunder` |
| `path` | no | File path from the repo root when the member is declared in another file than its element, such as a second part of a C# partial class |
| `line` | no | Line of the declaration, in the member's `path` when it has one, else in the element's file |

Fields include properties. Methods include constructors.

### Relationships

| Kind | `from` | `to` |
|------|--------|------|
| `generalization` | The subclass, or an interface | The superclass, or the interface it extends |
| `realization` | A class | The interface it implements |
| `composition` | The whole | A part the whole creates itself, such as a constructor call assigned to a field |
| `aggregation` | The whole | The item type of a collection field the whole did not create |
| `association` | The owner of a field | The type of that single field, not created by the owner |
| `dependency` | A classifier, or a package | A classifier used only in signatures or bodies, or a package it imports or uses |

`label` is the field name. `multiplicity` sits at the `to` end: `1`, `0..1` or `0..*`. `line` is the line in the relationship's `path` when it has one, else in the `from` element's file. A relationship has a `path` only when it is declared in another file than its `from` element. Between one pair of elements there is at most one relationship of each kind and label, and a dependency only when no stronger relationship joins that pair.

## Overlay

```json
"overlay": {
  "components": [
    {"id": "tracking", "name": "Tracking", "role": "Reads and moves tickets in GitHub, Jira or a local file", "packages": ["arete.tracker", "arete.triage"]}
  ],
  "roles": {"arete.tracker.Ticket": "One ticket as any tracker returns it"},
  "links": [
    {"kind": "dependency", "from": "arete.triage.JiraSource", "to": "arete.jira.Client", "label": "calls the Jira REST API"}
  ],
  "hidden": ["arete.legacy"],
  "layout": {"direction": "down", "packages": {"arete": {"direction": "right"}}},
  "basis": {"arete.tracker.Ticket": "5f2c9a1e"}
}
```

| Key | Value |
|-----|-------|
| `components` | Groups of packages that work as one part of the system. `id` is a short unique slug. Every package in one component has the same parent, and a package belongs to one component at most |
| `roles` | One line, 120 characters at most, that says what an element or component is for. Keys are element ids or component ids |
| `links` | Relationships the code cannot show, such as HTTP calls, queues, events or shared tables. `from` and `to` are element ids and `kind` is one of the six relationship kinds |
| `hidden` | Element ids that the board hides by default |
| `layout` | Hints for the layout. `direction` is `down` (the default) or `right`, for the whole board or per package id |
| `basis` | Written by plat to remember what the last overlay pass saw. Never edit it |
