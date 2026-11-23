import difflib
import json
import re
from pathlib import Path, PureWindowsPath
from posixpath import dirname, normpath

from plat import store

MAX_SHOWN = 50
MAX_ROLE_LENGTH = 120
JSON_LINE_ESCAPES = str.maketrans({"\x85": "\\u0085", "\u2028": "\\u2028", "\u2029": "\\u2029"})

ELEMENT_KINDS = ["package", "class", "interface", "enum", "struct", "record", "utility"]
CLASSIFIER_KINDS = [kind for kind in ELEMENT_KINDS if kind != "package"]
MEMBER_KINDS = ["field", "method", "literal"]
RELATIONSHIP_KINDS = ["generalization", "realization", "composition", "aggregation", "association", "dependency"]
GENERALIZATION_BASE_KINDS = {
    "class": ["class"],
    "interface": ["interface"],
    "enum": ["class", "enum"],
    "record": ["record"],
}
MODULE_LANGUAGES = ["python", "typescript", "javascript", "vue"]
LANGUAGES = [*MODULE_LANGUAGES, "csharp"]
ELEMENT_HIDDEN = ["test", "private", "dunder"]
MEMBER_HIDDEN = ["private", "dunder"]
VISIBILITIES = ["+", "-", "#", "~"]
MULTIPLICITIES = ["1", "0..1", "0..*"]
DIRECTIONS = ["down", "right"]

ELEMENT_KEYS = ["kind", "name", "parent", "language", "path", "line", "stereotypes", "abstract", "doc", "hidden", "members"]
MEMBER_KEYS = ["kind", "name", "type", "params", "visibility", "static", "abstract", "hidden", "path", "line"]
RELATIONSHIP_KEYS = ["kind", "from", "to", "label", "multiplicity", "path", "line"]
COMPONENT_KEYS = ["id", "name", "role", "packages"]
LINK_KEYS = ["kind", "from", "to", "label"]
OVERLAY_KEYS = ["components", "roles", "links", "hidden", "layout", "basis"]
LAYOUT_KEYS = ["direction", "packages"]
PACKAGE_LAYOUT_KEYS = ["direction"]
MODEL_KEYS = ["format", "facts", "overlay"]
FACTS_KEYS = ["extracted", "files", "skipped", "elements", "relationships"]


def quoted(value) -> str:
    text = json.dumps(value, ensure_ascii=False).translate(JSON_LINE_ESCAPES)
    return text.encode("utf-8", errors="backslashreplace").decode("utf-8")


def one_of(options: list[str]) -> str:
    return ", ".join(quoted(option) for option in options)


def is_number(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


class Problems:
    def __init__(self):
        self.found: list[str] = []
        self.elements: dict = {}
        self.component_ids: set[str] = set()

    def add(self, path: str, problem: str, fix: str, suggestion: str | None = None) -> None:
        guess = f' did you mean {quoted(suggestion)}?' if suggestion else ""
        self.found.append(f"{path}: {problem};{guess} {fix}")

    def closest(self, value: str, candidates) -> str | None:
        matches = difflib.get_close_matches(value, candidates, n=1)
        return matches[0] if matches else None

    def missing_id(self, path: str, value, fix: str, candidates=None) -> None:
        if not isinstance(value, str):
            self.add(path, f"expected an element id string but found {quoted(value)}", fix)
            return
        suggestion = self.closest(value, self.elements if candidates is None else candidates)
        problem = "no element has this id"
        if not path.endswith(f"[{quoted(value)}]"):
            problem += f" ({quoted(value)})"
        if path.startswith("overlay."):
            fix += " The element is gone."
        self.add(path, problem, fix, suggestion)

    def unknown_keys(self, path: str, value: dict, allowed: list[str]) -> None:
        for key in value:
            if key not in allowed:
                self.add(f"{path}[{quoted(key)}]", "unknown key", f"Remove it; the keys are {one_of(allowed)}.", self.closest(key, allowed))

    def require_dict(self, path: str, value) -> bool:
        if isinstance(value, dict):
            return True
        self.add(path, f"expected an object but found {quoted(value)}", "Replace it with an object.")
        return False

    def require_list(self, path: str, value) -> bool:
        if isinstance(value, list):
            return True
        self.add(path, f"expected a list but found {quoted(value)}", "Replace it with a list.")
        return False

    def require_string(self, path: str, value, required: bool = True) -> bool:
        if isinstance(value, str) and (value or not required):
            return True
        expected = "a non-empty string" if required else "a string"
        self.add(path, f"expected {expected} but found {quoted(value)}", "Set a string.")
        return False

    def require_choice(self, path: str, value, options: list[str]) -> bool:
        if isinstance(value, str) and value in options:
            return True
        self.add(path, f"{quoted(value)} is not allowed", f"Use one of {one_of(options)}.", self.closest(value, options) if isinstance(value, str) else None)
        return False

    def require_line(self, path: str, value) -> None:
        if not is_number(value) or value < 1:
            self.add(path, f"expected a line number from 1 but found {quoted(value)}", "Set an integer from 1 or remove the key.")

    def require_flag(self, path: str, value) -> None:
        if not isinstance(value, bool):
            self.add(path, f"expected true or false but found {quoted(value)}", "Set true or remove the key.")


def is_package(problems: Problems, element_id) -> bool:
    return kind_of(problems, element_id) == "package"


def kind_of(problems: Problems, element_id) -> str:
    element = problems.elements.get(element_id) if isinstance(element_id, str) else None
    kind = element.get("kind") if isinstance(element, dict) else None
    return kind if kind in ELEMENT_KINDS else "malformed element"


def ids_of_kinds(problems: Problems, kinds: list[str]):
    return (element_id for element_id in problems.elements if kind_of(problems, element_id) in kinds)


def check_params(problems: Problems, path: str, params) -> None:
    if not problems.require_list(path, params):
        return
    for index, param in enumerate(params):
        param_path = f"{path}[{index}]"
        if problems.require_dict(param_path, param):
            problems.unknown_keys(param_path, param, ["name", "type"])
            problems.require_string(f"{param_path}.name", param.get("name"))
            if "type" not in param:
                problems.add(f"{param_path}.type", "the key is missing", "Set the type, or use an empty string for an untyped parameter.")
            else:
                problems.require_string(f"{param_path}.type", param["type"], required=False)


def check_member(problems: Problems, path: str, member, owner_kind, owner_source) -> None:
    if not problems.require_dict(path, member):
        return
    problems.unknown_keys(path, member, MEMBER_KEYS)
    kind = member.get("kind")
    problems.require_choice(f"{path}.kind", kind, MEMBER_KINDS)
    if kind == "literal" and owner_kind != "enum":
        problems.add(f"{path}.kind", "a literal is an enum value", "Use field or method, or move the literal to an enum.")
    problems.require_string(f"{path}.name", member.get("name"))
    if "type" in member:
        problems.require_string(f"{path}.type", member["type"], required=False)
    if kind == "method" or "params" in member:
        if "params" not in member:
            problems.add(f"{path}.params", "a method needs params", "Add a list of {\"name\", \"type\"} objects, empty when there are none.")
        else:
            check_params(problems, f"{path}.params", member["params"])
    if "visibility" in member:
        problems.require_choice(f"{path}.visibility", member["visibility"], VISIBILITIES)
    for flag in ("static", "abstract"):
        if flag in member:
            problems.require_flag(f"{path}.{flag}", member[flag])
    if "hidden" in member:
        problems.require_choice(f"{path}.hidden", member["hidden"], MEMBER_HIDDEN)
    if "path" in member:
        check_source_override(problems, f"{path}.path", member["path"], owner_source)
    if "line" in member:
        problems.require_line(f"{path}.line", member["line"])


def check_parent(problems: Problems, element_id: str, path: str, element: dict) -> None:
    parent_path = f"{path}.parent"
    requires_package = element.get("kind") in CLASSIFIER_KINDS and element.get("language") != "csharp"
    fix = "Set the id of the enclosing package." if requires_package else "Set the id of the enclosing package, or null at the top."
    if "parent" not in element:
        problems.add(parent_path, "the key is missing", fix)
        return
    parent = element["parent"]
    if parent is None:
        if requires_package:
            problems.add(parent_path, "only classifiers in the C# global namespace can have a null parent", fix)
        return
    if not isinstance(parent, str) or parent not in problems.elements:
        candidates = (candidate for candidate in ids_of_kinds(problems, ["package"]) if candidate != element_id)
        problems.missing_id(parent_path, parent, fix, candidates)
        return
    if not is_package(problems, parent):
        kind = kind_of(problems, parent)
        problems.add(parent_path, f"{quoted(parent)} is a {kind}, not a package", fix)


def check_parent_cycles(problems: Problems) -> None:
    for element_id, element in problems.elements.items():
        if not isinstance(element, dict):
            continue
        seen = {element_id}
        parent = element.get("parent")
        while isinstance(parent, str) and isinstance(problems.elements.get(parent), dict):
            if parent in seen:
                problems.add(f"facts.elements[{quoted(element_id)}].parent", f"the parents loop back through {quoted(parent)}", "Set a parent chain that ends at null.")
                break
            seen.add(parent)
            parent = problems.elements[parent].get("parent")


def check_source_path(problems: Problems, path: str, value) -> None:
    if not problems.require_string(path, value):
        return
    normalized = normpath(value)
    if value.startswith("/") or "\\" in value or "\0" in value or PureWindowsPath(value).drive or normalized == ".." or normalized.startswith("../"):
        problems.add(path, f"{quoted(value)} is not a repository-relative path with forward slashes", "Use a path from the repository root with forward slashes.")


def check_source_override(problems: Problems, path: str, value, default) -> None:
    check_source_path(problems, path, value)
    if isinstance(value, str) and isinstance(default, str) and normpath(value) == normpath(default):
        problems.add(path, "the path repeats the element's source file", "Remove the override; set it only for a declaration in a different file.")


def package_can_enclose(package: dict, element: dict) -> bool:
    language, package_language = element.get("language"), package.get("language")
    if "csharp" in (language, package_language):
        return language in (None, "csharp") and package_language in (None, "csharp")
    source, package_source = element.get("path"), package.get("path")
    if not isinstance(source, str) or not isinstance(package_source, str):
        return True
    source, package_source = normpath(source), normpath(package_source)
    return package_source == (dirname(source) or ".") or (element["kind"] != "package" and package_source == source)


def enclosing_ids(problems: Problems, element_id: str, element: dict) -> tuple[str | None, str | None]:
    language, is_classifier = element.get("language"), element["kind"] != "package"
    outer_id = None
    prefix = element_id.rpartition(".")[0]
    while prefix:
        kind = kind_of(problems, prefix)
        if kind == "package" and package_can_enclose(problems.elements[prefix], element):
            return outer_id, prefix
        if is_classifier and outer_id is None and kind in CLASSIFIER_KINDS and (kind != "utility" or language == "csharp"):
            if problems.elements[prefix].get("language") == language:
                outer_id = prefix
        prefix = prefix.rpartition(".")[0]
    return outer_id, None


def check_enclosure(problems: Problems, path: str, element_id: str, element: dict, package_id, outer_id) -> None:
    if element["parent"] != package_id:
        problem = f"the enclosing package is {quoted(package_id)}"
        if outer_id is not None:
            problem = f"a nested type must share the package of {quoted(outer_id)}"
        problems.add(f"{path}.parent", problem, f"Set it to {quoted(package_id)}.")
    expected_name = element_id.removeprefix(f"{package_id}.") if package_id is not None else element_id
    if element["name"] != expected_name:
        problem = "a nested type must include the name of its outer type" if outer_id is not None else "the name must be relative to its enclosing package"
        problems.add(f"{path}.name", problem, f"Set it to {quoted(expected_name)}.")


def check_qualified_id(problems: Problems, path: str, element_id: str, element: dict) -> None:
    parent, language, name = element["parent"], element.get("language"), element["name"]
    is_package_element = element["kind"] == "package"
    if parent is None and not is_package_element and language != "csharp":
        return
    outer_id, package_id = enclosing_ids(problems, element_id, element)
    if package_id is not None:
        check_enclosure(problems, path, element_id, element, package_id, outer_id)
        return
    if outer_id is not None:
        outer = problems.elements[outer_id]
        outer_parent = outer.get("parent")
        global_outer = outer_parent is None and language == "csharp" and "parent" in outer
        packaged_outer = is_package(problems, outer_parent) and outer_id.startswith(f"{outer_parent}.")
        if global_outer or packaged_outer:
            check_enclosure(problems, path, element_id, element, outer_parent, outer_id)
            return
    if is_package_element and parent is None:
        return
    expected_id = f"{parent}.{name}" if parent is not None else name
    if element_id != expected_id:
        problem = "the child package id must be qualified by its parent" if is_package_element else "the classifier id must be its qualified name"
        problems.add(path, problem, f"Rename the key to {quoted(expected_id)} and update its references.")


def check_element(problems: Problems, element_id: str, element) -> None:
    path = f"facts.elements[{quoted(element_id)}]"
    if not element_id.strip():
        problems.add(path, "the element id is blank", "Use the element's qualified name as the key and update references to it.")
    if not problems.require_dict(path, element):
        return
    problems.unknown_keys(path, element, ELEMENT_KEYS)
    kind = element.get("kind")
    problems.require_choice(f"{path}.kind", kind, ELEMENT_KINDS)
    name = element.get("name")
    valid_name = problems.require_string(f"{path}.name", name)
    check_parent(problems, element_id, path, element)
    parent = element.get("parent")
    package_parent = is_package(problems, parent)
    classifier = kind in CLASSIFIER_KINDS
    if kind == "utility" and element.get("language") in MODULE_LANGUAGES and package_parent:
        expected_id = f"{parent}:utility"
        if element_id != expected_id:
            problems.add(path, "a module utility id must be its module id followed by :utility", f"Rename the key to {quoted(expected_id)} and update its references.")
        module_name = problems.elements[parent].get("name")
        if valid_name and isinstance(module_name, str) and module_name and name != module_name:
            problems.add(f"{path}.name", "a module utility must use its module's name", f"Set it to {quoted(module_name)}.")
    elif valid_name and kind in ELEMENT_KINDS and (package_parent or ("parent" in element and parent is None)):
        check_qualified_id(problems, path, element_id, element)
    for key in ("language", "path"):
        if key in element or classifier:
            if key not in element:
                problems.add(f"{path}.{key}", "a classifier needs this key", "Add it.")
            elif key == "language":
                problems.require_choice(f"{path}.language", element["language"], LANGUAGES)
            else:
                check_source_path(problems, f"{path}.path", element["path"])
    if "line" in element:
        problems.require_line(f"{path}.line", element["line"])
    if "stereotypes" in element:
        stereotypes = element["stereotypes"]
        if problems.require_list(f"{path}.stereotypes", stereotypes):
            for index, stereotype in enumerate(stereotypes):
                problems.require_string(f"{path}.stereotypes[{index}]", stereotype)
    if "abstract" in element:
        problems.require_flag(f"{path}.abstract", element["abstract"])
    if "doc" in element:
        problems.require_string(f"{path}.doc", element["doc"], required=False)
    if "hidden" in element:
        problems.require_choice(f"{path}.hidden", element["hidden"], ELEMENT_HIDDEN)
    if "members" in element:
        if kind == "package":
            problems.add(f"{path}.members", "packages cannot have members", "Remove the key and put the members on a classifier.")
        elif problems.require_list(f"{path}.members", element["members"]):
            for index, member in enumerate(element["members"]):
                check_member(problems, f"{path}.members[{index}]", member, kind, element.get("path"))


def check_relationship(problems: Problems, path: str, relationship, fix_ends: str) -> None:
    if not problems.require_dict(path, relationship):
        return
    is_link = path.startswith("overlay")
    problems.unknown_keys(path, relationship, LINK_KEYS if is_link else RELATIONSHIP_KEYS)
    kind = relationship.get("kind")
    valid_kind = problems.require_choice(f"{path}.kind", kind, RELATIONSHIP_KINDS)
    source_kind = kind_of(problems, relationship.get("from"))
    target_kind = kind_of(problems, relationship.get("to"))
    source_kinds, target_kinds = ELEMENT_KINDS, ELEMENT_KINDS
    if valid_kind and not is_link:
        source_kinds, target_kinds = fact_endpoint_kinds(kind, source_kind)
        if kind == "generalization" and target_kind in GENERALIZATION_BASE_KINDS:
            source_kinds = [candidate for candidate in source_kinds if target_kind in GENERALIZATION_BASE_KINDS[candidate]]
    for end, kinds in (("from", source_kinds), ("to", target_kinds)):
        endpoint = f"{path}.{end}"
        if end not in relationship:
            problems.add(endpoint, "the key is missing", "Set the id of an existing element.")
        elif not isinstance(relationship[end], str) or relationship[end] not in problems.elements:
            problems.missing_id(endpoint, relationship[end], fix_ends, ids_of_kinds(problems, kinds))
    if "label" in relationship:
        problems.require_string(f"{path}.label", relationship["label"], required=False)
    if not is_link:
        if "multiplicity" in relationship:
            problems.require_choice(f"{path}.multiplicity", relationship["multiplicity"], MULTIPLICITIES)
        if "path" in relationship:
            source = relationship.get("from")
            owner = problems.elements.get(source) if isinstance(source, str) else None
            owner_source = owner.get("path") if isinstance(owner, dict) else None
            check_source_override(problems, f"{path}.path", relationship["path"], owner_source)
        if "line" in relationship:
            problems.require_line(f"{path}.line", relationship["line"])


def fact_endpoint_kinds(kind: str, source_kind: str) -> tuple[list[str], list[str]]:
    if kind == "generalization":
        source_kinds = list(GENERALIZATION_BASE_KINDS)
        return source_kinds, GENERALIZATION_BASE_KINDS.get(source_kind, source_kinds)
    if kind == "realization":
        return ["class"], ["interface"]
    if kind == "dependency":
        return ELEMENT_KINDS, ELEMENT_KINDS
    return CLASSIFIER_KINDS, CLASSIFIER_KINDS


def check_fact_endpoint_kinds(problems: Problems, path: str, kind: str, source, target) -> None:
    source_kind = kind_of(problems, source)
    target_kind = kind_of(problems, target)
    source_kinds, target_kinds = fact_endpoint_kinds(kind, source_kind)
    for end, element_id, actual, allowed in (
        ("from", source, source_kind, source_kinds),
        ("to", target, target_kind, target_kinds),
    ):
        if actual in ELEMENT_KINDS and actual not in allowed:
            problems.add(
                f"{path}.{end}",
                f"{kind} requires an element of kind {one_of(allowed)}, but {quoted(element_id)} has kind {quoted(actual)}",
                "Use an element id of an allowed kind or remove the relationship.",
            )


def check_fact_relationships(problems: Problems, relationships: list) -> None:
    seen = {}
    stronger = {}
    dependencies = []
    for index, relationship in enumerate(relationships):
        path = f"facts.relationships[{index}]"
        check_relationship(problems, path, relationship, "Fix the id or remove the relationship.")
        if not isinstance(relationship, dict):
            continue
        source, target = relationship.get("from"), relationship.get("to")
        kind, label = relationship.get("kind"), relationship.get("label")
        if kind not in RELATIONSHIP_KINDS:
            continue
        check_fact_endpoint_kinds(problems, path, kind, source, target)
        if not all(isinstance(end, str) and end in problems.elements for end in (source, target)):
            continue
        if label is not None and not isinstance(label, str):
            continue
        pair = (source, target)
        key = (pair, kind, label)
        if key in seen:
            problems.add(path, f"duplicates the endpoints, kind and label of {seen[key]}", "Remove this duplicate relationship.")
            continue
        seen[key] = path
        if kind == "dependency":
            dependencies.append((pair, path))
        else:
            stronger.setdefault(pair, path)

    for pair, path in dependencies:
        if pair in stronger:
            problems.add(path, f"{stronger[pair]} already joins these endpoints with a stronger relationship", "Remove this dependency.")


def check_facts(problems: Problems, facts) -> None:
    if not problems.require_dict("facts", facts):
        return
    problems.unknown_keys("facts", facts, FACTS_KEYS)
    if "extracted" in facts:
        problems.require_string("facts.extracted", facts["extracted"])
    for key in ("files", "skipped"):
        path = f"facts.{key}"
        if key in facts and problems.require_dict(path, facts[key]):
            for language, count in facts[key].items():
                if not is_number(count) or count < 0:
                    problems.add(f"{path}[{quoted(language)}]", f"expected a file count but found {quoted(count)}", "Set a non-negative integer.")
    elements = facts.get("elements")
    if not problems.require_dict("facts.elements", elements):
        elements = {}
    problems.elements = elements
    for element_id, element in elements.items():
        check_element(problems, element_id, element)
    check_parent_cycles(problems)
    relationships = facts.get("relationships")
    if problems.require_list("facts.relationships", relationships):
        check_fact_relationships(problems, relationships)


def check_role_text(problems: Problems, path: str, role) -> None:
    if not isinstance(role, str):
        problems.add(path, f"expected a one line string but found {quoted(role)}", "Write the role as one line of text.")
    elif role and role.splitlines() != [role]:
        problems.add(path, "the role has more than one line", "Write the role as one line of text.")
    elif len(role) > MAX_ROLE_LENGTH:
        problems.add(path, f"the role has {len(role)} characters, over the limit of {MAX_ROLE_LENGTH}", f"Shorten it to {MAX_ROLE_LENGTH} characters or fewer.")


def check_components(problems: Problems, components) -> None:
    if not problems.require_list("overlay.components", components):
        return
    first_owner: dict[str, int] = {}
    seen_ids: dict[str, int] = {}
    for index, component in enumerate(components):
        path = f"overlay.components[{index}]"
        if not problems.require_dict(path, component):
            continue
        problems.unknown_keys(path, component, COMPONENT_KEYS)
        component_id = component.get("id")
        if problems.require_string(f"{path}.id", component_id):
            if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", component_id):
                problems.add(f"{path}.id", f"{quoted(component_id)} is not a slug", "Use lowercase letters and digits, separated by single hyphens if needed.")
            if component_id in seen_ids:
                problems.add(f"{path}.id", f"{quoted(component_id)} is already the id of overlay.components[{seen_ids[component_id]}]", "Give each component its own short slug.")
            else:
                seen_ids[component_id] = index
                problems.component_ids.add(component_id)
        problems.require_string(f"{path}.name", component.get("name"))
        if "role" in component:
            check_role_text(problems, f"{path}.role", component["role"])
        packages = component.get("packages")
        if not problems.require_list(f"{path}.packages", packages):
            continue
        first_parent_package = None
        for position, package_id in enumerate(packages):
            package_path = f"{path}.packages[{position}]"
            if not isinstance(package_id, str) or package_id not in problems.elements:
                problems.missing_id(package_path, package_id, "Fix the id or remove it from the component.", ids_of_kinds(problems, ["package"]))
                continue
            if not is_package(problems, package_id):
                kind = kind_of(problems, package_id)
                problems.add(package_path, f"{quoted(package_id)} is a {kind}, not a package", "List packages only.")
                continue
            owner = first_owner.setdefault(package_id, index)
            if owner != index:
                problems.add(package_path, f"{quoted(package_id)} already belongs to overlay.components[{owner}]", "Keep a package in one component only.")
            parent = problems.elements[package_id].get("parent")
            if first_parent_package is None:
                first_parent_package = (package_id, parent)
            elif parent != first_parent_package[1]:
                problems.add(
                    package_path,
                    f"{quoted(package_id)} has parent {quoted(parent)} but {quoted(first_parent_package[0])} has parent {quoted(first_parent_package[1])}",
                    "Group only sibling packages that share one parent.",
                )


def check_roles(problems: Problems, roles) -> None:
    if not problems.require_dict("overlay.roles", roles):
        return
    known = problems.elements.keys() | problems.component_ids
    for key, role in roles.items():
        path = f"overlay.roles[{quoted(key)}]"
        if key not in known:
            problems.missing_id(path, key, "Fix the key or remove the entry.", known)
        check_role_text(problems, path, role)


def check_links(problems: Problems, links) -> None:
    if not problems.require_list("overlay.links", links):
        return
    for index, link in enumerate(links):
        check_relationship(problems, f"overlay.links[{index}]", link, "Fix the id or remove the link.")


def check_hidden(problems: Problems, hidden, *, allow_gone: bool = False) -> None:
    if not problems.require_list("overlay.hidden", hidden):
        return
    for index, element_id in enumerate(hidden):
        if not isinstance(element_id, str) or (not allow_gone and element_id not in problems.elements):
            problems.missing_id(f"overlay.hidden[{index}]", element_id, "Fix the id or remove it from the list.")


def check_layout(problems: Problems, layout) -> None:
    if not problems.require_dict("overlay.layout", layout):
        return
    problems.unknown_keys("overlay.layout", layout, LAYOUT_KEYS)
    if "direction" in layout:
        problems.require_choice("overlay.layout.direction", layout["direction"], DIRECTIONS)
    if "packages" not in layout:
        return
    packages = layout["packages"]
    if not problems.require_dict("overlay.layout.packages", packages):
        return
    for package_id, hint in packages.items():
        path = f"overlay.layout.packages[{quoted(package_id)}]"
        if package_id not in problems.elements:
            problems.missing_id(path, package_id, "Fix the key or remove the entry.", ids_of_kinds(problems, ["package"]))
        elif not is_package(problems, package_id):
            problems.add(path, f"{quoted(package_id)} is not a package", "Hint layout for packages only.")
        if problems.require_dict(path, hint):
            problems.unknown_keys(path, hint, PACKAGE_LAYOUT_KEYS)
            if "direction" in hint:
                problems.require_choice(f"{path}.direction", hint["direction"], DIRECTIONS)


def check_basis(problems: Problems, basis) -> None:
    if not problems.require_dict("overlay.basis", basis):
        return
    for key, value in basis.items():
        if not isinstance(value, str):
            problems.add(f"overlay.basis[{quoted(key)}]", f"expected a hash string but found {quoted(value)}", "Remove the entry; plat rewrites it on the next enrich.")


def check_overlay(problems: Problems, overlay) -> None:
    problems.unknown_keys("overlay", overlay, OVERLAY_KEYS)
    if "components" in overlay:
        check_components(problems, overlay["components"])
    if "roles" in overlay:
        check_roles(problems, overlay["roles"])
    if "links" in overlay:
        check_links(problems, overlay["links"])
    if "hidden" in overlay:
        check_hidden(problems, overlay["hidden"])
    if "layout" in overlay:
        check_layout(problems, overlay["layout"])
    if "basis" in overlay:
        check_basis(problems, overlay["basis"])


def check_base_model(model) -> Problems:
    problems = Problems()
    if not isinstance(model, dict):
        problems.add("$", f"expected an object but found {quoted(model)}", "Write the model as one JSON object with format, facts and overlay.")
        return problems
    problems.unknown_keys("", model, MODEL_KEYS)
    if model.get("format") != store.FORMAT:
        problems.add("format", f"expected {quoted(store.FORMAT)} but found {quoted(model.get('format'))}", f"Set it to {quoted(store.FORMAT)}.")
    check_facts(problems, model.get("facts"))
    if "overlay" in model:
        problems.require_dict("overlay", model["overlay"])
    else:
        problems.add("overlay", "the key is missing", 'Add "overlay": {}.')
    return problems


def errors(model) -> list[str]:
    problems = check_base_model(model)
    if isinstance(model, dict) and isinstance(model.get("overlay"), dict):
        check_overlay(problems, model["overlay"])
    return problems.found


def counts_line(model: dict) -> str:
    facts, overlay = model["facts"], model["overlay"]
    parts = [
        f"{len(facts.get('elements', {}))} elements",
        f"{len(facts.get('relationships', []))} relationships",
        f"overlay {len(overlay.get('components', []))} components, {len(overlay.get('roles', {}))} roles, "
        f"{len(overlay.get('links', []))} links, {len(overlay.get('hidden', []))} hidden",
    ]
    return "ok: " + ", ".join(parts)


def load_model(root: Path):
    path = store.model_path(root)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as broken:
        raise ValueError(f"{path}: not valid JSON at line {broken.lineno} column {broken.colno}: {broken.msg}; Fix the syntax or run plat extract.") from broken
    except UnicodeDecodeError as broken:
        raise ValueError(f"{path}: invalid UTF-8 at byte {broken.start}; Save the model as UTF-8 or run plat extract.") from broken
    except OSError as broken:
        raise ValueError(f"{path}: {broken.strerror}; Make the model readable or run plat extract.") from broken


def print_errors(found: list[str], *, file=None) -> int:
    for line in found[:MAX_SHOWN]:
        print(line, file=file)
    if len(found) > MAX_SHOWN:
        print(f"... and {len(found) - MAX_SHOWN} more errors", file=file)
    return 1


def run(root: Path) -> int:
    try:
        model = load_model(root)
    except ValueError as broken:
        print(broken)
        return 1
    found = errors(model)
    if found:
        return print_errors(found)
    print(counts_line(model))
    return 0
