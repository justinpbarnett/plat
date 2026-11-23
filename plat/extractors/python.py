from __future__ import annotations

import ast
import builtins
import re
from collections import ChainMap
from dataclasses import dataclass
from pathlib import Path

from plat.files import SourceFile


METHODS = (ast.FunctionDef, ast.AsyncFunctionDef)
DEFINITIONS = (*METHODS, ast.ClassDef)
ENUM_BASES = {"Enum", "IntEnum", "StrEnum", "Flag", "IntFlag"}
COLLECTIONS = {"list", "List", "set", "Set", "frozenset", "FrozenSet", "tuple", "Tuple",
               "Sequence", "Iterable", "deque", "Deque"}
MAPPINGS = {"dict", "Dict", "Mapping"}
TYPE_WRAPPERS = {"Annotated", "ClassVar", "Final", "Required", "NotRequired"}


def qualify(parent, name):
    return f"{parent}.{name}" if parent else name


def dotted_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted_name(node.value)
        if parent:
            return qualify(parent, node.attr)
    return ""


def reference_name(node):
    while isinstance(node, (ast.Call, ast.Subscript)):
        node = node.func if isinstance(node, ast.Call) else node.value
    return dotted_name(node)


def scope_statements(statements):
    for node in statements:
        if isinstance(node, ast.stmt):
            yield node
        if isinstance(node, DEFINITIONS):
            continue
        children = (child for child in ast.iter_child_nodes(node)
                    if isinstance(child, (ast.stmt, ast.ExceptHandler, ast.match_case)))
        yield from scope_statements(children)


def first_sentence(node):
    doc = ast.get_docstring(node)
    if doc:
        return re.split(r"(?<=[.!?])\s+", " ".join(doc.split()), maxsplit=1)[0]
    return ""


@dataclass
class Module:
    path: str
    parts: tuple[str, ...]
    initializer: bool
    tree: ast.Module

    @property
    def id(self):
        return ".".join(self.parts) or "__init__"

    @property
    def package(self):
        return self.parts if self.initializer else self.parts[:-1]


class Index:
    def __init__(self, packages, classes):
        self.packages = packages
        self.classes = classes
        self.imports = {}
        self.suffixes = {}
        for package in packages:
            parts = package.split(".")
            for start in range(len(parts)):
                self.suffixes.setdefault(".".join(parts[start:]), []).append(package)

    def package_id(self, name):
        if name in self.packages:
            return name
        matches = self.suffixes.get(name, ())
        if len(matches) == 1:
            return matches[0]
        return None

    def import_names(self, module, node):
        if isinstance(node, ast.Import):
            for alias in node.names:
                package = self.package_id(alias.name)
                yield alias.asname or alias.name, package or alias.name, package
                head, separator, tail = alias.name.partition(".")
                if not alias.asname and separator:
                    yield head, package.removesuffix(f".{tail}") if package else head, None
            return

        base = node.module or ""
        if node.level:
            if node.level > len(module.package) + int(not module.package):
                return
            prefix = ".".join(module.package[:len(module.package) - node.level + 1])
            base = qualify(prefix, base) if base else prefix
            package = base if base in self.packages else None
            if not base and module.initializer and not module.parts:
                package = module.id
        else:
            package = self.package_id(base)

        for alias in node.names:
            name = qualify(package or base, alias.name)
            module_name = alias.name if node.level and not base else name
            child = module_name if module_name in self.packages else None
            if not package and not node.level:
                child = self.package_id(name)
            if name in self.classes:
                child = None
            yield alias.asname or alias.name, child or name, child or package

    def bind(self, module, nodes):
        return {name: target for node in nodes if isinstance(node, (ast.Import, ast.ImportFrom))
                for name, target, _ in self.import_names(module, node) if name != "*"}

    def class_id(self, name):
        visited = set()
        while True:
            if name in self.classes:
                return name
            package, _, member = name.rpartition(".")
            while package and package not in self.imports:
                package, _, part = package.rpartition(".")
                member = qualify(part, member)
            target, binding = import_binding(member, self.imports.get(package, {}))
            key = package, binding
            if target is None or key in visited:
                return None
            visited.add(key)
            name = target


def import_binding(name, aliases):
    for bindings in aliases.maps if isinstance(aliases, ChainMap) else (aliases,):
        prefix, suffix = name, ""
        while prefix:
            if prefix in bindings:
                target = bindings[prefix]
                return (qualify(target, suffix) if suffix else target), prefix
            prefix, _, part = prefix.rpartition(".")
            suffix = qualify(part, suffix) if suffix else part
    return None, None


@dataclass
class Scope:
    index: Index
    module: Module
    aliases: ChainMap
    owner: str = ""
    parameters: frozenset = frozenset()

    def canonical_name(self, node):
        name = reference_name(node)
        imported, _ = import_binding(name, self.aliases)
        return imported or name

    def special_name(self, node):
        return self.canonical_name(node).rpartition(".")[2]

    def class_id(self, name):
        if not name:
            return None
        head, _, tail = name.partition(".")
        if tail and head in {"self", "cls"} and self.owner:
            return self.index.class_id(qualify(self.owner, tail))
        if head in self.parameters:
            return None
        if self.owner and qualify(self.owner, name) in self.index.classes:
            return qualify(self.owner, name)
        imported, _ = import_binding(name, self.aliases)
        if imported:
            return self.index.class_id(imported)
        return self.index.class_id(qualify(self.module.id, name))


def unquote(node):
    while isinstance(node, ast.Constant) and isinstance(node.value, str):
        try:
            node = ast.parse(node.value.strip(), mode="eval").body
        except SyntaxError:
            return None
    return node


def subscript_args(node):
    return node.slice.elts if isinstance(node.slice, ast.Tuple) else [node.slice]


def union_items(node, scope):
    node = unquote(node)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        yield from union_items(node.left, scope)
        yield from union_items(node.right, scope)
    elif isinstance(node, ast.Subscript) and scope.special_name(node.value) in {"Union", "Optional"}:
        if scope.special_name(node.value) == "Optional":
            yield ast.Constant(value=None)
        for item in subscript_args(node):
            yield from union_items(item, scope)
    else:
        yield node


def annotation_references(node, scope, *, field=False, multiplicity="1"):
    items = list(union_items(node, scope))
    if multiplicity == "1" and any(isinstance(item, ast.Constant) and item.value is None for item in items):
        multiplicity = "0..1"
    for item in items:
        if isinstance(item, ast.Subscript):
            wrapper = scope.special_name(item.value)
            args = subscript_args(item)
            if wrapper == "Literal":
                continue
            if wrapper in TYPE_WRAPPERS:
                args = args[:1]
            elif field:
                if wrapper in COLLECTIONS:
                    args = args[:1] if wrapper not in {"tuple", "Tuple"} else args
                    for arg in args:
                        yield from annotation_references(arg, scope, field=True, multiplicity="0..*")
                    continue
                if wrapper in MAPPINGS:
                    for arg in args[1:2]:
                        yield from annotation_references(arg, scope, field=True, multiplicity="0..*")
                    continue
                args = [item.value]
            else:
                args = [item.value, *args]
            for arg in args:
                yield from annotation_references(arg, scope, field=field, multiplicity=multiplicity)
        elif isinstance(item, (ast.Tuple, ast.List)) and not field:
            for arg in item.elts:
                yield from annotation_references(arg, scope)
        else:
            target = scope.class_id(dotted_name(item))
            if target:
                yield target, multiplicity


def annotation_text(node):
    return ast.unparse(node) if node is not None else ""


def member(kind, name, line, type_text="", *, static=False, abstract=False):
    result = {"kind": kind, "name": name, "line": line, "visibility": "+"}
    if kind != "literal":
        result["type"] = type_text
    if name != "__init__" and len(name) > 4 and name.startswith("__") and name.endswith("__"):
        result["hidden"] = "dunder"
    elif name != "__init__" and name.startswith("_"):
        result.update(visibility="-", hidden="private")
    if static:
        result["static"] = True
    if abstract:
        result["abstract"] = True
    return result


def parameters(method):
    args = method.args
    return [arg for arg in (*args.posonlyargs, *args.args, args.vararg, *args.kwonlyargs, args.kwarg)
            if arg is not None]


def method_scope(method, module_scope, body, owner=""):
    index = module_scope.index
    module = module_scope.module
    aliases = index.bind(module, body)
    parameter_names = frozenset(arg.arg for arg in parameters(method) if arg.arg not in aliases)
    return Scope(index, module, module_scope.aliases.new_child(aliases), owner, parameter_names)


def method_member(method, scope, *, static=False):
    decorators = {scope.special_name(node) for node in method.decorator_list}
    result = member("method", method.name, method.lineno, annotation_text(method.returns),
                    static=static or bool(decorators & {"staticmethod", "classmethod"}),
                    abstract="abstractmethod" in decorators)
    result["params"] = [{"name": arg.arg, "type": annotation_text(arg.annotation)}
                        for arg in parameters(method) if arg.arg not in {"self", "cls"}]
    return result


def relationship(kind, source, target, line, **attributes):
    return {"kind": kind, "from": source, "to": target, "line": line, **attributes}


def expression_references(nodes, scope):
    stack = list(reversed(nodes))
    while stack:
        node = stack.pop()
        if isinstance(node, DEFINITIONS):
            continue
        if isinstance(node, ast.AnnAssign):
            for target, _ in annotation_references(node.annotation, scope):
                yield target, node.lineno
            children = [node.target] if node.value is None else [node.target, node.value]
        else:
            children = list(ast.iter_child_nodes(node))
        if isinstance(node, (ast.Name, ast.Attribute)) and isinstance(node.ctx, ast.Load):
            name = dotted_name(node)
            if name:
                while name:
                    target = scope.class_id(name)
                    if target:
                        yield target, node.lineno
                        break
                    name = name.rpartition(".")[0]
                continue
        stack.extend(reversed(children))


def method_relationships(owner, method, scope, body_scope):
    for annotation in [*(arg.annotation for arg in parameters(method)), method.returns]:
        for target, _ in annotation_references(annotation, scope):
            yield relationship("dependency", owner, target, annotation.lineno)
    defaults = [*method.args.defaults, *(value for value in method.args.kw_defaults if value is not None)]
    for target, line in expression_references(defaults, scope):
        yield relationship("dependency", owner, target, line)
    for target, line in expression_references(method.body, body_scope):
        yield relationship("dependency", owner, target, line)


@dataclass
class Field:
    name: str
    line: int
    scope: Scope
    annotation: ast.expr | None = None
    value: ast.expr | None = None
    static: bool = False
    abstract: bool = False

    def constructor(self):
        if not isinstance(self.value, ast.Call):
            return ""
        name = reference_name(self.value.func)
        if self.scope.class_id(name):
            return name
        if self.scope.special_name(self.value.func) == "field":
            for keyword in self.value.keywords:
                if keyword.arg == "default_factory":
                    return dotted_name(keyword.value)
            return ""
        terminal = self.scope.special_name(self.value.func).lstrip("_")
        if terminal[:1].isupper() or isinstance(getattr(builtins, terminal, None), type):
            return name
        return ""


def assignments(node):
    if isinstance(node, ast.AnnAssign):
        yield node.target, node.annotation, node.value
    elif isinstance(node, ast.Assign):
        for target in node.targets:
            yield from unpack_assignment(target, node.value)


def unpack_assignment(target, value):
    if isinstance(target, (ast.Tuple, ast.List)):
        if isinstance(value, (ast.Tuple, ast.List)) and len(target.elts) == len(value.elts):
            for item, item_value in zip(target.elts, value.elts):
                yield from unpack_assignment(item, item_value)
        else:
            for item in target.elts:
                yield from unpack_assignment(item, None)
    elif isinstance(target, ast.Starred):
        yield target.value, None, None
    else:
        yield target, None, value


def class_var(annotation, scope):
    annotation = unquote(annotation)
    return scope.special_name(annotation) == "ClassVar"


def field_facts(owner, declaration, instance, *, composition=True):
    annotation = declaration.annotation
    annotation_scope = declaration.scope
    if annotation is None and instance:
        annotation, annotation_scope = instance.annotation, instance.scope

    constructor = declaration.constructor()
    initializer = declaration
    target = declaration.scope.class_id(constructor)
    if not target and instance:
        instance_constructor = instance.constructor()
        instance_target = instance.scope.class_id(instance_constructor)
        if instance_target or not constructor:
            constructor, initializer, target = instance_constructor, instance, instance_target

    type_text = annotation_text(annotation) or constructor
    fact = member("field", declaration.name, declaration.line, type_text,
                  static=declaration.static, abstract=declaration.abstract)
    if target and composition:
        return fact, [relationship("composition", owner, target, initializer.line, label=declaration.name)]
    edges = []
    for target, multiplicity in annotation_references(annotation, annotation_scope, field=True):
        kind = "aggregation" if multiplicity == "0..*" else "association"
        edges.append(relationship(kind, owner, target, declaration.line, label=declaration.name,
                                  multiplicity=multiplicity))
    return fact, edges


def classifier_kind(node, scope):
    bases = {scope.special_name(base) for base in node.bases if not scope.class_id(reference_name(base))}
    kind = "class"
    if bases & ENUM_BASES:
        kind = "enum"
    elif "Protocol" in bases:
        kind = "interface"
    stereotypes = []
    decorators = [scope.canonical_name(decorator) for decorator in node.decorator_list]
    if any(name.rpartition(".")[2] == "dataclass" for name in decorators):
        stereotypes.append("dataclass")
    if bases & {"NamedTuple", "namedtuple"}:
        stereotypes.append("namedtuple")
    if "TypedDict" in bases:
        stereotypes.append("typeddict")
    if "BaseModel" in bases:
        stereotypes.append("pydantic")
    if "attr.s" in decorators or any(name.rpartition(".")[2] in {"define", "frozen"} for name in decorators):
        stereotypes.append("attrs")
    abstract = bool(bases & {"ABC", "ABCMeta"}) or any(
        keyword.arg == "metaclass" and scope.special_name(keyword.value) == "ABCMeta"
        for keyword in node.keywords
    )
    return kind, stereotypes, abstract


def classifier_members(owner, node, scope, module_scope, element):
    members, edges = [], []
    declared, instances = {}, {}
    data_class = "dataclass" in element.get("stereotypes", ())
    for statement in scope_statements(node.body):
        if isinstance(statement, METHODS):
            body = list(scope_statements(statement.body))
            body_scope = method_scope(statement, module_scope, body, owner)
            edges.extend(method_relationships(owner, statement, scope, body_scope))
            decorators = {scope.special_name(item) for item in statement.decorator_list}
            if "abstractmethod" in decorators:
                element["abstract"] = True
            if "property" in decorators:
                declared[statement.name] = Field(statement.name, statement.lineno, scope, statement.returns,
                                                 abstract="abstractmethod" in decorators)
            elif not any(dotted_name(item) in {f"{statement.name}.setter", f"{statement.name}.deleter"}
                         for item in statement.decorator_list):
                members.append(method_member(statement, scope))
            for item in body:
                for target, annotation, value in assignments(item):
                    if isinstance(target, ast.Attribute) and dotted_name(target.value) == "self":
                        instances.setdefault(target.attr, Field(target.attr, item.lineno, body_scope,
                                                                annotation, value))
        else:
            for target, annotation, value in assignments(statement):
                if not isinstance(target, ast.Name):
                    continue
                is_class_var = class_var(annotation, scope)
                if (element["kind"] == "enum" and value is not None and not is_class_var
                        and not (target.id.startswith("_") and target.id.endswith("_"))):
                    members.append(member("literal", target.id, statement.lineno))
                else:
                    static = is_class_var or (annotation is None and not data_class)
                    field = declared.get(target.id)
                    if field is None or (field.annotation is None and annotation is not None):
                        declared[target.id] = Field(target.id, statement.lineno, scope, annotation,
                                                    value if value is not None or field is None else field.value,
                                                    static)

    for name, declaration in declared.items():
        fact, relationships = field_facts(owner, declaration, instances.pop(name, None))
        members.append(fact)
        edges.extend(relationships)
    for instance in instances.values():
        fact, relationships = field_facts(owner, instance, None)
        members.append(fact)
        edges.extend(relationships)
    return sorted(members, key=lambda item: item["line"]), edges


def element(kind, name, parent, path, line=None):
    result = {"kind": kind, "name": name, "parent": parent, "language": "python", "path": path}
    if line is not None:
        result["line"] = line
    return result


def add_packages(module, elements):
    for length, part in enumerate(module.package, start=1):
        package = ".".join(module.package[:length])
        parent = ".".join(module.package[:length - 1]) or None
        elements.setdefault(package, element("package", part, parent, "/".join(module.package[:length])))
    name = module.parts[-1] if module.parts else "__init__"
    if not module.initializer:
        parent = ".".join(module.package) or None
        elements[module.id] = element("package", name, parent, module.path, 1)
    elif not module.parts:
        elements[module.id] = element("package", name, None, ".")
    doc = first_sentence(module.tree)
    if doc:
        elements[module.id]["doc"] = doc


def class_definitions(statements, prefix=""):
    for statement in scope_statements(statements):
        if isinstance(statement, ast.ClassDef):
            name = qualify(prefix, statement.name)
            yield name, statement
            yield from class_definitions(statement.body, name)


def utility_facts(module, scope):
    owner = f"{module.id}:utility"
    members, edges = [], []
    fields = set()
    for statement in scope_statements(module.tree.body):
        if isinstance(statement, METHODS):
            members.append(method_member(statement, scope, static=True))
            body_scope = method_scope(statement, scope, scope_statements(statement.body))
            edges.extend(method_relationships(owner, statement, scope, body_scope))
        else:
            for target, annotation, value in assignments(statement):
                if isinstance(target, ast.Name) and target.id not in fields:
                    fields.add(target.id)
                    declaration = Field(target.id, statement.lineno, scope, annotation, value, static=True)
                    fact, relationships = field_facts(owner, declaration, None, composition=False)
                    members.append(fact)
                    edges.extend(relationships)
    return members, edges


def extract(root: Path, files: list[SourceFile]) -> dict:
    elements, relationships, warnings = {}, [], []
    modules, classes = [], {}
    for source in files:
        try:
            tree = ast.parse((root / source.path).read_bytes(), filename=source.path)
        except SyntaxError as error:
            warnings.append(f"{source.path}:{error.lineno or 1}: {error.msg}")
            continue
        except (ValueError, MemoryError, RecursionError) as error:
            warnings.append(f"{source.path}: cannot parse: {error}")
            continue
        except OSError as error:
            warnings.append(f"{source.path}: {error.strerror}")
            continue
        path = Path(source.path)
        initializer = path.name == "__init__.py"
        parts = path.parent.parts if initializer else path.with_suffix("").parts
        module = Module(source.path, parts, initializer, tree)
        modules.append(module)
        add_packages(module, elements)
        for name, node in class_definitions(tree.body):
            classes[qualify(module.id, name)] = (module, name, node)

    index = Index(set(elements), set(classes))
    for module in modules:
        index.imports[module.id] = index.bind(module, scope_statements(module.tree.body))

    scopes = {module.id: Scope(index, module, ChainMap(index.imports[module.id])) for module in modules}
    bases, subclasses, enums = {}, {}, []
    for owner, (module, name, node) in classes.items():
        enclosing = owner.rpartition(".")[0] if "." in name else ""
        scope = Scope(index, module, scopes[module.id].aliases, enclosing)
        kind, stereotypes, abstract = classifier_kind(node, scope)
        bases[owner] = []
        for base in node.bases:
            target = scope.class_id(reference_name(base))
            if target:
                bases[owner].append((target, base.lineno))
                subclasses.setdefault(target, []).append(owner)
        if kind == "enum":
            enums.append(owner)
        fact = element(kind, name, module.id, module.path, node.lineno)
        if node.name.startswith("_"):
            fact["hidden"] = "private"
        if stereotypes:
            fact["stereotypes"] = stereotypes
        if abstract:
            fact["abstract"] = True
        doc = first_sentence(node)
        if doc:
            fact["doc"] = doc
        elements[owner] = fact

    while enums:
        for child in subclasses.get(enums.pop(), ()):
            if elements[child]["kind"] == "class":
                elements[child]["kind"] = "enum"
                enums.append(child)

    for owner, (module, _, node) in classes.items():
        fact = elements[owner]
        module_scope = scopes[module.id]
        for target, line in bases[owner]:
            kind = "realization" if fact["kind"] == "class" and elements[target]["kind"] == "interface" else "generalization"
            relationships.append(relationship(kind, owner, target, line))
        aliases = module_scope.aliases.new_child(index.bind(module, scope_statements(node.body)))
        scope = Scope(index, module, aliases, owner)
        fact["members"], edges = classifier_members(owner, node, scope, module_scope, fact)
        relationships.extend(edges)

    for module in modules:
        members, edges = utility_facts(module, scopes[module.id])
        if members:
            fact = element("utility", elements[module.id]["name"], module.id, module.path, 1)
            fact["members"] = members
            elements[f"{module.id}:utility"] = fact
            relationships.extend(edges)
        for node in ast.walk(module.tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for _, _, target in index.import_names(module, node):
                    if target and target != module.id:
                        relationships.append(relationship("dependency", module.id, target, node.lineno))
    return {"elements": elements, "relationships": relationships, "warnings": warnings}
