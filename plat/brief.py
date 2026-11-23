import hashlib
import json
import sys
from pathlib import Path

from plat import check, store

MODEL_FORMAT_FILE = Path(__file__).with_name("model.md")
REPLY_LINE = "Save your reply as JSON and run: plat enrich --reply <file>"

INTRO = """\
plat draws a codebase as UML on a read only board. Extractors own the facts (packages, classes, members, relationships).
You own the overlay: the meaning that code cannot show. Fill it in from the facts below.

Your task:
- Give each package marked [needs role] and each classifier block a role: one line, 120 characters at most, that says what it is for.
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
    return hashlib.sha1(text.encode("utf-8", errors="backslashreplace")).hexdigest()[:8]


def overlay_section() -> str:
    lines = MODEL_FORMAT_FILE.read_text(encoding="utf-8").splitlines()
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


def package_tree(elements: dict, changed_packages: set[str]) -> str:
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
            status = "needs role" if package_id in changed_packages else "context"
            lines.append(f"{'  ' * depth}{package_id} ({count} {'class' if count == 1 else 'classes'}) [{status}]")
            walk(package_id, depth + 1)

    walk(None, 0)
    return "\n".join(lines)


def current_overlay(overlay: dict) -> str:
    shown = {key: value for key, value in overlay.items() if key not in ("roles", "basis")}
    return json.dumps(shown, indent=1, ensure_ascii=False)


def gone_lines(overlay: dict, elements: dict) -> list[str]:
    gone_ids = overlay.get("basis", {}).keys() - elements.keys()
    if not gone_ids:
        return []
    component_ids = {component["id"] for component in overlay.get("components", [])}
    roles = overlay.get("roles", {})
    lines = []
    for element_id in sorted(gone_ids):
        note = ""
        if element_id in component_ids:
            note = " (still a component id)"
        elif element_id in roles:
            note = f" (role: {check.quoted(roles[element_id])})"
        lines.append(f"- {element_id}{note}")
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
    sections.append("# Current overlay\n\n" + current_overlay(overlay))
    work = ["# Work"]
    if gone:
        work.append(
            "These ids were in the last overlay pass and no element has them now. "
            "For each id that no longer names a component, copy any role you want to keep to its replacement id in the reply "
            "and delete the old role key from overlay.roles in .plat/model.json before applying the reply.\n"
            + "\n".join(gone)
        )
    if changed_packages:
        work.append("Package tree (class counts):\n" + package_tree(elements, set(changed_packages)))
    if chosen:
        work.append("Elements to give a role:")
        work.extend(block(element_id, elements[element_id], outgoing.get(element_id, [])) for element_id in chosen)
    else:
        work.append("No classifiers in this batch.")
    sections.append("\n\n".join(work))
    sections.append(f"{remaining} changed elements remain after this batch.\n\n{REPLY_LINE}")
    covered = changed_packages + chosen
    text = "\n\n".join(sections) + "\n"
    return text.encode("utf-8", errors="backslashreplace").decode("utf-8"), covered


def input_errors(model) -> list[str]:
    problems = check.check_base_model(model)
    overlay = model.get("overlay") if isinstance(model, dict) else None
    if isinstance(overlay, dict):
        check.check_basis(problems, overlay.get("basis", {}))
        check.check_hidden(problems, overlay.get("hidden", []), allow_gone=True)
        problems.require_dict("overlay.roles", overlay.get("roles", {}))
        components = overlay.get("components", [])
        if problems.require_list("overlay.components", components):
            for index, component in enumerate(components):
                path = f"overlay.components[{index}]"
                if problems.require_dict(path, component):
                    problems.require_string(f"{path}.id", component.get("id"))
    return problems.found


def run(root: Path, limit: int | None = None, everything: bool = False) -> int:
    try:
        model = check.load_model(root)
    except ValueError as broken:
        print(broken, file=sys.stderr)
        return 1
    found = input_errors(model)
    if found:
        return check.print_errors(found, file=sys.stderr)
    text, _ = batch(model, store.load_config(root), limit, everything)
    print(text, end="")
    return 0
