const path = require("node:path");
const { ts } = require("./parsers.cjs");
const { createProgram } = require("./program.cjs");
const { position, nameOf, modifiers, docOf, unwrap, valueSymbol, staticPropertyName, bindings, visit,
  moduleSpecifier } = require("./syntax.cjs");
const { vueMembers, vueImportDependencies } = require("./vue.cjs");
const { propertyAccess, commonJsExports, namedExport, exportedDeclarations } = require("./exports.cjs");

const collectionValues = new Map([
  ["Array", 0], ["ReadonlyArray", 0], ["Set", 0], ["ReadonlySet", 0],
  ["Map", 1], ["ReadonlyMap", 1], ["Record", 1],
]);
const nullish = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
const structuralDepthLimit = 256;
const fieldAssignments = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

function qualify(parent, name) {
  return parent && parent !== "." ? `${parent}.${modelText(name)}` : modelText(name);
}

function modelText(value) {
  return value.replace(/[\uD800-\uDFFF]/gu, character => `\\u${character.charCodeAt(0).toString(16)}`);
}

function declarationKind(node) {
  if (ts.isClassLike(node)) return "class";
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return "interface";
  if (ts.isEnumDeclaration(node)) return "enum";
}

function visibility(node) {
  const flags = modifiers(node);
  if ((node.name && ts.isPrivateIdentifier(node.name)) || flags & ts.ModifierFlags.Private) return "-";
  if (flags & ts.ModifierFlags.Protected) return "#";
  return "+";
}

function assignedField(checker, node) {
  if (!ts.isBinaryExpression(node) || !fieldAssignments.has(node.operatorToken.kind)) return;
  const left = unwrap(node.left);
  if (!(ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))
      || unwrap(left.expression).kind !== ts.SyntaxKind.ThisKeyword) return;
  return ts.isPropertyAccessExpression(left) ? left.name.text : staticPropertyName(checker, left.argumentExpression);
}

class Facts {
  constructor({ program, importedFile, files }) {
    this.program = program;
    this.importedFile = importedFile;
    this.sources = new Set(files.map(file => file.source));
    this.checker = program.getTypeChecker();
    this.elements = Object.create(null);
    this.usedIds = new Set();
    this.reservedIds = new Set();
    this.declarations = new Map();
    this.composables = new Map();
    this.vueSymbols = new Map();
    this.relationships = new Map();
    this.requireModules = new WeakMap();
    this.importFiles = new WeakMap();
    this.typeTargetCache = new WeakMap();
  }

  element(id, kind, name, parent, file, line) {
    return this.elements[id] ??= {
      kind, name, parent, language: file.language, path: file.path, ...(line && { line }),
    };
  }

  packageFiles(files) {
    const directories = new Map();
    for (const file of files) {
      const parts = file.path.split("/");
      parts[parts.length - 1] = path.posix.parse(parts[parts.length - 1]).name;
      while (parts.length) {
        this.reservedIds.add(modelText(parts.join(".")));
        parts.pop();
      }
    }
    for (const file of files) {
      const parts = file.path.split("/");
      const basename = parts.pop();
      const stem = path.posix.parse(basename).name;
      let parent = null;
      for (let index = 0; index < parts.length; index++) {
        const directory = parts.slice(0, index + 1).join("/");
        let id = directories.get(directory);
        if (!id) {
          id = this.claimId(qualify(parent, parts[index]));
          directories.set(directory, id);
          this.element(id, "package", parts[index], parent, { ...file, path: directory });
        }
        parent = id;
      }
      file.index = /^index\.[jt]s$/i.test(basename);
      if (!parent && (file.index || file.language === "vue")) {
        parent = directories.get(".") ?? this.claimId(".");
        directories.set(".", parent);
        this.element(parent, "package", ".", null, { ...file, path: "." });
      }
      file.module = file.index ? parent : qualify(parent, stem);
      file.package = file.language === "vue" ? parent : file.module;
      file.parent = parent;
      file.name = stem;
      this.reservedIds.add(file.module);
    }
    for (const file of files) {
      if (file.language !== "vue") continue;
      file.module = this.claimId(file.module, path.posix.extname(file.path));
      const element = this.element(file.module, "class", file.name, file.parent, file, 1);
      element.stereotypes = ["vue"];
      const symbol = this.checker.getSymbolAtLocation(file.source);
      if (!symbol) continue;
      this.vueSymbols.set(symbol, file.module);
      const defaultExport = this.checker.getExportsOfModule(symbol).find(item => item.name === "default");
      if (!defaultExport) continue;
      file.defaultExport = defaultExport;
      this.vueSymbols.set(defaultExport, file.module);
      const target = this.unalias(defaultExport);
      if (target.declarations?.some(declaration => declaration.getSourceFile() === file.source)) {
        this.vueSymbols.set(target, file.module);
      }
    }
    for (const file of files) {
      if (file.language === "vue" || file.index) continue;
      file.module = file.package = this.claimId(file.module, path.posix.extname(file.path));
      this.element(file.module, "package", file.name, file.parent, file, 1);
    }
    const indexes = files.filter(file => file.index);
    const seen = new Set();
    for (const file of indexes.filter(file => file.language === "typescript")
      .concat(indexes.filter(file => file.language === "javascript"))) {
      if (seen.has(file.package)) file.module = this.claimId(qualify(file.package, path.posix.basename(file.path)));
      seen.add(file.package);
    }
    for (const file of files) this.reservedIds.add(`${file.module}:utility`);
  }

  claimId(base, extension = "") {
    let id = base;
    if (this.usedIds.has(id)) {
      const alternate = base + extension;
      id = alternate;
      for (let suffix = 2; this.usedIds.has(id) || this.reservedIds.has(id); suffix++) {
        id = `${alternate}~${suffix}`;
      }
    }
    this.usedIds.add(id);
    return id;
  }

  unalias(symbol) {
    return symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
  }

  target(symbol, includeComposables = false) {
    if (!symbol) return;
    const target = this.unalias(symbol);
    const component = this.vueSymbols.get(symbol) ?? this.vueSymbols.get(target);
    if (component) return component;
    for (const declaration of target.declarations ?? []) {
      const id = this.declarations.get(declaration) ?? (includeComposables && this.composables.get(declaration));
      if (id) return id;
    }
  }

  add(kind, from, to, line, label, multiplicity, sourcePath) {
    if (!from || !to || from === to) return;
    const key = JSON.stringify([from, to, kind, label]);
    const existing = this.relationships.get(key);
    if (existing && existing.line <= line) return;
    this.relationships.set(key, {
      kind, from, to, line, ...(label && { label }), ...(multiplicity && { multiplicity }),
      ...(sourcePath && sourcePath !== this.elements[from]?.path && { path: sourcePath }),
    });
  }

  results(warnings) {
    const values = [...this.relationships.values()];
    const stronger = new Set(values.filter(link => link.kind !== "dependency").map(link => JSON.stringify([link.from, link.to])));
    return {
      elements: this.elements,
      relationships: values.filter(link => link.kind !== "dependency" || !stronger.has(JSON.stringify([link.from, link.to]))),
      warnings,
    };
  }

  line(file, node) {
    return file.line(position(node));
  }

  aliasIsObject(type) {
    if (type.isUnionOrIntersection()) return type.types.every(item => this.aliasIsObject(item));
    return Boolean(type.flags & ts.TypeFlags.Object) && !this.checker.isArrayType(type)
      && !this.checker.isTupleType(type);
  }

  classifiers(file) {
    const declarations = [];
    file.commonJsExports = commonJsExports(this, file);
    const exportNames = new Map();
    for (const [name, symbol] of file.commonJsExports) {
      for (const declaration of symbol?.declarations ?? []) {
        if (ts.isClassExpression(declaration) && !exportNames.has(declaration)) exportNames.set(declaration, name);
      }
    }
    const collect = (node, scope) => {
      const kind = declarationKind(node);
      if (kind && (!ts.isTypeAliasDeclaration(node) || this.aliasIsObject(this.checker.getTypeFromTypeNode(node.type)))) {
        let expression = node;
        while (expression.parent?.expression === expression && unwrap(expression.parent) === node) {
          expression = expression.parent;
        }
        const owner = ts.isClassExpression(node) ? expression.parent : undefined;
        const binding = owner && ts.isVariableDeclaration(owner) ? owner : undefined;
        const isDefault = modifiers(node) & ts.ModifierFlags.Default
          || owner && ts.isExportAssignment(owner);
        const name = nameOf(binding?.name ?? node.name) ?? (isDefault ? "default" : exportNames.get(node));
        if (name) {
          const qualified = qualify(scope, name);
          const base = qualify(file.module, qualified);
          this.reservedIds.add(base);
          declarations.push({ node, binding, owner, kind, qualified, base });
          scope = qualified;
        }
      } else if (ts.isModuleDeclaration(node)) {
        scope = qualify(scope, nameOf(node.name));
      }
      ts.forEachChild(node, child => collect(child, scope));
    };
    collect(file.source, null);
    return declarations;
  }

  registerClassifiers(file, declarations) {
    const merged = new Map();
    for (const classifier of declarations) {
      const { node, binding, owner, kind, qualified, base } = classifier;
      const symbol = (ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node))
        && this.checker.getSymbolAtLocation(node.name);
      const key = symbol ? (merged.get(symbol) ?? new Map()) : undefined;
      if (symbol) merged.set(symbol, key);
      const id = key?.get(kind) ?? this.claimId(base);
      key?.set(kind, id);
      classifier.id = id;
      const element = this.element(id, kind, qualified, file.package, file, this.line(file, node));
      this.declarations.set(node, id);
      if (binding) this.declarations.set(binding, id);
      if (owner && ts.isExportAssignment(owner)) this.declarations.set(owner, id);
      if (modifiers(node) & ts.ModifierFlags.Abstract) element.abstract = true;
      if (ts.isTypeAliasDeclaration(node)) element.stereotypes = ["type"];
      const doc = docOf(node) ?? (binding && docOf(binding));
      if (doc) element.doc ??= doc;
    }
  }
  typeText(type, location) {
    return this.checker.typeToString(type, location);
  }

  parameter(parameter) {
    const type = this.checker.getTypeAtLocation(parameter);
    const annotated = ts.getEffectiveTypeAnnotationNode(parameter);
    return { name: nameOf(parameter.name), type: annotated?.getText() ?? this.typeText(type, parameter) };
  }

  matchingAnnotation(type, annotation, optional = false) {
    if (!annotation) return;
    const written = this.checker.getTypeFromTypeNode(annotation);
    if (written === type) return annotation;
    if (!type.isUnionOrIntersection()) return;
    const annotated = written.isUnionOrIntersection() && written.flags === type.flags ? written.types : [written];
    const present = optional && type.isUnion() && !annotated.some(item => item.flags & ts.TypeFlags.Undefined)
      ? type.types.filter(item => !(item.flags & ts.TypeFlags.Undefined)) : type.types;
    if (present.length === annotated.length && present.every(item => annotated.includes(item))) return annotation;
  }

  signatureMembers(signature, location, skip = 0) {
    const params = signature.getParameters().slice(skip).map(parameter => {
      const declaration = parameter.valueDeclaration;
      const type = this.checker.getTypeOfSymbolAtLocation(parameter, location);
      const annotation = declaration && this.matchingAnnotation(type, ts.getEffectiveTypeAnnotationNode(declaration),
        Boolean(parameter.flags & ts.SymbolFlags.Optional || declaration.questionToken));
      return { name: nameOf(declaration?.name) ?? parameter.name, type: annotation?.getText() ?? this.typeText(type, location) };
    });
    const result = signature.getReturnType();
    const annotation = signature.declaration && this.matchingAnnotation(result, ts.getEffectiveReturnTypeNode(signature.declaration));
    return { params, type: annotation?.getText() ?? this.typeText(result, location) };
  }

  member(file, node, details) {
    const name = details.name ?? nameOf(node.name) ?? "constructor";
    const access = details.visibility ?? visibility(node);
    const flags = modifiers(node);
    const row = { kind: details.kind, name, visibility: access, line: this.line(file, details.location ?? node) };
    if (access === "-") row.hidden = "private";
    if (details.static || flags & ts.ModifierFlags.Static) row.static = true;
    if (flags & ts.ModifierFlags.Abstract) row.abstract = true;
    if (details.kind === "method") {
      row.params = details.params ?? node.parameters.map(parameter => this.parameter(parameter));
      const signature = this.checker.getSignatureFromDeclaration(node);
      const annotated = ts.getEffectiveReturnTypeNode(node);
      if (details.type !== undefined) row.type = details.type;
      else if (annotated) row.type = annotated.getText();
      else if (signature) row.type = this.typeText(signature.getReturnType(), node);
    }
    if (details.kind === "field") {
      const location = ts.isSetAccessorDeclaration(node) ? node.parameters[0] : node;
      const annotated = location && ts.getEffectiveTypeAnnotationNode(location);
      const type = details.semanticType ?? this.checker.getTypeAtLocation(location ?? node);
      row.type = details.type ?? annotated?.getText() ?? this.typeText(type, node);
    }
    return row;
  }

  typeArguments(type) {
    return [
      ...(type.aliasTypeArguments ?? []),
      ...(type.objectFlags & ts.ObjectFlags.Reference ? this.checker.getTypeArguments(type) : []),
    ];
  }

  *signatureTypes(signature) {
    if (signature.thisParameter) yield this.checker.getTypeOfSymbol(signature.thisParameter);
    for (const parameter of signature.getParameters()) {
      yield this.checker.getTypeOfSymbol(parameter);
    }
    for (const parameter of signature.getTypeParameters() ?? []) {
      yield this.checker.getBaseConstraintOfType(parameter);
    }
    yield signature.getReturnType();
    yield this.checker.getTypePredicateOfSignature(signature)?.type;
  }

  *structuralTypes(type) {
    const symbol = type.getSymbol();
    if (!(type.flags & ts.TypeFlags.Object)
        || !(type.objectFlags & (ts.ObjectFlags.Anonymous | ts.ObjectFlags.Mapped))
        || symbol?.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum | ts.SymbolFlags.Module)) return;
    const inRepo = declaration => declaration && this.sources.has(declaration.getSourceFile());
    const origins = symbol?.declarations ?? (type.declaration ? [type.declaration] : type.aliasSymbol?.declarations);
    const local = origins?.some(inRepo);
    if (origins?.length && !local) return;
    for (const property of type.getProperties()) {
      if (local || property.declarations?.some(inRepo)) yield this.checker.getTypeOfSymbol(property);
    }
    for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
      if (local || inRepo(signature.declaration)) yield* this.signatureTypes(signature);
    }
    for (const index of this.checker.getIndexInfosOfType(type)) {
      if (local || inRepo(index.declaration)) yield index.type;
    }
  }

  typeTargets(type) {
    if (!type) return [];
    const cached = this.typeTargetCache.get(type);
    if (cached) return cached;
    const targets = new Set();
    const seen = new Set([type]);
    const pending = [{ type, depth: 0 }];
    const enqueue = (item, depth) => {
      if (item && !seen.has(item)) {
        seen.add(item);
        pending.push({ type: item, depth });
      }
    };
    for (let index = 0; index < pending.length; index++) {
      const { type: current, depth } = pending[index];
      const alias = this.target(current.aliasSymbol);
      const symbol = this.target(current.getSymbol());
      if (alias) targets.add(alias);
      if (symbol) targets.add(symbol);
      for (const item of current.types ?? []) enqueue(item, depth);
      for (const item of this.typeArguments(current)) enqueue(item, depth);
      if (depth < structuralDepthLimit && !alias && !symbol) {
        for (const item of this.structuralTypes(current)) enqueue(item, depth + 1);
      }
    }
    this.typeTargetCache.set(type, targets);
    return targets;
  }

  typeDependencies(id, line, types) {
    for (const type of types) {
      for (const target of this.typeTargets(type)) this.add("dependency", id, target, line);
    }
  }

  referencedSymbol(node) {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      return valueSymbol(this.checker, node);
    }
    let receiver, key;
    if (ts.isElementAccessExpression(node)) {
      receiver = node.expression;
      key = staticPropertyName(this.checker, node.argumentExpression);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken) {
      receiver = node.parent;
      key = this.propertyName(node.propertyName ?? node.name);
    } else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
        && ts.isObjectLiteralExpression(node.parent)) {
      const assignment = node.parent.parent;
      if (ts.isBinaryExpression(assignment) && assignment.left === node.parent
          && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        receiver = assignment.right;
        key = this.propertyName(node.name);
      }
    }
    if (key !== undefined) return this.checker.getTypeAtLocation(receiver).getProperty(key);
  }

  propertyName(node) {
    if (node && ts.isComputedPropertyName(node)) {
      return staticPropertyName(this.checker, node.expression);
    }
    return nameOf(node);
  }

  referenceTarget(node, includeComposables = false, typeAt) {
    const symbol = typeAt ? this.checker.getSymbolAtLocation(node) : this.referencedSymbol(node);
    return this.target(symbol, includeComposables)
      ?? (typeAt && this.target(this.checker.getTypeAtLocation(typeAt).getSymbol(), includeComposables))
      ?? this.target(this.bindingExportSymbol(node), includeComposables);
  }

  dependencies(file, id, node) {
    visit(node, child => {
      if (child !== node && this.declarations.has(child) && this.declarations.get(child) !== id) return false;
      const line = this.line(file, child);
      this.add("dependency", id, this.referenceTarget(child, file.language === "vue"), line);
      if (ts.isFunctionLike(child)) {
        const signature = this.checker.getSignatureFromDeclaration(child);
        this.typeDependencies(id, line, [signature?.getReturnType()]);
      }
      if (ts.isTypeNode(child) || ts.isExpressionNode(child) || ts.isParameter(child)
          || ts.isPropertyDeclaration(child) || ts.isVariableDeclaration(child) || ts.isBindingElement(child)) {
        this.typeDependencies(id, line, [this.checker.getTypeAtLocation(child)]);
      }
    });
  }

  collectionItem(type) {
    for (const symbol of [type.aliasSymbol, type.getSymbol()]) {
      const index = collectionValues.get(symbol?.name);
      if (index !== undefined && symbol.declarations?.some(node => this.program.isSourceFileDefaultLibrary(node.getSourceFile()))) {
        const args = symbol === type.aliasSymbol ? type.aliasTypeArguments : this.checker.getTypeArguments(type);
        if (args?.[index]) return { type: args[index], index, symbol };
      }
    }
  }

  declaredTarget(annotation) {
    while (annotation && ts.isParenthesizedTypeNode(annotation)) annotation = annotation.type;
    if (annotation && ts.isTypeReferenceNode(annotation)) {
      return this.target(this.checker.getSymbolAtLocation(annotation.typeName));
    }
    if (annotation && ts.isImportTypeNode(annotation) && annotation.qualifier) {
      return this.target(this.checker.getSymbolAtLocation(annotation.qualifier));
    }
  }

  fieldChoices(type, annotation) {
    while (annotation && ts.isParenthesizedTypeNode(annotation)) annotation = annotation.type;
    if (annotation && ts.isUnionTypeNode(annotation)) {
      const written = annotation.types.flatMap(node => this.fieldChoices(this.checker.getTypeFromTypeNode(node), node));
      if (this.checker.getTypeFromTypeNode(annotation) === type) return written;
      return (type.isUnion() ? type.types : [type]).flatMap(item => {
        const matches = written.filter(choice => choice.type === item);
        return matches.length ? matches : [{ type: item }];
      });
    }
    if (type.isUnion() && !this.declaredTarget(annotation)) {
      return type.types.map(item => ({ type: item, annotation }));
    }
    return [{ type, annotation }];
  }

  localBinding(node) {
    if (!node || !ts.isIdentifier(node)) return;
    const symbol = valueSymbol(this.checker, node);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.find(ts.isBindingElement);
    if (declaration?.getSourceFile() === node.getSourceFile()) return declaration;
  }

  resolvedImport(literal) {
    if (!this.importFiles.has(literal)) this.importFiles.set(literal, this.importedFile(literal));
    return this.importFiles.get(literal);
  }

  importedBindingSymbol(expression) {
    const node = unwrap(expression);
    if (!node || !ts.isIdentifier(node)) return;
    const binding = valueSymbol(this.checker, node)?.declarations?.find(declaration =>
      ts.isImportClause(declaration) || ts.isImportSpecifier(declaration));
    if (!binding) return;
    const named = ts.isImportSpecifier(binding);
    const clause = named ? binding.parent.parent : binding;
    const file = this.resolvedImport(clause.parent.moduleSpecifier);
    const name = named ? (binding.propertyName ?? binding.name).text : "default";
    return name === "default" ? file?.commonJsDirectExport : file?.commonJsNamedExports?.get(name);
  }

  bindingExportSymbol(expression) {
    return this.importedBindingSymbol(expression) ?? this.requiredBindingSymbol(expression);
  }

  requiredModule(expression) {
    const call = unwrap(expression);
    if (!call || !ts.isCallExpression(call)) return;
    if (!this.requireModules.has(call)) {
      const loader = unwrap(call.expression);
      if (!ts.isIdentifier(loader) || loader.text !== "require") return;
      const literal = moduleSpecifier(call, this.checker);
      this.requireModules.set(call, literal && this.resolvedImport(literal));
    }
    return this.requireModules.get(call);
  }

  requiredNamespace(expression) {
    const value = unwrap(expression);
    const binding = this.localBinding(value);
    return this.requiredModule(binding && ts.isVariableDeclaration(binding) ? binding.initializer : value);
  }

  requiredBindingSymbol(expression) {
    const node = unwrap(expression);
    if (!node) return;
    const binding = ts.isBindingElement(node) ? node : this.localBinding(node);
    let access;
    if (binding && ts.isBindingElement(binding)) {
      if (binding.dotDotDotToken || !ts.isObjectBindingPattern(binding.parent)
          || !ts.isVariableDeclaration(binding.parent.parent) || !binding.parent.parent.initializer) return;
      access = {
        name: this.propertyName(binding.propertyName ?? binding.name), receiver: binding.parent.parent.initializer,
      };
    } else {
      const value = binding && ts.isVariableDeclaration(binding) ? binding.initializer : node;
      const imported = this.requiredModule(value);
      if (imported) return imported.commonJsDirectExport;
      access = propertyAccess(this.checker, value);
    }
    if (access?.name === undefined) return;
    const imported = this.requiredNamespace(access.receiver);
    if (imported) return namedExport(this, imported, access.name);
  }

  fieldLinks(file, id, row, type, { optional = false, creations = [], annotation } = {}) {
    const owners = new Set();
    for (const creation of creations) {
      const expression = ts.isBinaryExpression(creation) ? unwrap(creation.right) : creation;
      const target = this.referenceTarget(expression.expression, false, expression);
      if (target) {
        owners.add(target);
        this.add("composition", id, target, this.line(file, creation), row.name);
      }
    }
    if (!type) return;
    const variants = Array.isArray(type) ? type : [{ type, annotation }];
    const choices = variants.flatMap(item => this.fieldChoices(item.type, item.annotation));
    const present = choices.filter(choice => !(choice.type.flags & nullish));
    const singles = new Set();
    let allSingle = present.length > 0;
    for (const { type: choice, annotation: declared } of present) {
      const value = this.collectionItem(choice);
      if (value) {
        allSingle = false;
        let written;
        if (declared && ts.isArrayTypeNode(declared)) written = declared.elementType;
        if (declared && ts.isTypeReferenceNode(declared)) {
          const symbol = this.checker.getSymbolAtLocation(declared.typeName);
          if (symbol && this.unalias(symbol) === value.symbol) written = declared.typeArguments?.[value.index];
        }
        for (const item of this.fieldChoices(value.type, written)) {
          const target = this.declaredTarget(item.annotation)
            ?? this.target(item.type.aliasSymbol) ?? this.target(item.type.getSymbol());
          if (!owners.has(target)) this.add("aggregation", id, target, row.line, row.name, "0..*");
        }
        continue;
      }
      const target = this.declaredTarget(declared) ?? this.target(choice.aliasSymbol)
        ?? (!choice.getConstructSignatures().length && this.target(choice.getSymbol()));
      if (target) singles.add(target);
      else allSingle = false;
    }
    if (allSingle && singles.size === 1 && !owners.size) {
      this.add("association", id, [...singles][0], row.line, row.name,
        optional || present.length !== choices.length ? "0..1" : "1");
    }
    this.typeDependencies(id, row.line, variants.map(item => item.type));
  }

  heritage(file, id, node) {
    for (const clause of node.heritageClauses ?? []) {
      const kind = clause.token === ts.SyntaxKind.ImplementsKeyword ? "realization" : "generalization";
      for (const base of clause.types) {
        const target = this.referenceTarget(base.expression, false, base);
        this.add(kind, id, target, this.line(file, base));
      }
    }
  }

  constructorFields(node) {
    const assignments = new Map();
    for (const member of node.members ?? []) {
      if (!ts.isConstructorDeclaration(member) || !member.body) continue;
      visit(member.body, child => {
        if (ts.isClassLike(child)) return false;
        if (ts.isFunctionLike(child)) {
          if (!ts.isArrowFunction(child) || modifiers(child) & ts.ModifierFlags.Async) return false;
          let callee = child;
          while (callee.parent && unwrap(callee.parent) === child) callee = callee.parent;
          if (!ts.isCallExpression(callee.parent) || callee.parent.expression !== callee) return false;
        }
        const name = assignedField(this.checker, child);
        if (name === undefined) return;
        const field = assignments.get(name) ?? { node: child, name, value: child.right, creations: [] };
        const value = unwrap(child.right);
        if (ts.isNewExpression(value)) field.creations.push(child);
        assignments.set(name, field);
      });
    }
    return assignments;
  }

  classifierMembers(file, id, node) {
    const element = this.elements[id];
    const rows = element.members ??= [];
    if (ts.isTypeAliasDeclaration(node) && !ts.isTypeLiteralNode(node.type)) {
      const type = this.checker.getTypeFromTypeNode(node.type);
      for (const property of type.getProperties()) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        const local = declaration?.getSourceFile() === file.source;
        const location = local ? declaration : node;
        const fieldType = this.checker.getTypeOfSymbolAtLocation(property, node);
        if (declaration && (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration))) {
          for (const signature of this.checker.getNonNullableType(fieldType).getCallSignatures()) {
            const method = signature.declaration ?? declaration;
            const row = this.member(file, declaration, {
              kind: "method", name: property.name, location: method.getSourceFile() === file.source ? method : node,
              ...this.signatureMembers(signature, node),
            });
            rows.push(row);
            this.typeDependencies(id, row.line, this.signatureTypes(signature));
          }
        } else {
          const optional = Boolean(property.flags & ts.SymbolFlags.Optional);
          const annotation = declaration && this.matchingAnnotation(fieldType, ts.getEffectiveTypeAnnotationNode(declaration), optional);
          const row = this.member(file, declaration ?? node, {
            kind: "field", name: property.name, location,
            type: annotation?.getText() ?? this.typeText(fieldType, node),
          });
          rows.push(row);
          this.fieldLinks(file, id, row, fieldType, { optional, annotation });
        }
      }
    }
    const members = ts.isTypeAliasDeclaration(node) ? node.type.members ?? [] : node.members;
    const assigned = this.constructorFields(node);
    const fields = new Set();
    const addField = member => {
      const name = this.propertyName(member.name) ?? nameOf(member.name);
      if (name === undefined) return;
      const staticMember = Boolean(modifiers(member) & ts.ModifierFlags.Static);
      const key = JSON.stringify([name, staticMember]);
      if (fields.has(key)) return;
      fields.add(key);
      const row = this.member(file, member, { kind: "field", name });
      rows.push(row);
      const creations = [...(!staticMember ? assigned.get(name)?.creations ?? [] : [])];
      if (!staticMember) assigned.delete(name);
      const initializer = unwrap(member.initializer);
      if (initializer && ts.isNewExpression(initializer)) creations.unshift(initializer);
      const typed = ts.isSetAccessorDeclaration(member) ? member.parameters[0] ?? member : member;
      this.fieldLinks(file, id, row, this.checker.getTypeAtLocation(typed), {
        optional: Boolean(member.questionToken), creations, annotation: ts.getEffectiveTypeAnnotationNode(typed),
      });
    };
    for (const member of members) {
      if (ts.isEnumMember(member)) {
        rows.push(this.member(file, member, { kind: "literal" }));
      } else if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)
          || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        addField(member);
      } else if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member) || ts.isConstructorDeclaration(member)) {
        rows.push(this.member(file, member, { kind: "method" }));
        if (ts.isConstructorDeclaration(member)) {
          for (const parameter of member.parameters) {
            if (ts.isParameterPropertyDeclaration(parameter, member)) addField(parameter);
          }
        }
      }
    }
    for (const { node: assignment, name, value, creations } of assigned.values()) {
      const type = this.checker.getTypeAtLocation(value);
      const row = this.member(file, assignment, {
        kind: "field", name, semanticType: type, visibility: name.startsWith("#") ? "-" : "+",
      });
      rows.push(row);
      this.fieldLinks(file, id, row, type, { creations });
    }
    rows.sort((left, right) => left.line - right.line);
    this.heritage(file, id, node);
    this.dependencies(file, id, node);
  }

  moduleMembers(file) {
    const members = [];
    const exported = exportedDeclarations(this, file);
    const direct = file.commonJsDirectExport?.valueDeclaration;
    const inline = direct && (ts.isFunctionExpression(direct) || ts.isArrowFunction(direct)) ? direct : undefined;
    let inlineStatement = inline;
    while (inlineStatement?.parent && inlineStatement.parent !== file.source) inlineStatement = inlineStatement.parent;
    const id = this.claimId(`${file.module}:utility`);
    const add = (node, declaration, kind, name) => {
      const isExported = exported.has(declaration) || modifiers(declaration) & ts.ModifierFlags.Export;
      const row = this.member(file, node, {
        kind, name, location: declaration, visibility: isExported ? "+" : "-", static: true,
      });
      members.push(row);
      if (kind === "method") {
        if (isExported) this.composables.set(declaration, id);
      } else {
        const initializer = unwrap(node.initializer);
        this.fieldLinks(file, id, row, this.checker.getTypeAtLocation(node), {
          creations: initializer && ts.isNewExpression(initializer) ? [initializer] : [],
          annotation: ts.getEffectiveTypeAnnotationNode(node),
        });
      }
      this.dependencies(file, id, node);
    };
    for (const statement of file.source.statements) {
      if (statement === inlineStatement) add(inline, inline, "method", nameOf(inline.name) ?? "default");
      if (ts.isFunctionDeclaration(statement)) {
        add(statement, statement, "method", nameOf(statement.name) ?? "default");
      } else if (ts.isVariableStatement(statement)) {
        const constant = Boolean(statement.declarationList.flags & ts.NodeFlags.Const);
        for (const declaration of statement.declarationList.declarations) {
          const initializer = unwrap(declaration.initializer);
          if (this.declarations.has(declaration)) continue;
          for (const binding of bindings(declaration)) {
            const name = nameOf(binding.name);
            if (constant && binding === declaration && initializer && (ts.isArrowFunction(initializer)
                || declaration === direct && ts.isFunctionExpression(initializer))) {
              add(initializer, binding, "method", name);
            } else {
              add(binding, binding, "field", name);
            }
          }
        }
      }
    }
    if (members.length) {
      const name = this.elements[file.package].name;
      const utility = this.element(id, "utility", name, file.package, file, 1);
      (utility.members ??= []).push(...members.sort((left, right) => left.line - right.line));
    }
  }

  imports(file) {
    const importedModule = node => {
      const literal = moduleSpecifier(node, this.checker);
      if (!literal) return;
      const imported = this.resolvedImport(literal);
      if (!imported) return;
      const line = this.line(file, node);
      this.add("dependency", file.package, imported.package, line, undefined, undefined, file.path);
      if (file.language === "vue") vueImportDependencies(this, file, node, imported, line);
    };
    if (file.scripts) {
      for (const { statement } of file.scripts) visit(statement, importedModule);
    } else {
      visit(file.source, importedModule);
    }
  }
}

function extract({ root, files }) {
  files.sort((left, right) => left.path < right.path ? -1 : Number(left.path > right.path));
  const project = createProgram(root, files);
  const facts = new Facts(project);
  facts.packageFiles(project.files);
  const classifiers = new Map();
  for (const file of project.files) {
    if (file.language !== "vue") classifiers.set(file, facts.classifiers(file));
  }
  for (const [file, declarations] of classifiers) facts.registerClassifiers(file, declarations);
  for (const [file, declarations] of classifiers) {
    for (const { id, node } of declarations) facts.classifierMembers(file, id, node);
    facts.moduleMembers(file);
  }
  for (const file of project.files) {
    if (file.language === "vue") vueMembers(facts, file);
    facts.imports(file);
  }
  return facts.results(project.warnings);
}

async function main() {
  process.stdin.setEncoding("utf8");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(JSON.stringify(extract(JSON.parse(chunks.join(""))),
    (_key, value) => typeof value === "string" ? modelText(value) : value));
}

main();
