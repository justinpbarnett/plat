const { ts } = require("./parsers.cjs");
const { nameOf, unwrap, assignedValue, valueSymbol, staticPropertyName } = require("./syntax.cjs");

const nodeResolution = { moduleResolution: ts.ModuleResolutionKind.NodeNext };

function propertyAccess(checker, node) {
  const value = unwrap(node);
  if (ts.isPropertyAccessExpression(value)) return { receiver: value.expression, name: value.name.text };
  if (ts.isElementAccessExpression(value)) {
    const name = staticPropertyName(checker, value.argumentExpression);
    if (name !== undefined) return { receiver: value.expression, name };
  }
}

function commonJsExports(facts, file) {
  const { source } = file;
  const explicitModule = source.externalModuleIndicator && source.externalModuleIndicator !== true;
  if (!/\.c[jt]s$/i.test(file.path) && (file.language !== "javascript" || explicitModule
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
    return ts.isClassExpression(value) ? checker.getTypeAtLocation(value).getSymbol() : valueSymbol(checker, value);
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
          const name = nameOf(property.name);
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

  function visit(node) {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    ts.forEachChild(node, visit);
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
  return [["default", moduleValue.symbol], ...(moduleValue.properties ?? [])];
}

function exportedDeclarations(facts, file) {
  const { source } = file;
  const { checker } = facts;
  const result = new Set();
  const add = symbol => {
    if (!symbol) return;
    for (const declaration of facts.unalias(symbol).declarations ?? []) result.add(declaration);
  };
  const explicitModule = source.externalModuleIndicator && source.externalModuleIndicator !== true;
  const module = checker.getSymbolAtLocation(source);
  if (module && explicitModule) checker.getExportsOfModule(module).forEach(add);
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && statement.isExportEquals) {
      add(valueSymbol(checker, unwrap(statement.expression)));
    }
  }
  for (const [, symbol] of file.commonJsExports) add(symbol);
  return result;
}

module.exports = { commonJsExports, exportedDeclarations };
