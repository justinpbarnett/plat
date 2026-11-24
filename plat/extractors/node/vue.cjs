const { ts } = require("./parsers.cjs");
const { position, nameOf, docOf, unwrap, assignedValue, valueSymbol, bindings, importBindings } = require("./syntax.cjs");

const runtimeTypes = new Map([
  ["String", "string"], ["Number", "number"], ["Boolean", "boolean"], ["BigInt", "bigint"],
  ["Symbol", "symbol"], ["Object", "object"], ["Array", "unknown[]"], ["Function", "Function"],
]);

function runtimeValue(facts, node, seen = new Set()) {
  const value = unwrap(node);
  if (!value || seen.has(value)) return;
  seen.add(value);
  if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    const symbol = valueSymbol(facts.checker, value);
    const declaration = symbol && facts.unalias(symbol).valueDeclaration;
    if (declaration && ts.isFunctionLike(declaration)) return declaration;
    const initializer = assignedValue(declaration);
    if (initializer) return runtimeValue(facts, initializer, seen);
  }
  return value;
}

function objectValue(facts, node) {
  const value = runtimeValue(facts, node);
  if (value && (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value))) return value;
}

function runtimeEntries(facts, node, seen = new Set()) {
  const entries = new Map();
  const value = objectValue(facts, node);
  if (!value || seen.has(value)) return entries;
  seen.add(value);
  const spread = expression => {
    for (const [name, entry] of runtimeEntries(facts, expression, seen)) entries.set(name, entry);
  };
  if (ts.isArrayLiteralExpression(value)) {
    for (const item of value.elements) {
      if (ts.isStringLiteralLike(item)) entries.set(item.text, { declaration: item });
      else if (ts.isSpreadElement(item)) spread(item.expression);
    }
  } else {
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        spread(property.expression);
      } else {
        const name = facts.propertyName(property.name);
        if (name !== undefined) entries.set(name, { declaration: property, value: property.initializer ?? property.name });
      }
    }
  }
  seen.delete(value);
  return entries;
}

function typeOfRuntimeProp(facts, node, seen = new Set()) {
  const unknown = { text: "any", types: [{ type: facts.checker.getAnyType() }] };
  if (!node || seen.has(node)) return unknown;
  if (node.kind === ts.SyntaxKind.NullKeyword) return { text: "null", types: [{ type: facts.checker.getNullType() }] };
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    return typeOfRuntimeProp(facts, node.expression, seen);
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    let annotation = node.type;
    while (ts.isParenthesizedTypeNode(annotation)) annotation = annotation.type;
    const name = ts.isTypeReferenceNode(annotation) ? annotation.typeName
      : ts.isImportTypeNode(annotation) ? annotation.qualifier : undefined;
    const part = name && ts.isQualifiedName(name) ? name.right : name;
    const symbol = part && facts.checker.getSymbolAtLocation(part);
    const imported = symbol?.declarations?.find(ts.isImportSpecifier);
    const original = imported?.propertyName ?? part;
    if (annotation.typeArguments?.length === 1 && nameOf(original) === "PropType") {
      const [argument] = annotation.typeArguments;
      const type = facts.checker.getTypeFromTypeNode(argument);
      return { text: argument.getText(), types: [{ type, annotation: argument }] };
    }
    return typeOfRuntimeProp(facts, node.expression, seen);
  }
  if (ts.isArrayLiteralExpression(node)) {
    seen.add(node);
    const values = node.elements.map(item => typeOfRuntimeProp(facts, item, seen));
    seen.delete(node);
    return {
      text: [...new Set(values.map(item => item.text))].join(" | ") || "any",
      types: values.flatMap(item => item.types),
    };
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const reference = valueSymbol(facts.checker, node);
    const symbol = reference && facts.unalias(reference);
    const declaration = symbol?.valueDeclaration;
    const known = symbol && runtimeTypes.get(symbol.name);
    if (known && declaration && facts.program.isSourceFileDefaultLibrary(declaration.getSourceFile())) {
      return { text: known, types: [{ type: facts.checker.getAnyType() }] };
    }
    const initializer = assignedValue(declaration);
    if (initializer) {
      seen.add(node);
      const result = typeOfRuntimeProp(facts, initializer, seen);
      seen.delete(node);
      if (result.text !== "any") return result;
    }
  }
  let constructor = facts.checker.getTypeAtLocation(node).getConstructSignatures()[0];
  if (!constructor) {
    const symbol = facts.bindingExportSymbol(node);
    if (symbol) constructor = facts.checker.getTypeOfSymbol(facts.unalias(symbol)).getConstructSignatures()[0];
  }
  if (!constructor) return unknown;
  const type = constructor.getReturnType();
  return { text: facts.typeText(type, node), types: [{ type }] };
}

function propsFromRuntime(facts, file, node, origin, add) {
  for (const [name, entry] of runtimeEntries(facts, node)) {
    const settings = objectValue(facts, entry.value);
    const options = settings && ts.isObjectLiteralExpression(settings)
      ? runtimeEntries(facts, settings) : undefined;
    const required = unwrap(options?.get("required")?.value)?.kind === ts.SyntaxKind.TrueKeyword;
    const { text, types } = typeOfRuntimeProp(facts, options ? options.get("type")?.value : entry.value);
    const row = facts.locateMember(file, { kind: "field", name, visibility: "+", type: text }, entry.declaration, origin);
    add(row, types, { optional: !required });
  }
}

function propsFromType(facts, file, node, add) {
  const { checker } = facts;
  const props = checker.getTypeFromTypeNode(node);
  const alternatives = props.isUnion() ? props.types : [props];
  const properties = new Map();
  for (const alternative of alternatives) {
    for (const property of alternative.getProperties()) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      const type = checker.getTypeOfSymbolAtLocation(property, node);
      const optional = Boolean(property.flags & ts.SymbolFlags.Optional);
      const annotation = declaration && facts.matchingAnnotation(type, ts.getEffectiveTypeAnnotationNode(declaration), optional);
      const choices = properties.get(property.name) ?? [];
      choices.push({ type, annotation, optional, declaration });
      properties.set(property.name, choices);
    }
  }
  for (const [name, choices] of properties) {
    const optional = choices.length !== alternatives.length || choices.some(choice => choice.optional);
    const location = choices.find(choice => choice.declaration?.getSourceFile() === file.source)
      ?? choices.find(choice => choice.declaration);
    const texts = new Set(choices.map(({ type, annotation }) => annotation?.getText() ?? facts.typeText(type, node)));
    const common = texts.size > 1 && props.getProperty(name);
    const text = texts.size === 1 ? texts.values().next().value
      : common ? facts.typeText(checker.getTypeOfSymbolAtLocation(common, node), node)
      : [...new Set(choices.map(({ type }) => checker.typeToString(type, node, ts.TypeFormatFlags.InElementType)))].join(" | ");
    const row = facts.locateMember(file, { kind: "field", name, visibility: "+", type: text }, location?.declaration, node);
    add(row, choices, { optional });
  }
}

function event(facts, file, name, declaration, fallback, params = [], type = "void") {
  return facts.locateMember(file, { kind: "method", name, visibility: "+", params, type }, declaration, fallback);
}

function emitsFromType(facts, file, node, add) {
  const type = facts.checker.getTypeFromTypeNode(node);
  for (const variant of type.isUnion() ? type.types : [type]) {
    emitsFromVariant(facts, file, variant, node, add);
  }
}

function emitsFromVariant(facts, file, type, node, add) {
  for (const signature of type.getCallSignatures()) {
    const [eventName] = signature.getParameters();
    if (!eventName) continue;
    const names = facts.checker.getTypeOfSymbolAtLocation(eventName, node);
    const events = (names.isUnion() ? names.types : [names]).filter(name => name.isStringLiteral());
    if (!events.length) continue;
    const { params, type: result } = facts.signatureMembers(signature, node, 1);
    const rows = events.map(name => event(facts, file, name.value, signature.declaration, node, params, result));
    for (const row of rows) add(row);
    facts.typeDependencies(file.module, rows[0].line, facts.signatureTypes(signature), undefined, rows[0].path);
  }
  for (const property of type.getProperties()) {
    const tuple = facts.checker.getTypeOfSymbolAtLocation(property, node);
    if (!facts.checker.isTupleType(tuple)) continue;
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const items = facts.checker.getTypeArguments(tuple);
    const params = items.map((item, index) => {
      const label = tuple.target.labeledElementDeclarations?.[index];
      const flags = tuple.target.elementFlags[index];
      const rest = Boolean(flags & ts.ElementFlags.Rest);
      const annotation = !rest && facts.matchingAnnotation(item, label?.type, Boolean(flags & ts.ElementFlags.Optional));
      const type = rest ? facts.checker.typeToString(item, node, ts.TypeFormatFlags.InElementType) + "[]"
        : annotation?.getText() ?? facts.typeText(item, node);
      return { name: nameOf(label?.name) ?? `arg${index + 1}`, type };
    });
    const row = event(facts, file, property.name, declaration, node, params);
    add(row);
    facts.typeDependencies(file.module, row.line, items, undefined, row.path);
  }
}

function callSignatures(facts, type) {
  return type ? facts.checker.getNonNullableType(type).getCallSignatures() : [];
}

function validatorSignatures(facts, validator) {
  if (!validator) return [];
  const signatures = callSignatures(facts, facts.checker.getTypeAtLocation(validator));
  if (signatures.length || !ts.isFunctionLike(validator)) return signatures;
  const signature = facts.checker.getSignatureFromDeclaration(validator);
  return signature ? [signature] : [];
}

function emitsFromRuntime(facts, file, node, origin, add) {
  const mapType = facts.checker.getTypeAtLocation(node);
  for (const [name, { declaration, value }] of runtimeEntries(facts, node)) {
    const validator = ts.isMethodDeclaration(declaration) ? declaration : value;
    const property = validator && mapType.getProperty(name);
    let signatures = callSignatures(facts, property && facts.checker.getTypeOfSymbolAtLocation(property, node));
    if (!signatures.length) signatures = validatorSignatures(facts, validator);
    if (!signatures.length) signatures = validatorSignatures(facts, runtimeValue(facts, validator));
    const [signature] = signatures;
    const params = signature ? facts.signatureMembers(signature, declaration).params : [];
    const row = event(facts, file, name, declaration, origin, params);
    add(row);
    for (const effective of signatures) {
      facts.typeDependencies(file.module, row.line, facts.signatureTypes(effective), undefined, row.path);
    }
  }
}

function setupBindings(facts, file, statement, add) {
  const record = (node, details, type, fieldOptions) =>
    add(facts.member(file, node, { ...details, visibility: "-" }), type, fieldOptions);
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    record(statement, { kind: "method" });
  } else if (ts.isVariableStatement(statement)) {
    const constant = Boolean(statement.declarationList.flags & ts.NodeFlags.Const);
    for (const declaration of statement.declarationList.declarations) {
      const initializer = unwrap(declaration.initializer);
      for (const binding of bindings(declaration)) {
        if (constant && binding === declaration && initializer && ts.isArrowFunction(initializer)) {
          record(initializer, { kind: "method", name: nameOf(binding.name), location: binding });
        } else {
          record(binding, { kind: "field" }, facts.checker.getTypeAtLocation(binding), {
            annotation: ts.getEffectiveTypeAnnotationNode(binding),
            initializer: binding === declaration ? initializer : undefined,
          });
        }
      }
    }
  } else if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
    record(statement, { kind: "field", name: statement.name.text });
  } else {
    for (const name of importBindings(statement, false)) record(name, { kind: "field", name: name.text });
  }
}

function vueMembers(facts, file) {
  const id = file.module;
  const element = facts.elements[id];
  const members = new Map();
  const add = (row, type, fieldOptions) => {
    const key = JSON.stringify([row.kind, row.name, row.visibility]);
    const previous = members.get(key);
    if (!previous) {
      members.set(key, [{ row, type, fieldOptions }]);
    } else if (row.kind === "method" && row.visibility === "+") {
      const signature = JSON.stringify([row.params, row.type]);
      if (!previous.some(item => JSON.stringify([item.row.params, item.row.type]) === signature)) {
        previous.push({ row, type, fieldOptions });
      }
    }
  };

  function macro(expression) {
    const node = unwrap(expression);
    if (!node || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const name = node.expression.text;
    const type = node.typeArguments?.[0];
    const argument = node.arguments[0];
    if (name === "defineProps") {
      if (type) propsFromType(facts, file, type, add);
      else if (argument) propsFromRuntime(facts, file, argument, node, add);
    } else if (name === "defineEmits") {
      if (type) emitsFromType(facts, file, type, add);
      else if (argument) emitsFromRuntime(facts, file, argument, node, add);
    } else if (name === "withDefaults" && argument) {
      const props = unwrap(argument);
      if (ts.isCallExpression(props) && ts.isIdentifier(props.expression) && props.expression.text === "defineProps") macro(props);
    }
  }

  function options(origin, initializer) {
    const value = runtimeValue(facts, initializer);
    let argument = value;
    if (value && ts.isCallExpression(value)) {
      const [first, second] = value.arguments;
      const setup = second && runtimeValue(facts, first);
      argument = setup && (ts.isFunctionLike(setup)
        || callSignatures(facts, facts.checker.getTypeAtLocation(first)).length) ? second : first;
    }
    const entries = runtimeEntries(facts, argument);
    const props = entries.get("props")?.value;
    const emits = entries.get("emits")?.value;
    if (props) propsFromRuntime(facts, file, props, origin, add);
    if (emits) emitsFromRuntime(facts, file, emits, origin, add);
    const doc = docOf(origin) ?? (value && docOf(value));
    if (doc) element.doc = doc;
  }

  const origin = file.defaultExport?.declarations?.[0];
  const exportStatement = origin && ts.isExportSpecifier(origin) ? origin.parent.parent : origin;
  let firstLine;
  for (const { statement, setup } of file.scripts) {
    const start = position(statement);
    firstLine ??= file.line(start);
    if (setup) {
      setupBindings(facts, file, statement, add);
      if (ts.isExpressionStatement(statement)) macro(statement.expression);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) macro(declaration.initializer);
      }
    } else if (statement === exportStatement) {
      const declaration = facts.unalias(file.defaultExport).valueDeclaration;
      options(statement, assignedValue(declaration));
    }
    facts.dependencies(file, id, statement);
  }
  element.line = firstLine ?? 1;
  element.members = [];
  for (const group of members.values()) {
    for (const { row, type, fieldOptions } of group) {
      element.members.push(row);
      if (type) facts.fieldLinks(file, id, row, type, fieldOptions);
    }
  }
  facts.sortMembers(element.members);
}

function vueImportDependencies(facts, file, node, imported, line) {
  const id = file.module;
  if (imported.language === "vue") facts.add("dependency", id, imported.module, line);
  const seen = new Set();
  function namespaceDependencies(symbol) {
    if (!symbol) return;
    const module = facts.unalias(symbol);
    if (seen.has(module) || !module.declarations?.some(ts.isSourceFile)) return;
    seen.add(module);
    for (const exported of facts.checker.getExportsOfModule(module)) {
      facts.add("dependency", id, facts.target(exported, true), line);
      namespaceDependencies(exported);
    }
  }
  for (const name of importBindings(node)) {
    facts.add("dependency", id, facts.referenceTarget(name, true), line);
    namespaceDependencies(facts.checker.getSymbolAtLocation(name));
  }
}

module.exports = { vueMembers, vueImportDependencies };
