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
        const name = nameOf(property.name);
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
  const known = ts.isIdentifier(node) && runtimeTypes.get(node.text);
  if (known) return { text: known, types: [{ type: facts.checker.getAnyType() }] };
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const symbol = valueSymbol(facts.checker, node);
    const initializer = symbol && assignedValue(facts.unalias(symbol).valueDeclaration);
    if (initializer) {
      seen.add(node);
      const result = typeOfRuntimeProp(facts, initializer, seen);
      seen.delete(node);
      if (result.text !== "any") return result;
    }
  }
  const constructor = facts.checker.getTypeAtLocation(node).getConstructSignatures()[0];
  if (!constructor) return unknown;
  const type = constructor.getReturnType();
  return { text: facts.typeText(type, node), types: [{ type }] };
}

function localLocation(file, declaration, fallback) {
  return declaration?.getSourceFile() === file.source ? declaration : fallback;
}

function propsFromRuntime(facts, file, node, origin, add) {
  for (const [name, entry] of runtimeEntries(facts, node)) {
    const settings = objectValue(facts, entry.value);
    const options = settings && ts.isObjectLiteralExpression(settings)
      ? runtimeEntries(facts, settings) : undefined;
    const required = unwrap(options?.get("required")?.value)?.kind === ts.SyntaxKind.TrueKeyword;
    const { text, types } = typeOfRuntimeProp(facts, options ? options.get("type")?.value : entry.value);
    const location = localLocation(file, entry.declaration, origin);
    add({ kind: "field", name, visibility: "+", type: text, line: facts.line(file, location) },
      types, { optional: !required });
  }
}

function propsFromType(facts, file, node, add) {
  for (const property of facts.checker.getTypeFromTypeNode(node).getProperties()) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const location = localLocation(file, declaration, node);
    const type = facts.checker.getTypeOfSymbolAtLocation(property, node);
    const optional = Boolean(property.flags & ts.SymbolFlags.Optional);
    const annotation = declaration && facts.matchingAnnotation(type, ts.getEffectiveTypeAnnotationNode(declaration), optional);
    add({
      kind: "field", name: property.name, visibility: "+", line: facts.line(file, location),
      type: annotation?.getText() ?? facts.typeText(type, node),
    }, type, { optional, annotation });
  }
}

function event(facts, file, name, location, params = [], type = "void") {
  return { kind: "method", name, visibility: "+", line: facts.line(file, location), params, type };
}

function emitsFromType(facts, file, node, add) {
  const type = facts.checker.getTypeFromTypeNode(node);
  for (const signature of type.getCallSignatures()) {
    const [eventName] = signature.getParameters();
    if (!eventName) continue;
    const names = facts.checker.getTypeOfSymbolAtLocation(eventName, node);
    const location = localLocation(file, signature.declaration, node);
    const { params, type: result } = facts.signatureMembers(signature, node, 1);
    for (const name of names.isUnion() ? names.types : [names]) {
      if (name.isStringLiteral()) {
        add(event(facts, file, name.value, location, params, result));
      }
    }
  }
  for (const property of type.getProperties()) {
    const tuple = facts.checker.getTypeOfSymbolAtLocation(property, node);
    if (!facts.checker.isTupleType(tuple)) continue;
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const location = localLocation(file, declaration, node);
    const params = facts.checker.getTypeArguments(tuple).map((item, index) => {
      const label = tuple.target.labeledElementDeclarations?.[index];
      const flags = tuple.target.elementFlags[index];
      const rest = Boolean(flags & ts.ElementFlags.Rest);
      const annotation = !rest && facts.matchingAnnotation(item, label?.type, Boolean(flags & ts.ElementFlags.Optional));
      const type = rest ? facts.checker.typeToString(item, node, ts.TypeFormatFlags.InElementType) + "[]"
        : annotation?.getText() ?? facts.typeText(item, node);
      return { name: nameOf(label?.name) ?? `arg${index + 1}`, type };
    });
    add(event(facts, file, property.name, location, params));
  }
}

function emitsFromRuntime(facts, file, node, origin, add) {
  for (const [name, { declaration, value }] of runtimeEntries(facts, node)) {
    const validator = ts.isMethodDeclaration(declaration) ? declaration : runtimeValue(facts, value);
    const signature = validator && facts.checker.getTypeAtLocation(validator).getCallSignatures()[0];
    const params = validator && ts.isFunctionLike(validator)
      ? validator.parameters.map(parameter => facts.parameter(parameter))
      : signature?.getParameters().map(parameter => ({
        name: parameter.name,
        type: facts.typeText(facts.checker.getTypeOfSymbolAtLocation(parameter, validator), validator),
      })) ?? [];
    add(event(facts, file, name, localLocation(file, declaration, origin), params));
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
            creations: binding === declaration && initializer && ts.isNewExpression(initializer) ? [initializer] : [],
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
    const key = JSON.stringify([row.kind, row.name]);
    const previous = members.get(key);
    if (!previous || previous[0].row.visibility === "-" && row.visibility === "+") {
      members.set(key, [{ row, type, fieldOptions }]);
    } else if (row.kind === "method" && row.visibility === "+" && previous[0].row.visibility === "+") {
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
    const argument = value && ts.isCallExpression(value) ? value.arguments[0] : value;
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
  element.members.sort((left, right) => left.line - right.line);
}

exports.vueMembers = vueMembers;
