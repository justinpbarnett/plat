import importlib
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

from plat import store
from plat.files import FAMILIES, SourceFile, list_files
from plat.toolchain import ExtractorFailed, ToolMissing

STRENGTH = ["generalization", "realization", "composition", "aggregation", "association", "dependency"]


def extractor(family: str):
    name = f"plat.extractors.{family}"
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError as missing:
        if missing.name != name:
            raise
        return None


def merge(facts: dict, part: dict) -> None:
    for element_id, element in part.get("elements", {}).items():
        current = facts["elements"].get(element_id)
        if current is None:
            facts["elements"][element_id] = element
        elif current["kind"] == "package" and element["kind"] == "package":
            continue
        else:
            print(f"warning: two languages define {element_id}; keeping the {current.get('language')} one", file=sys.stderr)
    facts["relationships"].extend(part.get("relationships", []))


def tidy_relationships(facts: dict) -> list[dict]:
    elements = facts["elements"]
    seen, joined = set(), defaultdict(set)
    kept = []
    for relationship in sorted(facts["relationships"], key=lambda r: STRENGTH.index(r["kind"]) if r["kind"] in STRENGTH else 99):
        if relationship["from"] not in elements or relationship["to"] not in elements or relationship["from"] == relationship["to"]:
            continue
        pair = (relationship["from"], relationship["to"])
        key = (*pair, relationship["kind"], relationship.get("label"))
        if key in seen:
            continue
        if relationship["kind"] == "dependency" and joined[pair]:
            continue
        seen.add(key)
        joined[pair].add(relationship["kind"])
        kept.append(relationship)
    return kept


def mark_tests(facts: dict, files: list[SourceFile]) -> None:
    tests = {source.path for source in files if source.test}
    elements = facts["elements"]
    for element in elements.values():
        if element["kind"] != "package" and element.get("path") in tests and not element.get("hidden"):
            element["hidden"] = "test"
    children = defaultdict(list)
    for element_id, element in elements.items():
        if element.get("parent"):
            children[element["parent"]].append(element_id)

    def all_tests(element_id: str) -> bool:
        element = elements[element_id]
        if element["kind"] != "package":
            return element.get("hidden") == "test"
        kids = children[element_id]
        result = bool(kids) and all([all_tests(kid) for kid in kids])
        if result and not element.get("hidden"):
            element["hidden"] = "test"
        return result

    for element_id, element in elements.items():
        if not element.get("parent"):
            all_tests(element_id)


def gone_overlay_entries(model: dict) -> int:
    elements = model["facts"]["elements"]
    overlay = model.get("overlay", {})
    components = {component.get("id") for component in overlay.get("components", [])}
    count = sum(1 for key in overlay.get("roles", {}) if key not in elements and key not in components)
    count += sum(1 for link in overlay.get("links", []) if link.get("from") not in elements or link.get("to") not in elements)
    count += sum(1 for key in overlay.get("hidden", []) if key not in elements)
    count += sum(1 for component in overlay.get("components", []) for key in component.get("packages", []) if key not in elements)
    return count


def run(root: Path, config: dict) -> int:
    started = time.time()
    files, skipped = list_files(root, config["scan"])
    groups = defaultdict(list)
    for source in files:
        groups[FAMILIES[source.language]].append(source)
    facts = {"extracted": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "files": {}, "skipped": {}, "elements": {}, "relationships": []}
    failed = False
    for family, sources in sorted(groups.items()):
        module = extractor(family)
        if module is None:
            skipped.update(source.language for source in sources)
            continue
        facts["files"].update(Counter(source.language for source in sources))
        try:
            part = module.extract(root, sources)
        except (ToolMissing, ExtractorFailed) as problem:
            print(f"{family}: {problem}", file=sys.stderr)
            failed = True
            continue
        merge(facts, part)
        for warning in part.get("warnings", []):
            print(f"{family}: {warning}", file=sys.stderr)
    facts["skipped"] = dict(skipped)
    facts["relationships"] = tidy_relationships(facts)
    mark_tests(facts, files)
    model = store.load_model(root)
    model["format"] = store.FORMAT
    model["facts"] = facts
    model.setdefault("overlay", store.empty_overlay())
    store.save_model(root, model)
    store.load_config(root)
    kinds = Counter(element["kind"] for element in facts["elements"].values())
    counts = ", ".join(f"{count} {kind}" for kind, count in sorted(kinds.items()))
    print(f"wrote {store.model_path(root).relative_to(root)}: {counts or 'no elements'}, {len(facts['relationships'])} relationships in {time.time() - started:.1f}s")
    if skipped:
        print("skipped, no extractor yet: " + ", ".join(f"{language} {count} files" for language, count in skipped.most_common()))
    gone = gone_overlay_entries(model)
    if gone:
        print(f"{gone} overlay entries point at elements that are gone; run plat check, then plat enrich")
    return 1 if failed else 0
