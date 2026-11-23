const { ts } = require("./parsers.cjs");

function position(node) {
  return node.getStart();
}

function nameOf(node) {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)
      || ts.isNumericLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) return node.expression.text;
  return node.getText();
}

function modifiers(node) {
  return ts.getCombinedModifierFlags(node);
}

function docOf(node) {
  const doc = ts.getJSDocCommentsAndTags(node).find(ts.isJSDoc);
  const text = ts.getTextOfJSDocComment(doc?.comment)?.replace(/\s+/g, " ").trim();
  const end = text?.search(/[.!?](?=\s|$)/) ?? -1;
  return end < 0 ? text : text.slice(0, end + 1);
}

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) {
    node = node.expression;
  }
  return node;
}

function assignedValue(node) {
  if (!node) return;
  if (ts.isExportAssignment(node)) return node.expression;
  if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) return node.initializer;
}

function valueSymbol(checker, node) {
  if (ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)) {
    return checker.getShorthandAssignmentValueSymbol(node.parent);
  }
  return checker.getSymbolAtLocation(node);
}

function staticPropertyName(checker, node) {
  const expression = unwrap(node);
  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return expression.text;
  const type = checker.getTypeAtLocation(expression);
  if (type.isStringLiteral() || type.isNumberLiteral()) return String(type.value);
}

function* bindings(declaration) {
  if (ts.isIdentifier(declaration.name)) {
    yield declaration;
  } else {
    for (const element of declaration.name.elements) {
      if (ts.isBindingElement(element)) yield* bindings(element);
    }
  }
}

function visit(node, action) {
  if (action(node) !== false) ts.forEachChild(node, child => visit(child, action));
}

function moduleSpecifier(node, checker) {
  let specifier;
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    specifier = node.moduleReference.expression;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    if (callee.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
    if (ts.isIdentifier(callee) && callee.text === "require") {
      const symbol = checker.resolveName(callee.text, callee, ts.SymbolFlags.Value | ts.SymbolFlags.Alias, false);
      if (!symbol?.declarations?.some(declaration => !declaration.getSourceFile().isDeclarationFile)) {
        specifier = node.arguments[0];
      }
    }
  }
  return specifier && ts.isStringLiteralLike(specifier) ? specifier : undefined;
}

function importBindings(node, includeTypes = true) {
  if (ts.isImportEqualsDeclaration(node)) return includeTypes || !node.isTypeOnly ? [node.name] : [];
  if (!ts.isImportDeclaration(node) || !node.importClause) return [];
  const { name, namedBindings, isTypeOnly } = node.importClause;
  if (!includeTypes && isTypeOnly) return [];
  const names = name ? [name] : [];
  if (namedBindings) {
    if (ts.isNamespaceImport(namedBindings)) names.push(namedBindings.name);
    else for (const element of namedBindings.elements) {
      if (includeTypes || !element.isTypeOnly) names.push(element.name);
    }
  }
  return names;
}

module.exports = {
  position, nameOf, modifiers, docOf, unwrap, assignedValue, valueSymbol, staticPropertyName,
  bindings, visit, moduleSpecifier, importBindings,
};
