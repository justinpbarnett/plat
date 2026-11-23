import hashlib
import json
from pathlib import Path

from plat import store

MODEL_FORMAT_FILE = Path(__file__).with_name("model.md")
REPLY_LINE = "Save your reply as JSON and run: plat enrich --reply <file>"

INTRO = """\
plat draws a codebase as UML on a read only board. Extractors own the facts (packages, classes, members, relationships).
You own the overlay: the meaning that code cannot show. Fill it in from the facts below.

Your task:
- Give every element listed below a role: one line, 120 characters at most, that says what it is for.
- Group sibling packages that work as one part of the system into components (only when this brief lists packages).
- Add links for relationships code cannot show, such as HTTP calls, queues, events or shared tables.
- Hide noise: generated code, fixtures, vendored or legacy elements nobody needs on the board.
- Hint the layout where the default direction reads badly."""

REPLY_FORMAT = """\
Reply with one JSON object and nothing else. Every key is optional: "components", "roles", "links", "hidden", "layout".
- roles: merged by key into the current roles. Keys are element ids or component ids.
- components: replaces the whole component list, so repeat the ones to keep. Expected only when this brief lists packages.
- links: appended to the current links.
- hidden: unioned with the current hidden ids.
- layout: merged into the current layout.
Never write basis."""


def facts_hash(element: dict) -> str:
    def without_lines(value):
        if isinstance(value, dict):
            return {key: without_lines(item) for key, item in value.items() if key != "line"}
        if isinstance(value, list):
            return [without_lines(item) for item in value]
        return value

    text = json.dumps(without_lines(element), sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(text.encode()).hexdigest()[:8]


def overlay_section() -> str:
    lines = MODEL_FORMAT_FILE.read_text().splitlines()
    start = next(index for index, line in enumerate(lines) if line.strip() == "## Overlay")
    end = next((index for index in range(start + 1, len(lines)) if lines[index].startswith("## ")), len(lines))
    return "\n".join(lines[start:end]).strip()


def hidden_ids(model: dict) -> set[str]:
    elements = model["facts"]["elements"]
    marked = {element_id for element_id, element in elements.items() if element.get("hidden")}
    marked |= set(model.get("overlay", {}).get("hidden", []))

    def inside_hidden(element_id: str) -> bool:
        seen = set()
        while element_id is not None and element_id in elements and element_id not in seen:
            if element_id in marked:
                return True
            seen.add(element_id)
            element_id = elements[element_id].get("parent")
        return False

    return {element_id for element_id in elements if inside_hidden(element_id)}


def describe_member(member: dict) -> str:
    visibility = member.get("visibility", "")
    kind = member.get("kind")
    if kind == "literal":
        return f"{member['name']}"
    type_text = member.get("type", "")
    if kind == "method":
        params = ", ".join(f"{param['name']}: {param['type']}" if param.get("type") else param["name"] for param in member.get("params", []))
        returns = f" -> {type_text}" if type_text else ""
        return f"{visibility}{member['name']}({params}){returns}"
    return f"{visibility}{member['name']}: {type_text}" if type_text else f"{visibility}{member['name']}"


def block(element_id: str, element: dict, relationships: list[dict]) -> str:
    stereotypes = "".join(f" «{stereotype}»" for stereotype in element.get("stereotypes", []))
    place = f"{element.get('path', '')}:{element['line']}" if element.get("line") else element.get("path", "")
    lines = [f"{element_id} [{element['kind']}]{stereotypes} {place}".rstrip()]
    if element.get("doc"):
        lines.append(f"  doc: {element['doc']}")
    for member in element.get("members", []):
        if not member.get("hidden"):
            lines.append(f"  {describe_member(member)}")
    for relationship in relationships:
        label = f" {relationship['label']}" if relationship.get("label") else ""
        multiplicity = f" {relationship['multiplicity']}" if relationship.get("multiplicity") else ""
        lines.append(f"  -> {relationship['kind']} {relationship['to']}{label}{multiplicity}")
    return "\n".join(lines)


def package_tree(elements: dict) -> str:
    children: dict = {}
    classes: dict = {}
    for element_id, element in elements.items():
        if element["kind"] == "package":
            children.setdefault(element.get("parent"), []).append(element_id)
        elif element["kind"] == "class":
            classes[element.get("parent")] = classes.get(element.get("parent"), 0) + 1

    lines: list[str] = []

    def walk(parent, depth: int) -> None:
        for package_id in sorted(children.get(parent, [])):
            count = classes.get(package_id, 0)
            lines.append(f"{'  ' * depth}{package_id} ({count} {'class' if count == 1 else 'classes'})")
            walk(package_id, depth + 1)

    walk(None, 0)
    return "\n".join(lines)


def overlay_without_roles(overlay: dict) -> str:
    shown = {key: value for key, value in overlay.items() if key != "roles"}
    return json.dumps(shown, indent=1, ensure_ascii=False)


def gone_lines(overlay: dict, elements: dict) -> list[str]:
    roles = overlay.get("roles", {})
    lines = []
    for element_id in sorted(overlay.get("basis", {})):
        if element_id not in elements:
            role = f' (role: "{roles[element_id]}")' if element_id in roles else ""
            lines.append(f"- {element_id}{role}")
    return lines


def batch(model: dict, config: dict, limit: int | None, everything: bool) -> tuple[str, list[str]]:
    facts, overlay = model["facts"], model.get("overlay", {})
    elements = facts["elements"]
    basis = overlay.get("basis", {})
    if limit is None and not everything:
        limit = config["enrich"]["batch"]
    size = None if limit is None else max(limit, 0)
    hidden = set() if everything else hidden_ids(model)
    gone = gone_lines(overlay, elements)

    def needs_work(element_id: str) -> bool:
        return everything or basis.get(element_id) != facts_hash(elements[element_id])

    changed_packages = [element_id for element_id, element in elements.items() if element["kind"] == "package" and needs_work(element_id)]
    changed_classifiers = [element_id for element_id, element in elements.items() if element["kind"] != "package" and element_id not in hidden and needs_work(element_id)]
    if not changed_packages and not changed_classifiers and not gone:
        return "Nothing changed since the last overlay pass.\n", []

    chosen = changed_classifiers[:size]
    remaining = len(changed_classifiers) - len(chosen)
    outgoing: dict = {}
    for relationship in facts.get("relationships", []):
        outgoing.setdefault(relationship["from"], []).append(relationship)

    sections = [INTRO, "# Overlay format\n\n" + overlay_section(), "# Reply format\n\n" + REPLY_FORMAT]
    sections.append("# Current overlay (roles left out)\n\n" + overlay_without_roles(overlay))
    work = ["# Work"]
    if gone:
        work.append(
            "These ids were in the last overlay pass and no element has them now. "
            "If an id also no longer names a component, copy any role you want to keep to its replacement id in the reply. "
            "Delete the old role key for that id from overlay.roles in .plat/model.json before applying the reply.\n"
            + "\n".join(gone)
        )
    if changed_packages:
        work.append("Package tree (class counts):\n" + package_tree(elements))
    if chosen:
        work.append("Elements to give a role:")
        work.extend(block(element_id, elements[element_id], outgoing.get(element_id, [])) for element_id in chosen)
    else:
        work.append("No elements need a role in this brief.")
    sections.append("\n\n".join(work))
    sections.append(f"{remaining} changed elements remain after this batch.\n\n{REPLY_LINE}")
    covered = changed_packages + chosen
    return "\n\n".join(sections) + "\n", covered


def run(root: Path, limit: int | None = None, everything: bool = False) -> int:
    model = store.load_model(root)
    text, _ = batch(model, store.load_config(root), limit, everything)
    print(text, end="")
    return 0
