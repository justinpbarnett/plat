const { ts } = require("./parsers.cjs");
const { nameOf, unwrap, assignedValue, valueSymbol, staticPropertyName } = require("./syntax.cjs");

const nodeResolution = { moduleResolution: ts.ModuleResolutionKind.NodeNext };

function propertyAccess(checker, node) {
  const value = unwrap(node);
  if (!value) return;
  if (ts.isPropertyAccessExpression(value)) return { receiver: value.expression, name: value.name.text };
  if (ts.isElementAccessExpression(value)) {
    const name = staticPropertyName(checker, value.argumentExpression);
    if (name !== undefined) return { receiver: value.expression, name };
  }
}

function descriptorValue(checker, expression) {
  const descriptor = unwrap(expression);
  if (!ts.isObjectLiteralExpression(descriptor)) return;
  const fields = new Map();
  for (const property of descriptor.properties) {
    if (ts.isSpreadAssignment(property)) return;
    const name = ts.isComputedPropertyName(property.name)
      ? staticPropertyName(checker, property.name.expression) : nameOf(property.name);
    if (name === undefined) return;
    fields.set(name, property);
  }
  if (!fields.has("get") && !fields.has("set")) {
    const value = fields.get("value");
    if (value && ts.isPropertyAssignment(value)) return value.initializer;
    if (value && ts.isShorthandPropertyAssignment(value)) return value.name;
    return;
  }
  const get = fields.get("get");
  if (!get || fields.has("value") || fields.has("writable")) return;
  const getter = ts.isPropertyAssignment(get) ? unwrap(get.initializer) : get;
  if (!(ts.isMethodDeclaration(getter) || ts.isArrowFunction(getter) || ts.isFunctionExpression(getter))
      || getter.asteriskToken || ts.getCombinedModifierFlags(getter) & ts.ModifierFlags.Async) return;
  const body = getter.body;
  if (!body || !ts.isBlock(body)) return body;
  const [statement] = body.statements;
  if (body.statements.length === 1 && ts.isReturnStatement(statement)) return statement.expression;
}

function commonJsExports(facts, file) {
  const { source } = file;
  const explicitModule = source.externalModuleIndicator && source.externalModuleIndicator !== true;
  if (!/\.c[jt]s$/i.test(file.path) && (explicitModule
      || ts.getImpliedNodeFormatForFile(source.fileName, undefined, ts.sys, nodeResolution) === ts.ModuleKind.ESNext)) {
    return [];
  }
  const { checker } = facts;
  const initial = { properties: new Map() };
  const values = new WeakMap();
  let moduleValue = initial;
  let exportsValue = initial;

  function isWrapperBinding(node, name) {
    const value = unwrap(node);
    if (!ts.isIdentifier(value) || value.text !== name) return false;
    const symbol = checker.resolveName(name, value, ts.SymbolFlags.Value | ts.SymbolFlags.Alias, false);
    return !symbol || Boolean(symbol.flags & ts.SymbolFlags.ModuleExports)
      || (name === "exports" && symbol.declarations?.some(declaration => declaration === source));
  }

  function isModuleExports(node) {
    const access = propertyAccess(checker, node);
    return access?.name === "exports" && isWrapperBinding(access.receiver, "module");
  }

  function propertyMap(receiver) {
    if (isModuleExports(receiver)) return moduleValue.properties ??= new Map();
    if (isWrapperBinding(receiver, "exports")) return exportsValue.properties ??= new Map();
  }

  function exportSymbol(node) {
    const value = unwrap(node);
    if (ts.isClassExpression(value) || ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
      return checker.getTypeAtLocation(value).getSymbol();
    }
    return valueSymbol(checker, value);
  }

  function valueOf(expression, seen = new Set()) {
    const node = unwrap(expression);
    if (isModuleExports(node)) return moduleValue;
    if (isWrapperBinding(node, "exports")) return exportsValue;
    if (values.has(node)) return values.get(node);
    if (seen.has(node)) return {};
    seen.add(node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return valueOf(node.right, seen);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Map();
      const object = { properties };
      values.set(node, object);
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          for (const [name, target] of valueOf(property.expression, seen).properties ?? []) {
            properties.set(name, target);
          }
        } else {
          const name = ts.isComputedPropertyName(property.name)
            ? staticPropertyName(checker, property.name.expression) : nameOf(property.name);
          const value = ts.isPropertyAssignment(property) ? property.initializer
            : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
          if (name !== undefined) properties.set(name, value && exportSymbol(value));
        }
      }
      seen.delete(node);
      return object;
    }
    const symbol = exportSymbol(node);
    const initializer = symbol && assignedValue(facts.unalias(symbol).valueDeclaration);
    const properties = initializer && valueOf(initializer, seen).properties;
    seen.delete(node);
    return { symbol, properties };
  }

  function updateObject(call) {
    const access = propertyAccess(checker, call.expression);
    if ((access?.name !== "assign" && access?.name !== "defineProperty") || !call.arguments.length) return;
    const object = unwrap(access.receiver);
    if (!ts.isIdentifier(object) || object.text !== "Object") return;
    const declarations = checker.resolveName("Object", object, ts.SymbolFlags.Value | ts.SymbolFlags.Alias, false)?.declarations;
    if (!declarations?.length
        || !declarations.every(declaration => facts.program.isSourceFileDefaultLibrary(declaration.getSourceFile()))) return;
    const [receiver, ...args] = call.arguments;
    if (ts.isSpreadElement(receiver)) return;
    const target = valueOf(receiver);
    if (access.name === "defineProperty") {
      const [key, descriptor] = args;
      if (!descriptor || ts.isSpreadElement(key) || ts.isSpreadElement(descriptor)) return;
      const name = staticPropertyName(checker, key);
      if (name !== undefined) {
        const value = descriptorValue(checker, descriptor);
        if (value) (target.properties ??= new Map()).set(name, exportSymbol(value));
      }
    } else {
      for (const source of args) {
        if (ts.isSpreadElement(source)) continue;
        for (const [name, symbol] of valueOf(source).properties ?? []) {
          (target.properties ??= new Map()).set(name, symbol);
        }
      }
    }
    values.set(call, target);
  }

  function visit(node) {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    ts.forEachChild(node, visit);
    if (ts.isCallExpression(node)) {
      updateObject(node);
      return;
    }
    if (ts.isDeleteExpression(node)) {
      if (isModuleExports(node.expression)) {
        moduleValue = {};
      } else {
        const access = propertyAccess(checker, node.expression);
        if (access) propertyMap(access.receiver)?.delete(access.name);
      }
      return;
    }
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    if (isModuleExports(node.left)) {
      moduleValue = valueOf(node.right);
      values.set(node, moduleValue);
    } else if (isWrapperBinding(node.left, "exports")) {
      exportsValue = valueOf(node.right);
      values.set(node, exportsValue);
    } else {
      const access = propertyAccess(checker, node.left);
      if (access) propertyMap(access.receiver)?.set(access.name, exportSymbol(node.right));
    }
  }
  visit(source);
  file.commonJsDirectExport = moduleValue.symbol;
  file.commonJsNamedExports = moduleValue.properties;
  file.commonJsReassigned = moduleValue !== initial;
  return [["default", file.commonJsDirectExport], ...(file.commonJsNamedExports ?? [])];
}

function explicitModuleSymbol(checker, source) {
  if (source.externalModuleIndicator && source.externalModuleIndicator !== true) {
    return checker.getSymbolAtLocation(source);
  }
}

function namedExport(facts, file, name) {
  const named = file.commonJsNamedExports;
  if (file.commonJsReassigned || named?.has(name)) return named?.get(name);
  const { source } = file;
  const { checker } = facts;
  const module = explicitModuleSymbol(checker, source);
  if (module) return checker.getTypeOfSymbolAtLocation(module, source).getProperty(name);
}

function typeOnlyExport(declaration) {
  if (ts.isExportSpecifier(declaration)) return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
  if (ts.isNamespaceExport(declaration)) return declaration.parent.isTypeOnly;
  return ts.isImportEqualsDeclaration(declaration) && declaration.isTypeOnly;
}

function exportedDeclarations(facts, file) {
  const { source } = file;
  const { checker } = facts;
  const result = new Set();
  const add = symbol => {
    if (!symbol) return;
    for (const declaration of facts.unalias(symbol).declarations ?? []) result.add(declaration);
  };
  const module = explicitModuleSymbol(checker, source);
  if (module) {
    for (const symbol of checker.getExportsOfModule(module)) {
      const declarations = symbol.declarations;
      if (!declarations?.length || !declarations.every(typeOnlyExport)) add(symbol);
    }
  }
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && statement.isExportEquals) {
      add(valueSymbol(checker, unwrap(statement.expression)));
    }
  }
  for (const [, symbol] of file.commonJsExports) add(symbol);
  return result;
}

module.exports = { propertyAccess, commonJsExports, namedExport, exportedDeclarations };
