const fs = require("node:fs");
const path = require("node:path");
const { ts, vue } = require("./parsers.cjs");
const { bindings, visit, invalidScriptGrammar } = require("./syntax.cjs");

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
const nodeFormatOptions = { moduleResolution: ts.ModuleResolutionKind.NodeNext };

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

function isJavaScript(kind) {
  return kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX;
}

function packageTypes() {
  const types = new Map();
  function packageType(directory) {
    if (!types.has(directory)) {
      const parent = path.dirname(directory);
      const manifest = path.join(directory, "package.json");
      const text = ts.sys.readFile(manifest);
      let type;
      if (text !== undefined) type = ts.parseConfigFileTextToJson(manifest, text).config?.type;
      else if (parent !== directory && path.basename(directory) !== "node_modules") type = packageType(parent);
      types.set(directory, type);
    }
    return types.get(directory);
  }
  return packageType;
}

function scriptSourceType(source, nodeFormat, packageType) {
  switch (path.extname(source.fileName).toLowerCase()) {
    case ".cjs": return "commonjs";
    case ".cts": return ts.isExternalModule(source) ? "module" : "script";
    case ".mjs":
    case ".mts": return "module";
  }
  if (nodeFormat === ts.ModuleKind.ESNext || ts.isExternalModule(source)) return "module";
  if (isJavaScript(source.scriptKind)) return packageType === "commonjs" ? "commonjs" : "unambiguous";
  return "script";
}

function parsed(fileName, text, scriptKind, firstLine, nodeFormat, setup = false, packageType) {
  const source = ts.createSourceFile(fileName, text, options.target, true, scriptKind);
  const diagnostic = source.parseDiagnostics[0];
  if (diagnostic) {
    const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + firstLine;
    throw new Error(`line ${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
  if (isJavaScript(scriptKind)) {
    const syntax = typescriptSyntax(source);
    if (syntax) {
      const line = source.getLineAndCharacterOfPosition(syntax.getStart(source)).line + firstLine;
      throw new Error(`line ${line}: TypeScript syntax is only allowed in TypeScript files`);
    }
  }
  const invalid = invalidScriptGrammar(source, scriptSourceType(source, nodeFormat, packageType), setup);
  if (invalid) {
    const line = source.getLineAndCharacterOfPosition(invalid.position).line + firstLine;
    throw new Error(`line ${line}: ${invalid.message}`);
  }
  return source;
}

function scopeRequireCalls(source, kind) {
  if (!isJavaScript(kind)) return;
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

function localExportSpecifiers(statement) {
  if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier
      && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    return statement.exportClause.elements;
  }
  return [];
}

function setupDeclarationNames(statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap(declaration =>
      Array.from(bindings(declaration), binding => binding.name));
  }
  if (!ts.isImportEqualsDeclaration(statement) && statement.name && ts.isIdentifier(statement.name)) {
    return [statement.name];
  }
  return [];
}

function setupTypeExports(source, blocks) {
  const declarations = new Map();
  const directExports = new Map();
  const requested = new Set();
  for (const statement of source.statements) {
    for (const specifier of localExportSpecifiers(statement)) requested.add((specifier.propertyName ?? specifier.name).text);
    const flags = ts.getCombinedModifierFlags(statement);
    for (const name of setupDeclarationNames(statement)) {
      if (!declarations.has(name.text)) declarations.set(name.text, []);
      if (flags & ts.ModifierFlags.Export) {
        directExports.set(name.text, flags & ts.ModifierFlags.Default ? "default" : name.text);
        requested.add(name.text);
      } else {
        declarations.get(name.text).push(statement.getStart(source));
      }
    }
  }
  const names = [...requested].filter(name => declarations.has(name));
  if (!names.length) return;

  const identifiers = new Set();
  for (const block of blocks) {
    if (block.source) visit(block.source, node => {
      if (ts.isIdentifier(node)) identifiers.add(node.text);
    });
  }
  let next = 0;
  function fresh(stem) {
    let name = `${stem}${next++}`;
    while (identifiers.has(name)) name = `${stem}${next++}`;
    return name;
  }
  const scope = fresh("__platSetup");
  const aliases = new Map();
  const exportPositions = new Set();
  const statements = [];
  for (const name of names) {
    const alias = fresh("__platType");
    aliases.set(name, alias);
    for (const position of declarations.get(name)) exportPositions.add(position);
    const exported = directExports.get(name);
    const member = exported === "default" ? "default" : name;
    statements.push(`import ${alias} = ${scope}.${member};`);
    if (exported !== undefined) statements.push(`export type { ${alias} as ${exported} };`);
  }
  return { scope, aliases, exportPositions, bridge: statements.join("\n") + "\n" };
}

function liftedSetupText(source, statement, start, aliases) {
  const parts = [];
  let end = start;
  for (const specifier of localExportSpecifiers(statement)) {
    const local = specifier.propertyName ?? specifier.name;
    const alias = aliases?.get(local.text);
    if (!alias) continue;
    parts.push(source.text.slice(end, local.getStart(source)), alias);
    if (!specifier.propertyName) parts.push(" as ", local.getText(source));
    end = local.end;
  }
  parts.push(source.text.slice(end, statement.end));
  return parts.join("");
}

function setupScript(source, block, lifted, separators, types) {
  const parts = [];
  let end = 0;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isImportEqualsDeclaration(statement)
        && !ts.isExportDeclaration(statement)) continue;
    const start = statement.getStart(source);
    const location = source.getLineAndCharacterOfPosition(start);
    const text = liftedSetupText(source, statement, start, types?.aliases);
    lifted.push({ text, line: block.loc.start.line + location.line, offset: block.loc.start.offset + start });
    const masked = source.text.slice(start + 1, statement.end).replace(/[^\r\n\u2028\u2029]/g, " ");
    parts.push(source.text.slice(end, start), ";", masked);
    separators.add(start);
    end = statement.end;
  }
  parts.push(source.text.slice(end));
  return parts.join("");
}

function finalizeSetupScope(container, source, start, types) {
  const asyncWrapper = types ? container.body.statements[0] : container;
  const statements = asyncWrapper.expression.expression.body.statements;
  if (types) {
    container.body.statements = statements;
    for (const statement of statements) {
      statement.parent = container.body;
      const position = statement.getStart(source);
      if (types.exportPositions.has(position - start)) {
        const keyword = ts.factory.createModifier(ts.SyntaxKind.ExportKeyword);
        ts.setTextRange(keyword, { pos: position, end: position });
        keyword.parent = statement;
        statement.modifiers = ts.factory.createNodeArray([keyword, ...(statement.modifiers ?? [])]);
        statement.modifierFlagsCache = ts.ModifierFlags.None;
      }
    }
  }
  return statements;
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
  const [language, secondLanguage] = blocks.map(block => (block.lang ?? "js").toLowerCase());
  if (blocks.length === 2 && language !== secondLanguage) {
    throw new Error(`line ${blocks[1].loc.start.line}: <script> and <script setup> must use the same language`);
  }
  const typed = ["ts", "tsx", "mts", "cts"].includes(language);
  const jsx = language === "jsx" || language === "tsx";
  const extension = typed ? (jsx ? "tsx" : "ts") : (jsx ? "jsx" : "js");
  let virtualName = `${fileName}.__plat.${extension}`;
  while (occupied.has(canonical(virtualName)) || ts.sys.fileExists(virtualName)) {
    virtualName = `${virtualName}.${extension}`;
  }
  const parsedBlocks = blocks.map(block => {
    const setup = block === descriptor.scriptSetup;
    const { line } = block.loc.start;
    const kind = scriptKinds.get(language);
    if (kind === undefined) throw new Error(`line ${line}: unsupported script language ${language}`);
    const source = block.src ? undefined : parsed(virtualName, block.content, kind, line, ts.ModuleKind.ESNext, setup);
    return { block, setup, source };
  });
  const defaultExport = parsedBlocks.some(({ block, source }) => block.src || source.statements.some(hasDefaultExport));
  let script = "";
  let setupStart;
  let setupBody;
  let types;
  const lifted = [];
  const separators = new Set();
  const chunks = [];
  function append(text, line, offset, setup) {
    const start = script.length;
    script += text;
    chunks.push({ start, end: script.length, line, offset, setup });
  }
  for (const { block, setup, source } of parsedBlocks) {
    const { line, offset } = block.loc.start;
    if (block.src) {
      append(`export { default } from ${JSON.stringify(block.src)};`, line, offset, false);
      script += "\n";
    } else if (setup) {
      types = setupTypeExports(source, parsedBlocks);
      script += ";";
      setupStart = script.length;
      if (types) script += `namespace ${types.scope} {\n`;
      script += "(async function () {\n";
      setupBody = script.length;
      append(setupScript(source, block, lifted, separators, types), line, offset, true);
      script += "\n});\n";
      if (types) script += "}\n";
    } else {
      append(block.content, line, offset, false);
      script += "\n;\n";
    }
  }
  if (types) script += types.bridge;
  for (const { text, line, offset } of lifted) {
    append(text, line, offset, true);
    script += "\n;\n";
  }
  if (!defaultExport) script += "export default {};\n";

  const kind = scriptKinds.get(extension);
  const source = ts.createSourceFile(virtualName, script, options.target, true, kind);
  function chunkAt(position) {
    let first = 0;
    let last = chunks.length;
    while (first < last) {
      const middle = Math.floor((first + last) / 2);
      const chunk = chunks[middle];
      if (position < chunk.start) last = middle;
      else if (position >= chunk.end) first = middle + 1;
      else return chunk;
    }
  }
  function originalLine(position) {
    const chunk = chunkAt(position);
    if (!chunk) return 1;
    return chunk.line + source.getLineAndCharacterOfPosition(position).line
      - source.getLineAndCharacterOfPosition(chunk.start).line;
  }
  const diagnostic = source.parseDiagnostics[0];
  if (diagnostic) {
    throw new Error(`line ${originalLine(diagnostic.start ?? 0)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
  scopeRequireCalls(source, kind);
  const scripts = [];
  function record(statement) {
    const start = statement.getStart(source);
    const chunk = chunkAt(start);
    if (chunk) scripts.push({ statement, setup: chunk.setup, offset: chunk.offset + start - chunk.start });
  }
  for (const statement of source.statements) {
    if (statement.getStart(source) === setupStart) {
      for (const child of finalizeSetupScope(statement, source, setupBody, types)) {
        if (!separators.has(child.getStart(source) - setupBody)) record(child);
      }
    } else record(statement);
  }
  scripts.sort((left, right) => left.offset - right.offset);
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
  const packageInfo = ts.createModuleResolutionCache(root, canonical, nodeFormatOptions).getPackageJsonInfoCache();
  const packageType = packageTypes();
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
        const nodeFormat = ts.getImpliedNodeFormatForFile(fileName, packageInfo, ts.sys, nodeFormatOptions);
        const type = isJavaScript(kind) && packageType(path.dirname(fileName));
        metadata.source = parsed(fileName, text, kind, 1, nodeFormat, false, type);
        scopeRequireCalls(metadata.source, kind);
        metadata.line = position => metadata.source.getLineAndCharacterOfPosition(position).line + 1;
      }
      sources.set(canonical(metadata.source.fileName), metadata);
    } catch (error) {
      skipped.add(canonical(fileName));
      warnings.push(`warning: ${file.path}: ${error.message.replace(/\s*\r?\n\s*/g, " ")}`);
    }
  }
  const declaringFiles = new Map([...sources.values()].map(file => [file.source, file]));
  for (const file of sources.values()) {
    file.location = node => {
      const declaring = declaringFiles.get(node?.getSourceFile());
      if (!declaring) return;
      return {
        line: declaring.line(node.getStart(declaring.source)),
        ...(declaring !== file && { path: declaring.path }),
      };
    };
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
    const name = literal.text;
    const extension = path.extname(name).toLowerCase();
    if (isJavaScript(scriptKinds.get(extension.slice(1))) && (/^\.{1,2}\//.test(name) || path.isAbsolute(name))) {
      const key = canonical(path.resolve(path.dirname(source.fileName), name));
      if (skipped.has(key)) return { resolvedModule: undefined };
      const exact = sources.get(key);
      if (exact) return { resolvedModule: {
        resolvedFileName: exact.source.fileName, extension, isExternalLibraryImport: false, resolvedUsingTsExtension: false,
      } };
    }
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
