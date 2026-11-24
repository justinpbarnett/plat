const { ts, vue } = require("./parsers.cjs");

const typescriptGrammarErrors = new Set([
  "AsyncFunctionInSingleStatementContext", "AwaitBindingIdentifier", "AwaitBindingIdentifierInStaticBlock",
  "AwaitExpressionFormalParameter", "AwaitNotInAsyncContext", "AwaitUsingNotInAsyncContext",
  "DeclarationMissingInitializer", "ForInOfLoopInitializer", "GeneratorInSingleStatementContext",
  "IllegalBreakContinue", "IllegalReturn", "NewlineAfterThrow", "StrictFunction",
  "UnexpectedImportExport", "UnexpectedLexicalDeclaration",
]);

function parserGrammarError(source, sourceType) {
  const typed = source.scriptKind === ts.ScriptKind.TS || source.scriptKind === ts.ScriptKind.TSX;
  const plugins = [typed ? "decorators-legacy" : "decorators", "decoratorAutoAccessors", "deprecatedImportAssert"];
  if (typed) plugins.push(["typescript", { dts: source.isDeclarationFile }]);
  if (source.scriptKind !== ts.ScriptKind.TS) plugins.push("jsx");
  const isGrammarError = error => {
    if (!(error instanceof SyntaxError) || !Number.isInteger(error.pos)) throw error;
    if (!typed || typescriptGrammarErrors.has(error.reasonCode)) return true;
    return (error.reasonCode === "UnexpectedReservedWord" || error.reasonCode === "UnexpectedUsingDeclaration"
      || error.reasonCode === "UnexpectedToken") && /^await\b/.test(source.text.slice(error.pos));
  };
  let errors;
  try {
    ({ errors } = vue.babelParse(source.text, {
      sourceType, plugins, allowUndeclaredExports: true, errorRecovery: typed,
    }));
  } catch (error) {
    errors = [error];
  }
  return errors.find(isGrammarError);
}

function setupValueExport(statement) {
  if (ts.isExportAssignment(statement)) return true;
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    return !statement.isTypeOnly && !(clause && ts.isNamedExports(clause)
      && clause.elements.length && clause.elements.every(element => element.isTypeOnly));
  }
  const flags = modifiers(statement);
  return Boolean(flags & ts.ModifierFlags.Export) && !(flags & ts.ModifierFlags.Ambient)
    && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)
    && !(ts.isImportEqualsDeclaration(statement) && statement.isTypeOnly);
}

function jumpHasTarget(jump, isBreak) {
  const label = jump.label?.text;
  for (let parent = jump.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent) || ts.isClassStaticBlockDeclaration(parent) || ts.isModuleBlock(parent)) return false;
    if (label !== undefined) {
      if (ts.isLabeledStatement(parent) && parent.label.text === label) {
        return isBreak || ts.isIterationStatement(parent.statement, true);
      }
    } else if (ts.isIterationStatement(parent, false) || (isBreak && ts.isSwitchStatement(parent))) {
      return true;
    }
  }
  return false;
}

function returnHasTarget(node, commonJsWrapper) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return true;
    if (ts.isClassStaticBlockDeclaration(parent) || ts.isModuleBlock(parent)) return false;
  }
  return commonJsWrapper;
}

function invalidVariableList(list) {
  const forOf = ts.isForOfStatement(list.parent);
  const forIn = ts.isForInStatement(list.parent);
  const iteration = forOf || forIn;
  if (iteration && list.declarations.length > 1) {
    return { node: list.declarations[1], message: "for-in and for-of loops require a single declaration" };
  }
  for (const node of list.declarations) {
    const pattern = ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name);
    if (node.initializer) {
      if (forOf) return { node, message: "for-of declarations cannot have an initializer" };
      if (forIn && (pattern || list.flags & ts.NodeFlags.BlockScoped)) {
        return { node, message: "for-in binding patterns and block-scoped declarations cannot have an initializer" };
      }
    } else if (!iteration) {
      if (pattern) return { node, message: "destructuring declarations must be initialized" };
      if (list.flags & ts.NodeFlags.Const) return { node, message: "const declarations must be initialized" };
    }
  }
}

function exportSite(statement) {
  if (ts.isExportAssignment(statement) || ts.isExportDeclaration(statement) || ts.isNamespaceExportDeclaration(statement)) {
    return statement;
  }
  return statement.modifiers?.find(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function invalidStatement(node) {
  const parent = node.parent;
  if (!ts.isSourceFile(parent) && !ts.isModuleBlock(parent)) {
    const site = exportSite(node);
    if (site) return { node: site, message: "exports must be at the top level of a module or namespace" };
  }
  const lexical = ts.isClassDeclaration(node)
    || (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.BlockScoped));
  if (lexical && (ts.isIfStatement(parent) || ts.isIterationStatement(parent, false)
      || ts.isWithStatement(parent) || ts.isLabeledStatement(parent))) {
    return { node, message: "lexical declarations require a block in this statement context" };
  }
}

function invalidScriptGrammar(source, sourceType, setup) {
  const diagnostic = parserGrammarError(source, sourceType);
  if (diagnostic) return { position: diagnostic.pos, message: diagnostic.message.replace(/ \(\d+:\d+\)$/, "") };
  const commonJsWrapper = sourceType === "commonjs";
  function check(node) {
    if (ts.isStatement(node)) {
      const invalid = invalidStatement(node);
      if (invalid) return invalid;
    }
    const isBreak = ts.isBreakStatement(node);
    if ((isBreak || ts.isContinueStatement(node)) && !jumpHasTarget(node, isBreak)) {
      return { node, message: isBreak ? "break has no valid target" : "continue has no valid loop target" };
    }
    if (ts.isReturnStatement(node) && !returnHasTarget(node, commonJsWrapper)) {
      return { node, message: "return is only allowed inside a function body" };
    }
    if (ts.isVariableDeclarationList(node) && !source.isDeclarationFile && !(node.flags & ts.NodeFlags.Ambient)) {
      const invalid = invalidVariableList(node);
      if (invalid) return invalid;
    }
    if (ts.isThrowStatement(node) && ts.nodeIsMissing(node.expression)) {
      return { node, message: "throw requires an expression on the same line" };
    }
    return ts.forEachChild(node, check);
  }
  const invalid = check(source);
  if (invalid) return { position: invalid.node.getStart(source), message: invalid.message };
  const exported = setup && source.statements.find(setupValueExport);
  if (exported) {
    return { position: (exportSite(exported) ?? exported).getStart(source), message: "value exports are not allowed in <script setup>" };
  }
}

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
  bindings, visit, moduleSpecifier, importBindings, invalidScriptGrammar,
};
