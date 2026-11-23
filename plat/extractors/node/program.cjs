const fs = require("node:fs");
const path = require("node:path");
const { ts, vue } = require("./parsers.cjs");
const { visit } = require("./syntax.cjs");

const options = {
  allowJs: true,
  allowNonTsExtensions: true,
  allowArbitraryExtensions: true,
  skipLibCheck: true,
  noEmit: true,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strictNullChecks: true,
  preserveSymlinks: true,
  types: [],
};

const scriptKinds = new Map([
  ["ts", ts.ScriptKind.TS], ["tsx", ts.ScriptKind.TSX],
  ["js", ts.ScriptKind.JS], ["jsx", ts.ScriptKind.JSX],
  ["mts", ts.ScriptKind.TS], ["cts", ts.ScriptKind.TS],
  ["mjs", ts.ScriptKind.JS], ["cjs", ts.ScriptKind.JS],
]);

function canonical(fileName) {
  const normalized = path.normalize(fileName);
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

const typedModifiers = ts.ModifierFlags.Abstract | ts.ModifierFlags.Ambient | ts.ModifierFlags.AccessibilityModifier
  | ts.ModifierFlags.Readonly | ts.ModifierFlags.Override;

function typescriptSyntax(node) {
  if ((ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node))
      || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)
      || ts.isModuleDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isNamespaceExportDeclaration(node)
      || ts.isIndexSignatureDeclaration(node)
      || ts.isNonNullExpression(node) || ts.isTypeParameterDeclaration(node)
      || ts.isExportAssignment(node) && node.isExportEquals
      || ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword
      || node.isTypeOnly || node.questionToken && (ts.isParameter(node) || ts.isPropertyDeclaration(node)
        || ts.isMethodDeclaration(node))
      || node.exclamationToken && (ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node))
      || node.modifiers && (ts.getCombinedModifierFlags(node) & typedModifiers)
      || (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && !node.body) {
    return node;
  }
  return ts.forEachChild(node, typescriptSyntax);
}

function uninitializedConst(node) {
  if (node.flags & ts.NodeFlags.Ambient) return;
  if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const) {
    const loop = ts.isForInStatement(node.parent) || ts.isForOfStatement(node.parent);
    if (!loop || node.declarations.length !== 1) {
      const constant = node.declarations.find(declaration => !declaration.initializer);
      if (constant) return constant;
    }
  }
  return ts.forEachChild(node, uninitializedConst);
}

function parsed(fileName, text, scriptKind, firstLine = 1) {
  const source = ts.createSourceFile(fileName, text, options.target, true, scriptKind);
  const diagnostic = source.parseDiagnostics[0];
  if (diagnostic) {
    const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + firstLine;
    throw new Error(`line ${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
  if (scriptKind === ts.ScriptKind.JS || scriptKind === ts.ScriptKind.JSX) {
    const syntax = typescriptSyntax(source);
    if (syntax) {
      const line = source.getLineAndCharacterOfPosition(syntax.getStart(source)).line + firstLine;
      throw new Error(`line ${line}: TypeScript syntax is only allowed in TypeScript files`);
    }
  }
  const constant = !source.isDeclarationFile && uninitializedConst(source);
  if (constant) {
    const line = source.getLineAndCharacterOfPosition(constant.getStart(source)).line + firstLine;
    throw new Error(`line ${line}: const declarations must be initialized`);
  }
  return source;
}

function scopeRequireCalls(source, kind) {
  if (kind !== ts.ScriptKind.JS && kind !== ts.ScriptKind.JSX) return;
  const calls = new Map();
  const requireCall = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text === "require";
  visit(source, node => {
    if (requireCall(node)) calls.set(node.expression.getStart(source), node);
  });
  if (!calls.size) return;

  const scoped = ts.createSourceFile(source.fileName, source.text, options.target, true, kind);
  ts.bindSourceFile(scoped, options);
  visit(scoped, node => {
    if (!requireCall(node)) return;
    for (let scope = node.parent; scope; scope = scope.parent) {
      const local = scope.locals?.get("require")?.declarations?.length;
      const self = (ts.isFunctionExpression(scope) || ts.isClassExpression(scope)) && scope.name?.text === "require";
      if (local || self) {
        const call = calls.get(node.expression.getStart(scoped));
        const callee = call.expression;
        const expression = ts.setTextRange(ts.factory.createParenthesizedExpression(callee), callee);
        callee.parent = expression;
        expression.parent = call;
        call.expression = expression;
        break;
      }
    }
  });
}

function hasDefaultExport(statement) {
  if (ts.isExportAssignment(statement)) return !statement.isExportEquals;
  if (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Default) return true;
  if (!ts.isExportDeclaration(statement) || !statement.exportClause) return false;
  const clause = statement.exportClause;
  return ts.isNamedExports(clause)
    ? clause.elements.some(element => element.name.text === "default")
    : clause.name.text === "default";
}

function setupImport(statement) {
  if (ts.isImportDeclaration(statement)) {
    const typeOnly = statement.importClause?.isTypeOnly ? "type {} from " : "";
    const attributes = statement.attributes ? ` ${statement.attributes.getText()}` : "";
    return `import ${typeOnly}${statement.moduleSpecifier.getText()}${attributes};\n`;
  }
  if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
    return `import type {} from ${statement.moduleReference.expression.getText()} with { "resolution-mode": "require" };\n`;
  }
  return "";
}

function vueSource(fileName, text, occupied) {
  const { descriptor, errors } = vue.parse(text, { filename: fileName, sourceMap: false });
  if (errors.length) {
    const error = errors[0];
    const line = error.loc?.start.line;
    throw new Error((line ? `line ${line}: ` : "") + (error.message ?? error));
  }

  const blocks = [descriptor.script, descriptor.scriptSetup].filter(Boolean);
  blocks.sort((left, right) => left.loc.start.offset - right.loc.start.offset);
  const languages = blocks.map(block => (block.lang ?? "js").toLowerCase());
  const typed = languages.some(lang => ["ts", "tsx", "mts", "cts"].includes(lang));
  const jsx = languages.some(lang => lang === "jsx" || lang === "tsx");
  const extension = typed ? (jsx ? "tsx" : "ts") : (jsx ? "jsx" : "js");
  let virtualName = `${fileName}.__plat.${extension}`;
  while (occupied.has(canonical(virtualName)) || ts.sys.fileExists(virtualName)) {
    virtualName = `${virtualName}.${extension}`;
  }
  let script = "";
  let defaultExport = false;
  let setupImports = "";
  let setupStart;
  const chunks = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const setup = block === descriptor.scriptSetup;
    const originalLine = block.loc.start.line;
    const kind = scriptKinds.get(languages[index]);
    if (kind === undefined) throw new Error(`line ${originalLine}: unsupported script language ${languages[index]}`);
    const blockSource = parsed(virtualName, block.content, kind, originalLine);
    if (setup) {
      script += ";";
      setupStart = script.length;
      script += "(async function () {\n";
      setupImports = blockSource.statements.map(setupImport).join("");
    } else {
      defaultExport = blockSource.statements.some(hasDefaultExport);
    }
    const start = script.length;
    script += block.content;
    chunks.push({ start, end: script.length, originalLine });
    script += setup ? "\n});\n" : "\n;\n";
  }
  script += setupImports;
  if (!defaultExport) script += "export default {};\n";

  const kind = scriptKinds.get(extension);
  const source = ts.createSourceFile(virtualName, script, options.target, true, kind);
  const chunkAt = position => chunks.find(chunk => position >= chunk.start && position < chunk.end);
  function originalLine(position) {
    const chunk = chunkAt(position);
    if (!chunk) return 1;
    return chunk.originalLine + source.getLineAndCharacterOfPosition(position).line
      - source.getLineAndCharacterOfPosition(chunk.start).line;
  }
  const diagnostic = source.parseDiagnostics[0];
  if (diagnostic) {
    throw new Error(`line ${originalLine(diagnostic.start ?? 0)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
  scopeRequireCalls(source, kind);
  const scripts = [];
  for (const statement of source.statements) {
    const start = statement.getStart(source);
    if (chunkAt(start)) {
      scripts.push({ statement, setup: false });
    } else if (start === setupStart) {
      for (const child of statement.expression.expression.body.statements) {
        scripts.push({ statement: child, setup: true });
      }
    }
  }
  return {
    source,
    scripts,
    extension: `.${extension}`,
    line: originalLine,
  };
}

function loadFiles(root, files) {
  const sources = new Map();
  const vueModules = new Map();
  const skipped = new Set();
  const warnings = [];
  const occupied = new Set(files.map(file => canonical(path.resolve(root, file.path))));
  for (const file of files) {
    const fileName = path.resolve(root, file.path);
    try {
      const text = fs.readFileSync(fileName, "utf8");
      const metadata = { ...file };
      if (file.language === "vue") {
        Object.assign(metadata, vueSource(fileName, text, occupied));
        vueModules.set(canonical(fileName.replace(/\.vue$/i, ".d.vue.ts")), metadata);
        vueModules.set(canonical(fileName), metadata);
      } else {
        const extension = path.extname(fileName).slice(1).toLowerCase();
        const kind = scriptKinds.get(extension);
        metadata.source = parsed(fileName, text, kind);
        scopeRequireCalls(metadata.source, kind);
        metadata.line = position => metadata.source.getLineAndCharacterOfPosition(position).line + 1;
      }
      sources.set(canonical(metadata.source.fileName), metadata);
    } catch (error) {
      skipped.add(canonical(fileName));
      warnings.push(`warning: ${file.path}: ${error.message.replace(/\s*\r?\n\s*/g, " ")}`);
    }
  }
  return { sources, vueModules, skipped, warnings };
}

function projectOptions(root) {
  const directories = new Map();
  const projects = new Map();
  const configHost = { ...ts.sys, readDirectory: () => [], onUnRecoverableConfigFileDiagnostic: () => {} };

  function inDirectory(directory) {
    if (directories.has(directory)) return directories.get(directory);
    const config = ["tsconfig.json", "jsconfig.json"].map(name => path.join(directory, name)).find(ts.sys.fileExists);
    let settings = config ? readConfig(config) : [];
    if (!settings.length && directory !== root) {
      const parent = path.dirname(directory);
      if (parent !== directory) settings = inDirectory(parent);
    }
    if (!settings.length) settings = [options];
    directories.set(directory, settings);
    return settings;
  }

  function readConfig(fileName) {
    if (!projects.has(fileName)) {
      const settings = [];
      projects.set(fileName, settings);
      const config = ts.getParsedCommandLineOfConfigFile(fileName, {}, configHost);
      if (config) {
        const project = config.options;
        settings.push({
          ...project,
          allowJs: true,
          allowArbitraryExtensions: true,
          preserveSymlinks: true,
          moduleResolution: project.moduleResolution ?? options.moduleResolution,
        });
        for (const reference of config.projectReferences ?? []) {
          settings.push(...readConfig(ts.resolveProjectReferencePath(reference)));
        }
      }
    }
    return projects.get(fileName);
  }

  return fileName => inDirectory(path.dirname(fileName));
}

function createProgram(root, files) {
  const { sources, vueModules, skipped, warnings } = loadFiles(root, files);
  const host = ts.createCompilerHost(options, true);
  const defaultSourceFile = host.getSourceFile.bind(host);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  host.getCurrentDirectory = () => root;
  host.fileExists = fileName => {
    const key = canonical(fileName);
    return !skipped.has(key) && (sources.has(key) || defaultFileExists(fileName));
  };
  host.readFile = fileName => sources.get(canonical(fileName))?.source.text ?? defaultReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const key = canonical(fileName);
    if (skipped.has(key)) return undefined;
    const source = sources.get(key)?.source;
    if (!source) return defaultSourceFile(fileName, languageVersion, ...rest);
    if (typeof languageVersion === "object") {
      source.impliedNodeFormat = languageVersion.impliedNodeFormat;
      languageVersion.setExternalModuleIndicator?.(source);
    }
    return source;
  };

  const moduleHost = {
    ...host,
    fileExists: fileName => vueModules.has(canonical(fileName)) || host.fileExists(fileName),
  };
  const settingsFor = projectOptions(root);
  const resolutionCaches = new Map();

  function resolve(literal, source) {
    let result;
    for (const settings of settingsFor(source.fileName)) {
      if (!resolutionCaches.has(settings)) {
        resolutionCaches.set(settings, ts.createModuleResolutionCache(root, canonical, settings));
      }
      const mode = ts.getModeForUsageLocation(source, literal, settings);
      result = ts.resolveModuleName(literal.text, source.fileName, settings,
        moduleHost, resolutionCaches.get(settings), undefined, mode);
      if (result.resolvedModule) break;
    }
    const resolved = result.resolvedModule;
    const component = resolved && vueModules.get(canonical(resolved.resolvedFileName));
    if (component) {
      return {
        ...result,
        resolvedModule: { ...resolved, resolvedFileName: component.source.fileName, extension: component.extension },
      };
    }
    return result;
  }

  host.resolveModuleNameLiterals = (literals, _fileName, _redirects, _options, source) =>
    literals.map(literal => resolve(literal, source));
  const program = ts.createProgram([...sources.values()].map(file => file.source.fileName), options, host);

  return {
    program,
    files: [...sources.values()],
    warnings,
    importedFile: literal => {
      const imported = resolve(literal, literal.getSourceFile()).resolvedModule;
      return imported && sources.get(canonical(imported.resolvedFileName));
    },
  };
}

exports.createProgram = createProgram;
