import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

type ModuleEdge = {
  file: string;
  kind: 'import' | 'export';
  module: string;
  imported: string;
  local: string;
};

const PROJECT_ROOT = process.cwd();

function repositoryPath(path: string): string {
  return relative(PROJECT_ROOT, path).split(sep).join('/');
}

function typescriptFiles(relativeRoot: string): string[] {
  const root = join(PROJECT_ROOT, relativeRoot);
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
    }
  };
  walk(root);
  return files.sort((left, right) => repositoryPath(left).localeCompare(repositoryPath(right), 'en'));
}

function regularFiles(relativeRoot: string): string[] {
  const root = join(PROJECT_ROOT, relativeRoot);
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `${repositoryPath(path)} must not be a symlink`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  return files.sort((left, right) => repositoryPath(left).localeCompare(repositoryPath(right), 'en'));
}

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function moduleEdges(path: string): ModuleEdge[] {
  const file = repositoryPath(path);
  const edges: ModuleEdge[] = [];
  for (const statement of sourceFile(path).statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause === undefined) {
        edges.push({ file, kind: 'import', module, imported: '<side-effect>', local: '' });
        continue;
      }
      if (clause.name !== undefined) {
        edges.push({ file, kind: 'import', module, imported: 'default', local: clause.name.text });
      }
      const bindings = clause.namedBindings;
      if (bindings === undefined) continue;
      if (ts.isNamespaceImport(bindings)) {
        edges.push({ file, kind: 'import', module, imported: '*', local: bindings.name.text });
        continue;
      }
      for (const element of bindings.elements) {
        edges.push({
          file,
          kind: 'import',
          module,
          imported: (element.propertyName ?? element.name).text,
          local: element.name.text,
        });
      }
      continue;
    }
    if (ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression !== undefined
      && ts.isStringLiteral(statement.moduleReference.expression)) {
      edges.push({
        file,
        kind: 'import',
        module: statement.moduleReference.expression.text,
        imported: '*',
        local: statement.name.text,
      });
      continue;
    }
    if (!ts.isExportDeclaration(statement)
      || statement.moduleSpecifier === undefined
      || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    if (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause)) {
      edges.push({ file, kind: 'export', module, imported: '*', local: '*' });
      continue;
    }
    for (const element of statement.exportClause.elements) {
      edges.push({
        file,
        kind: 'export',
        module,
        imported: (element.propertyName ?? element.name).text,
        local: element.name.text,
      });
    }
  }
  return edges;
}

function dynamicModuleReferences(path: string): string[] {
  const references: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0]!)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        references.push(node.arguments[0]!.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile(path));
  return references;
}

function normalizedModule(module: string): string {
  return module.replaceAll('\\', '/').replace(/\.(?:[cm]?ts|[cm]?js)$/i, '').toLowerCase();
}

function moduleMatches(module: string, suffix: string): boolean {
  const normalized = normalizedModule(module);
  const normalizedSuffix = normalizedModule(suffix).replace(/^\/+/, '');
  return normalized === normalizedSuffix || normalized.endsWith(`/${normalizedSuffix}`);
}

function forbiddenBoundaryDependency(module: string): boolean {
  const normalized = normalizedModule(module);
  if (new Set([
    'child_process',
    'node:child_process',
    'dgram',
    'http',
    'https',
    'net',
    'node:dgram',
    'node:http',
    'node:https',
    'node:net',
    'process',
    'node:process',
    'node:fs',
    'node:fs/promises',
    'node:tls',
    'node:worker_threads',
    'tls',
    'undici',
    'worker_threads',
  ]).has(normalized)) return true;
  if (normalized === 'aws-sdk'
    || normalized.startsWith('aws-sdk/')
    || normalized.startsWith('@aws-sdk/')
    || normalized === 'pg'
    || normalized.startsWith('pg/')
    || normalized === 'postgres'
    || normalized.startsWith('postgres/')
    || normalized === 'postgres.js'
    || normalized.startsWith('postgres.js/')
    || normalized === 'openai'
    || normalized.startsWith('openai/')
    || normalized === '@neondatabase/serverless'
    || normalized.startsWith('@neondatabase/serverless/')) return true;
  const forbiddenExactSegment = new Set(['brain', 'persistence', 'postgres', 'postgresql', 'search']);
  if (normalized.split('/').some((segment) => forbiddenExactSegment.has(segment))) return true;
  const forbiddenSegment = /(?:^|-)(?:credential|credentials|env|env-merge|provider|providers|mcp|browser|router|routing|health|health-check|result-gate|result-gates)(?:-|$)/;
  return normalized.split('/').some((segment) => forbiddenSegment.test(segment));
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function exportedNames(path: string): string[] {
  const names: string[] = [];
  for (const statement of sourceFile(path).statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (ts.isNamespaceExport(statement.exportClause)) names.push('*');
      else {
        for (const element of statement.exportClause.elements) {
          names.push((element.propertyName ?? element.name).text, element.name.text);
        }
      }
      continue;
    }
    if (!hasExportModifier(statement)) continue;
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && statement.name !== undefined) names.push(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement)) && statement.name !== undefined) names.push(statement.name.text);
  }
  return names;
}

function declaringFiles(files: readonly string[], name: string): string[] {
  return files.filter((path) => {
    let declared = false;
    const visit = (node: ts.Node): void => {
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
        && node.name?.text === name) declared = true;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
        declared = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile(path));
    return declared;
  }).map(repositoryPath);
}

function importers(
  files: readonly string[],
  moduleSuffix: string,
  importedName: string,
): Array<{ file: string; local: string }> {
  return files.flatMap((path) => moduleEdges(path)
    .filter((edge) => edge.kind === 'import'
      && moduleMatches(edge.module, moduleSuffix)
      && edge.imported === importedName)
    .map((edge) => ({ file: edge.file, local: edge.local })));
}

function unwrapCallTarget(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

function importedCallSites(
  files: readonly string[],
  moduleSuffix: string,
  importedName: string,
): Array<{ file: string; calls: number }> {
  const sites: Array<{ file: string; calls: number }> = [];
  for (const path of files) {
    const locals = new Set(importers([path], moduleSuffix, importedName).map((entry) => entry.local));
    if (locals.size === 0) continue;
    let calls = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const target = unwrapCallTarget(node.expression);
        if (ts.isIdentifier(target) && locals.has(target.text)) calls++;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile(path));
    sites.push({ file: repositoryPath(path), calls });
  }
  return sites;
}

function callOptionKeys(path: string, calleeName: string): string[][] {
  const options: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = unwrapCallTarget(node.expression);
      if (ts.isIdentifier(target) && target.text === calleeName) {
        const value = node.arguments[3];
        if (!ts.isObjectLiteralExpression(value)) {
          options.push([]);
        } else {
          options.push(value.properties.flatMap((property) => {
            const name = property.name;
            return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))
              ? [name.text]
              : [];
          }).sort());
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile(path));
  return options;
}

test('context boundary classifier rejects legacy Brain, search, persistence, and provider clients', () => {
  const forbidden = [
    '../brain/query.ts',
    '../lib/brain/search.ts',
    '../persistence/postgres/stores.ts',
    '@aws-sdk/client-s3',
    '@neondatabase/serverless',
    'aws-sdk',
    'openai',
    'pg',
    'postgres',
  ];
  assert.deepEqual(forbidden.filter((module) => !forbiddenBoundaryDependency(module)), []);
  assert.deepEqual([
    './workspace-diagnostics.ts',
    './workspace-registry.ts',
    './workspace-tool-use.ts',
    'node:crypto',
  ].filter(forbiddenBoundaryDependency), []);
});

test('legacy Brain access stays behind the finite pre-#383 production boundary', () => {
  const sourceFiles = typescriptFiles('src');
  const edges = sourceFiles.flatMap((path) => moduleEdges(path));

  assert.deepEqual(
    edges.filter((edge) => moduleMatches(edge.module, 'brain/import')),
    [],
    'the disabled legacy import implementation must have no production importer or re-export',
  );
  assert.deepEqual(
    sourceFiles.flatMap((path) => dynamicModuleReferences(path)
      .filter((module) => moduleMatches(module, 'brain/import'))
      .map((module) => `${repositoryPath(path)}:${module}`)),
    [],
    'the disabled legacy import implementation must not be loaded dynamically',
  );

  const rawBrainHelpers = new Set(['createBrainPool', 'resolveBrainUrl', 'withBrainClient']);
  assert.deepEqual(
    edges.filter((edge) => (
      edge.kind === 'import'
      && (moduleMatches(edge.module, 'brain/connect')
        || (edge.file.startsWith('src/lib/brain/') && moduleMatches(edge.module, 'connect')))
      && (rawBrainHelpers.has(edge.imported) || edge.imported === '*')
    )).map(({ file, imported, local }) => ({ file, imported, local })),
    [
      { file: 'src/lib/brain/reindex.ts', imported: 'withBrainClient', local: 'withBrainClient' },
    ],
    'reindex.ts is orphaned on disk until #363 removes it; no production caller may bypass workspace authority',
  );

  const authorityBoundaryFiles = new Set([
    'src/lib/brain/connect.ts',
    'src/lib/brain/workspace-authority.ts',
  ]);
  assert.deepEqual(
    edges.filter((edge) => authorityBoundaryFiles.has(edge.file)
      && new Set(['buildRuntimeUrl', 'ensureRuntimeRole', 'randomBytes']).has(edge.imported))
      .map(({ file, module, imported }) => ({ file, module, imported })),
    [],
    'the workspace authority path must consume host credentials, never mint or reconstruct them',
  );

  // #383 kept both helpers on disk (22 test files use them as fixtures) but made
  // them provably unreachable from production, which is strictly stronger than
  // deleting them by hand. Removal is #363's.
  assert.deepEqual(
    edges.filter((edge) => new Set(['buildRuntimeUrl', 'ensureRuntimeRole']).has(edge.imported))
      .map(({ file, imported }) => ({ file, imported })),
    [],
    'buildRuntimeUrl and ensureRuntimeRole are test fixtures; no src/** module may import them',
  );

  // AC-3: doctor may inspect protected metadata but must never touch object
  // storage. Asserted structurally so the report fields cannot drift from truth.
  assert.deepEqual(
    moduleEdges(join(PROJECT_ROOT, 'src/lib/brain/doctor.ts'))
      .filter((edge) => edge.module.startsWith('@aws-sdk/') || moduleMatches(edge.module, 'brain/s3'))
      .map(({ module }) => module),
    [],
    'brain doctor must construct no object-storage client',
  );

  // #355 EVALUATED reusing this predicate for `roster context` and DECLINED it:
  // the helper performs its own unsnapshotted `readRegistryText`, outside the
  // context read capability's session and outside `capability.verify`, which
  // would reintroduce a TOCTOU window between the activation decision and the
  // bundle's `workspace.source_hash`. The two paths also implement opposite
  // precedence rules on purpose (structural probe first vs. strict parse
  // first), pinned as a six-row conformance matrix in
  // `test/workspace-context.test.ts`. The predicate must still stay free of
  // every client the context boundary classifier forbids — both paths refuse a
  // partial declaration before contacting any store.
  assert.deepEqual(
    moduleEdges(join(PROJECT_ROOT, 'src/lib/brain-activation-config.ts'))
      .filter((edge) => edge.module === 'pg'
        || edge.module.startsWith('@aws-sdk/')
        || moduleMatches(edge.module, 'persistence/pool')
        || normalizedModule(edge.module).split('/').includes('brain'))
      .map(({ module }) => module),
    [],
    'the shared Brain activation predicate must import no database, object-storage, or src/lib/brain module',
  );
});

test('tool-use and vendor-skill boundary modules depend only on inert validation and workspace primitives', () => {
  const vendorFiles = typescriptFiles('src/lib/vendor-skills');
  assert.ok(vendorFiles.length > 0, 'vendor-skills boundary must remain represented in this test');
  const files = [
    join(PROJECT_ROOT, 'src/commands/context.ts'),
    join(PROJECT_ROOT, 'src/lib/authored-secret-detector.ts'),
    join(PROJECT_ROOT, 'src/lib/context-args.ts'),
    join(PROJECT_ROOT, 'src/lib/workspace-context.ts'),
    join(PROJECT_ROOT, 'src/lib/workspace-tool-use.ts'),
    join(PROJECT_ROOT, 'src/lib/internal/workspace-tool-use-snapshot.ts'),
    join(PROJECT_ROOT, 'src/lib/internal/workspace-update-lock.ts'),
    ...vendorFiles,
  ];
  // #352: `src/commands/context.ts` is the composition root that wires the Brain
  // retrieval adapter into the pure assembler. Exactly ONE allowlisted triple;
  // every other ban still applies to it, and `src/lib/workspace-context.ts`
  // stays in the forbidden set with zero exceptions.
  const allowedBrainEdges = [{
    file: 'src/commands/context.ts',
    module: '../lib/brain/context-retrieval.ts',
    imported: 'retrieveBrainContextEvidence',
  }];
  const allowedBrainEdge = (edge: { file: string; module: string; imported: string }): boolean =>
    allowedBrainEdges.some((allowed) => allowed.file === edge.file
      && allowed.module === edge.module
      && allowed.imported === edge.imported);
  const violations: string[] = [];
  for (const path of files) {
    for (const edge of moduleEdges(path)) {
      if (forbiddenBoundaryDependency(edge.module) && !allowedBrainEdge(edge)) {
        violations.push(`${edge.file}: forbidden ${edge.kind} '${edge.module}'`);
      }
      if (edge.kind === 'import' && edge.imported === 'hashSkillDir') {
        violations.push(`${edge.file}: imports unsafe legacy hashSkillDir from '${edge.module}'`);
      }
      if (edge.kind === 'import'
        && edge.imported === '*'
        && moduleMatches(edge.module, 'founder-skills/lockfile')) {
        violations.push(`${edge.file}: namespace-imports the legacy founder-skill lock helper surface`);
      }
    }
    for (const module of dynamicModuleReferences(path)) {
      violations.push(`${repositoryPath(path)}: dynamic module dependency '${module}'`);
    }
  }
  assert.deepEqual(violations, []);

  // The composition root is the retriever module's SOLE production importer.
  assert.deepEqual(
    typescriptFiles('src')
      .flatMap((path) => moduleEdges(path))
      .filter((edge) => moduleMatches(edge.module, 'brain/context-retrieval'))
      .map(({ file, imported }) => ({ file, imported })),
    [{ file: 'src/commands/context.ts', imported: 'retrieveBrainContextEvidence' }],
  );
  // The pure assembler keeps zero forbidden edges, allowlist or not.
  assert.deepEqual(
    moduleEdges(join(PROJECT_ROOT, 'src/lib/workspace-context.ts'))
      .filter((edge) => forbiddenBoundaryDependency(edge.module))
      .map(({ module }) => module),
    [],
  );
});

test('complete workspace snapshots have one internal mint and one registry-owned importer', () => {
  const files = [...typescriptFiles('src'), ...typescriptFiles('test')];
  const sourceFiles = typescriptFiles('src');
  const snapshotModule = 'internal/workspace-tool-use-snapshot';
  const mint = 'mintCompleteWorkspaceSnapshot';

  assert.deepEqual(declaringFiles(sourceFiles, mint), [
    'src/lib/internal/workspace-tool-use-snapshot.ts',
  ]);
  assert.deepEqual(importers(files, snapshotModule, mint), [{
    file: 'src/lib/workspace-registry.ts',
    local: mint,
  }]);
  assert.deepEqual(
    files.flatMap((path) => moduleEdges(path)).filter((edge) =>
      edge.kind === 'import' && edge.imported === '*' && moduleMatches(edge.module, snapshotModule)
    ),
    [],
  );
  assert.deepEqual(
    sourceFiles.filter((path) => exportedNames(path).includes(mint)).map(repositoryPath),
    ['src/lib/internal/workspace-tool-use-snapshot.ts'],
  );
  assert.deepEqual(
    files.flatMap((path) => moduleEdges(path)).filter((edge) =>
      edge.kind === 'export'
      && moduleMatches(edge.module, snapshotModule)
      && (edge.imported === mint || edge.imported === '*')
    ),
    [],
  );
  assert.deepEqual(
    files.flatMap((path) => dynamicModuleReferences(path)
      .filter((module) => moduleMatches(module, snapshotModule))
      .map((module) => `${repositoryPath(path)}:${module}`)),
    [],
  );
});

test('prepared context sources and their read capability have one production and exactly two test importers', () => {
  const sourceFiles = typescriptFiles('src');
  const testFiles = typescriptFiles('test');
  const files = [...sourceFiles, ...testFiles];
  const registryModule = 'workspace-registry';
  const registryPath = join(PROJECT_ROOT, 'src/lib/workspace-registry.ts');
  const capability = 'withContextReadCapability';
  const asyncCapability = 'withAsyncContextReadCapability';
  const protectedNames = new Set([
    capability,
    asyncCapability,
    'assertPreparedContextSource',
    'PreparedContextSource',
    'PreparedContextRegistryMetadata',
    'ContextReadCapability',
    'ContextVendorSkillSelection',
    'ContextVendorSkillProjection',
  ]);

  assert.deepEqual(declaringFiles(sourceFiles, capability), [
    'src/lib/workspace-registry.ts',
  ]);
  // #352: the awaited entry point shares one body with the synchronous one and
  // is pinned to the same single production importer.
  assert.deepEqual(declaringFiles(sourceFiles, asyncCapability), [
    'src/lib/workspace-registry.ts',
  ]);
  assert.deepEqual(importers(sourceFiles, registryModule, asyncCapability), [{
    file: 'src/lib/workspace-context.ts',
    local: asyncCapability,
  }]);
  assert.deepEqual(declaringFiles(sourceFiles, 'PREPARED_CONTEXT_SOURCE'), [
    'src/lib/workspace-registry.ts',
  ]);
  assert.equal(exportedNames(registryPath).includes('PREPARED_CONTEXT_SOURCE'), false);
  assert.deepEqual(importers(sourceFiles, registryModule, capability), [{
    file: 'src/lib/workspace-context.ts',
    local: capability,
  }]);
  assert.deepEqual(importers(testFiles, registryModule, capability), [
    {
      file: 'test/support/seeded-workspace-context.ts',
      local: capability,
    },
    {
      file: 'test/workspace-context.test.ts',
      local: capability,
    },
  ]);

  const protectedEdges = files.flatMap((path) => moduleEdges(path)).filter((edge) => (
    moduleMatches(edge.module, registryModule)
    && (protectedNames.has(edge.imported) || edge.imported === '*')
  ));
  assert.deepEqual(
    [...new Set(protectedEdges
      .filter((edge) => edge.file.startsWith('src/'))
      .map((edge) => edge.file))],
    ['src/lib/workspace-context.ts'],
  );
  assert.deepEqual(
    [...new Set(protectedEdges
      .filter((edge) => edge.file.startsWith('test/'))
      .map((edge) => edge.file))],
    ['test/support/seeded-workspace-context.ts', 'test/workspace-context.test.ts'],
  );
  assert.deepEqual(
    protectedEdges.filter((edge) => edge.kind === 'export'),
    [],
  );
  assert.deepEqual(
    files.flatMap((path) => dynamicModuleReferences(path)
      .filter((module) => moduleMatches(module, registryModule))
      .map((module) => `${repositoryPath(path)}:${module}`)),
    [],
  );
});

test('the seeded host learning proof cannot become a shipped capability or source dependency', () => {
  const forbiddenMarkers = [
    'host-led-learning',
    'roster-350-fixture',
    'seeded-learning-store',
    'seeded-workspace-context',
  ];
  const sourceMentions = typescriptFiles('src').flatMap((path) => {
    const content = readFileSync(path, 'utf8').toLowerCase();
    return forbiddenMarkers
      .filter((marker) => content.includes(marker))
      .map((marker) => `${repositoryPath(path)}:${marker}`);
  });
  assert.deepEqual(sourceMentions, []);

  const packageFiles = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
    files?: unknown;
  };
  assert.ok(Array.isArray(packageFiles.files));
  assert.deepEqual(
    packageFiles.files.filter((entry): entry is string => typeof entry === 'string')
      .filter((entry) => entry === 'test' || entry.startsWith('test/')),
    [],
  );
});

test('host certification uses ambient auth and truthfully bounds transient personal-state handling', () => {
  const supportPath = join(PROJECT_ROOT, 'test/support/host-led-learning-certification.ts');
  const contractPath = join(
    PROJECT_ROOT,
    'test/fixtures/host-led-learning/common/host-launch-contract.json',
  );
  const support = readFileSync(supportPath, 'utf8');
  const contractBytes = readFileSync(contractPath, 'utf8');
  const contract = JSON.parse(contractBytes) as {
    schema_version?: unknown;
    certification_profile?: unknown;
  };

  for (const forbidden of [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
  ]) {
    assert.equal(contractBytes.includes(forbidden), false, forbidden);
  }
  for (const forbidden of [
    'roster-certification-openai',
    'roster-model-free-probe',
    'requires_openai_auth',
    'managed_settings_sha256',
  ]) assert.equal(support.includes(forbidden), false, forbidden);
  assert.doesNotMatch(support, /\bhostApiKey\b|\bapiKey\b/u);
  assert.doesNotMatch(support, /\.\.\.process\.env/u);
  assert.doesNotMatch(support, /env\[['"](?:ANTHROPIC_API_KEY|OPENAI_API_KEY)['"]\]\s*=/u);
  assert.doesNotMatch(support, /['"]model_provider=[^'"]+['"]/u);
  assert.match(support, /function sanitizeClaudeAuthStatus[\s\S]+logged_in:\s*true[\s\S]+model_api_key_injected:\s*false/u);
  assert.match(support, /function sanitizeCodexLoginStatus[\s\S]+Logged in using ChatGPT/u);
  assert.match(support, /trace\.initialization\['apiKeySource'\]\s*!==\s*'none'/u);
  assert.match(support, /effective\['model_provider'\]\s*!==\s*null/u);
  assert.match(support, /stdout_sha256:\s*sha256\(stdout\)/u);
  assert.match(support, /stderr_sha256:\s*sha256\(stderr\)/u);

  const codexConfigBody = /function codexConfigArgs\([\s\S]+?\n\}\n\nexport function codexGlobalLaunchArgs/u.exec(support)?.[0];
  assert.ok(codexConfigBody !== undefined);
  assert.doesNotMatch(codexConfigBody, /model_provider|model_providers|OPENAI_API_KEY/u);
  assert.doesNotMatch(codexConfigBody, /shell_environment_policy\.set\.CODEX_HOME/u);

  const claudePermissionsBody = /function claudeAllowedSkillPermissions\([\s\S]+?\n\}\n\nfunction lstatIfPresent/u.exec(support)?.[0];
  assert.ok(claudePermissionsBody !== undefined);
  assert.match(claudePermissionsBody, /contract\.claude\.skills\.map\(\(skill\) => skill\.identity\)/u);
  assert.match(claudePermissionsBody, /`Skill\(\$\{identity\}\)`/u);
  const claudeSettingsBody = /function writeClaudeSettings\([\s\S]+?\n\}\n\nfunction claudeArgs/u.exec(support)?.[0];
  assert.ok(claudeSettingsBody !== undefined);
  assert.match(claudeSettingsBody, /allowWrite:\s*\[workspace,\s*\.\.\.isolatedRoots\]/u);
  assert.doesNotMatch(claudeSettingsBody, /ambientHome|hostStateHome|CODEX_HOME/u);

  const claudeCanaryBody = /function assertClaudeSandboxProof\([\s\S]+?\n\}\n\nfunction cleanupClaudeSandboxCanaryAfterFailure[\s\S]+?\n\}/u.exec(support)?.[0];
  assert.ok(claudeCanaryBody !== undefined);
  assert.match(claudeCanaryBody, /precondition_sha256/u);
  assert.match(claudeCanaryBody, /isSymbolicLink\(\)|!\w+\.isFile\(\)/u);
  assert.match(claudeCanaryBody, /rmSync\(probe\.outsidePath\)/u);
  assert.equal(contract.schema_version, 2);
  assert.deepEqual(contract.certification_profile, {
    id: 'ambient-auth-v1',
    authentication: {
      claude: {
        mode: 'host-managed',
        provider: 'claude.ai',
        source: 'firstParty',
        model_api_key_injected: false,
      },
      codex: {
        mode: 'host-managed',
        provider: 'chatgpt',
        model_api_key_injected: false,
      },
    },
    external_host_state: {
      policy: 'accepted-unpinned',
      paid_session_scope: 'auth-cache-only',
      copied: false,
      recursive_scan: false,
      transient_inspection: true,
      transient_output_hashing: true,
      raw_personal_state_persisted: false,
      personal_state_authority: false,
    },
  });
  assert.doesNotMatch(contractBytes, /"(?:scanned|hashed|persisted)"\s*:\s*false/u);
  assert.doesNotMatch(contractBytes, /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/])/u);
});

test('host-led fixture skills are byte-identical and cannot leak the semantic answer or oracle', () => {
  const fixtureRoot = 'test/fixtures/host-led-learning';
  const skillCopies = [
    [
      'common/skills/fake-social-search/SKILL.md',
      'claude-plugin/skills/roster-350-fixture-learning-loop/SKILL.md',
      'codex-project/.agents/skills/roster-350-fixture-learning-loop/SKILL.md',
    ],
    [
      'common/skills/dreamer/SKILL.md',
      'claude-plugin/skills/fixture-dreamer/SKILL.md',
      'codex-project/.agents/skills/fixture-dreamer/SKILL.md',
    ],
  ];
  for (const [canonical, ...delivered] of skillCopies) {
    const canonicalBytes = readFileSync(join(PROJECT_ROOT, fixtureRoot, canonical!));
    for (const path of delivered) {
      assert.deepEqual(readFileSync(join(PROJECT_ROOT, fixtureRoot, path)), canonicalBytes, path);
    }
  }
  const primarySkill = readFileSync(join(
    PROJECT_ROOT,
    fixtureRoot,
    'common/skills/fake-social-search/SKILL.md',
  ), 'utf8');
  assert.ok(Buffer.byteLength(primarySkill, 'utf8') <= 5_200);
  for (const marker of [
    'raw_context_sha256 is already complete',
    'target=[agentOrPlanQualifiedId,agentH]',
    'target agent=before #',
    'For false D slots only',
    'effects null=unset|[]=deny-all|items=ceiling',
    'qualified ID=<scope-or-target>/tools/<id>',
    'Never omit a plan step or',
  ]) {
    assert.match(primarySkill, new RegExp(marker.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  const dreamerSkill = readFileSync(join(
    PROJECT_ROOT,
    fixtureRoot,
    'common/skills/dreamer/SKILL.md',
  ), 'utf8');
  assert.doesNotMatch(dreamerSkill, /--recommendation|--falsifiable-by/u);
  const candidateCommand = /`roster-350-fixture-candidate-create[^`]+`/u.exec(dreamerSkill)?.[0];
  assert.equal(typeof candidateCommand, 'string');
  assert.doesNotMatch(candidateCommand!, /[\r\n\\]/u);
  for (const option of [
    'prefer',
    'avoid',
    'attributable-practitioner',
    'profile-page',
    'anonymous-source',
    'operational-problem',
    'crypto-promotion',
    'generic-ad',
    'reject',
    'retain',
    'reviewed-outcomes-contradict',
    'reviewed-outcomes-confirm',
    'no-counterevidence',
  ]) assert.match(dreamerSkill, new RegExp(`\\b${option}\\b`, 'u'));
  for (const orderedChoices of [
    'disposition: `avoid` or `prefer`',
    'source kind: `anonymous-source`, `profile-page`, or `attributable-practitioner`',
    'topic kind: `operational-problem`, `generic-ad`, or `crypto-promotion`',
    'falsifier action: `reject` or `retain`',
    'falsifier observation: `no-counterevidence`,\n  `reviewed-outcomes-contradict`, or `reviewed-outcomes-confirm`',
  ]) assert.equal(dreamerSkill.includes(orderedChoices), true);

  const launchContract = JSON.parse(readFileSync(join(
    PROJECT_ROOT,
    fixtureRoot,
    'common/host-launch-contract.json',
  ), 'utf8')) as {
    adapters: { command: string; required_flags: string[] }[];
    host_readable_inputs: Record<string, string>;
    runtime: { workspace_entries: { common: { source: string; destination: string }[] } };
  };
  assert.equal('output_schema' in launchContract.host_readable_inputs, false);
  assert.equal('lifecycle' in launchContract.host_readable_inputs, false);
  assert.equal(launchContract.runtime.workspace_entries.common.some((entry) => (
    entry.source === 'common/fixture-lifecycle.md'
    || entry.destination === '.fixture/fixture-lifecycle.md'
  )), false);
  assert.equal(existsSync(join(PROJECT_ROOT, fixtureRoot, 'common/fixture-lifecycle.md')), false);
  assert.equal(
    launchContract.host_readable_inputs['discover_output_schema'],
    'common/discover-output-schema.json',
  );
  assert.equal(
    launchContract.host_readable_inputs['approve_output_schema'],
    'common/approve-output-schema.json',
  );
  const discoverOutputSchema = JSON.parse(readFileSync(join(
    PROJECT_ROOT,
    fixtureRoot,
    'common/discover-output-schema.json',
  ), 'utf8')) as {
    properties: Record<string, { items: { required: string[]; properties: Record<string, { enum?: string[] }> } }>;
  };
  const selectedDecision = discoverOutputSchema.properties['selected_results']!.items;
  const rejectedDecision = discoverOutputSchema.properties['rejected_results']!.items;
  const neutralResultCodes = [
    'previously-used',
    'attributable-practitioner-problem',
    'untrusted-instruction',
    'cryptocurrency',
    'profile-or-homepage',
  ];
  assert.deepEqual(selectedDecision.required, ['result_id', 'canonical_url', 'relevance_code']);
  assert.deepEqual(selectedDecision.properties['relevance_code']?.enum, neutralResultCodes);
  assert.deepEqual(rejectedDecision.required, ['result_id', 'policy_code']);
  assert.deepEqual(rejectedDecision.properties['policy_code']?.enum, neutralResultCodes);
  const expectedResultCodeIndexes = [
    'attributable-practitioner-problem',
    'profile-or-homepage',
    'cryptocurrency',
    'previously-used',
    'untrusted-instruction',
  ].map((code) => neutralResultCodes.indexOf(code));
  assert.deepEqual([...new Set(expectedResultCodeIndexes)].sort(), [0, 1, 2, 3, 4]);
  const meaningChoices = (discoverOutputSchema as unknown as {
    properties: {
      learning: {
        properties: {
          candidate: {
            properties: {
              meaning: { properties: Record<string, { enum: string[] }> };
            };
          };
        };
      };
    };
  }).properties.learning.properties.candidate.properties.meaning.properties;
  const approveOutputSchema = JSON.parse(readFileSync(join(
    PROJECT_ROOT,
    fixtureRoot,
    'common/approve-output-schema.json',
  ), 'utf8')) as typeof discoverOutputSchema;
  const approveMeaningChoices = (approveOutputSchema as unknown as {
    properties: {
      learning: {
        properties: {
          candidate: {
            properties: {
              meaning: { properties: Record<string, { enum: string[] }> };
            };
          };
        };
      };
    };
  }).properties.learning.properties.candidate.properties.meaning.properties;
  const expectedMeaningChoices: Record<string, string[]> = {
    disposition: ['avoid', 'prefer'],
    source_kind: ['anonymous-source', 'profile-page', 'attributable-practitioner'],
    topic_kind: ['operational-problem', 'generic-ad', 'crypto-promotion'],
    falsifier_action: ['reject', 'retain'],
    falsifier_observation: [
      'no-counterevidence',
      'reviewed-outcomes-contradict',
      'reviewed-outcomes-confirm',
    ],
  };
  assert.deepEqual(
    Object.fromEntries(Object.keys(expectedMeaningChoices).map((field) => [
      field,
      meaningChoices[field]?.enum,
    ])),
    expectedMeaningChoices,
  );
  assert.deepEqual(
    Object.fromEntries(Object.keys(expectedMeaningChoices).map((field) => [
      field,
      approveMeaningChoices[field]?.enum,
    ])),
    expectedMeaningChoices,
  );
  const acceptedMeaning: Record<string, string> = {
    disposition: 'prefer',
    source_kind: 'attributable-practitioner',
    topic_kind: 'operational-problem',
    falsifier_action: 'reject',
    falsifier_observation: 'reviewed-outcomes-contradict',
  };
  const orderedMeaningFields = Object.keys(expectedMeaningChoices);
  const acceptedIndexes = orderedMeaningFields.map((field) => (
    expectedMeaningChoices[field]!.indexOf(acceptedMeaning[field]!)
  ));
  assert.deepEqual(acceptedIndexes, [1, 2, 0, 0, 1]);
  assert.notDeepEqual(acceptedIndexes, [...acceptedIndexes].reverse());
  assert.deepEqual([...new Set(acceptedIndexes)].sort(), [0, 1, 2]);
  const ordinalHeuristics = {
    first: orderedMeaningFields.map(() => 0),
    lower_middle: orderedMeaningFields.map((field) => (
      Math.floor((expectedMeaningChoices[field]!.length - 1) / 2)
    )),
    upper_middle: orderedMeaningFields.map((field) => (
      Math.floor(expectedMeaningChoices[field]!.length / 2)
    )),
    last: orderedMeaningFields.map((field) => expectedMeaningChoices[field]!.length - 1),
  };
  for (const [heuristic, indexes] of Object.entries(ordinalHeuristics)) {
    assert.equal(
      acceptedIndexes.every((index, fieldIndex) => index === indexes[fieldIndex]),
      false,
      `${heuristic} must not yield every accepted candidate value`,
    );
  }
  for (let index = 0; index <= Math.max(...acceptedIndexes); index++) {
    assert.equal(
      acceptedIndexes.every((acceptedIndex) => acceptedIndex === index),
      false,
      `same index ${index} must not yield every accepted candidate value`,
    );
  }
  const candidateAdapter = launchContract.adapters.find((entry) => (
    entry.command === 'roster-350-fixture-candidate-create'
  ));
  assert.deepEqual(candidateAdapter?.required_flags, [
    '--run-id',
    '--feedback-id',
    '--disposition',
    '--source-kind',
    '--topic-kind',
    '--falsifier-action',
    '--falsifier-observation',
    '--skill-challenge',
  ]);
  const promotionAdapter = launchContract.adapters.find((entry) => (
    entry.command === 'roster-350-fixture-candidate-promote'
  ));
  assert.deepEqual(promotionAdapter?.required_flags, ['--candidate-id', '--candidate-hash']);

  const oracleMarkers = ['expected-semantic-result', 'host-led-learning-oracle'];
  const adapterPath = 'test/support/host-led-learning-adapter.ts';
  const oracleLeaks = regularFiles(fixtureRoot).flatMap((path) => {
    const content = readFileSync(path, 'utf8').toLowerCase();
    return oracleMarkers
      .filter((marker) => content.includes(marker))
      .map((marker) => `${repositoryPath(path)}:${marker}`);
  }).concat(oracleMarkers
    .filter((marker) => readFileSync(join(PROJECT_ROOT, adapterPath), 'utf8').toLowerCase().includes(marker))
    .map((marker) => `${adapterPath}:${marker}`));
  assert.deepEqual(oracleLeaks, []);

  const mechanicsOnly = [
    'common/host-launch-contract.json',
    'common/discover-output-schema.json',
    'common/approve-output-schema.json',
    ...skillCopies.flat(),
  ];
  const forbiddenAnswerMarkers = [
    'result-valid-practitioner',
    'result-profile',
    'result-crypto',
    'result-prior',
    'result-injection',
    'result-a17f',
    'result-b62c',
    'result-c04d',
    'result-d91e',
    'result-e38a',
    'brain-record-a17f',
    'brain-record-b62c',
    'brain-record-c04d',
    'brain-record-d91e',
    'candidate-opportunity-discovery-001',
    'prefer-attributable-practitioner-posts',
    'require a canonical public url',
    'exclude cryptocurrency topics',
    'reject profile and company-homepage urls',
    'exclude urls presented in prior discovery runs',
  ];
  const answerLeaks = [...mechanicsOnly.map((path) => ({
    label: path,
    absolute: join(PROJECT_ROOT, fixtureRoot, path),
  })), {
    label: adapterPath,
    absolute: join(PROJECT_ROOT, adapterPath),
  }].flatMap(({ label, absolute }) => {
    const content = readFileSync(absolute, 'utf8').toLowerCase();
    return forbiddenAnswerMarkers
      .filter((marker) => content.includes(marker)
        && !(label === adapterPath && marker === 'candidate-opportunity-discovery-001'))
      .map((marker) => `${label}:${marker}`);
  });
  assert.deepEqual(answerLeaks, []);

  const semanticRole = /(?:^|[-_.])(?:valid|winner|selected|profile|crypto|prior|injection|override|inert|canary|reject(?:ed)?)(?:[-_.]|$)/iu;
  const identifierLeaks: string[] = [];
  const visitIdentifiers = (value: unknown, path: string, inspectString = false): void => {
    if (typeof value === 'string') {
      if (inspectString && semanticRole.test(value)) identifierLeaks.push(`${path}:${value}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visitIdentifiers(entry, `${path}[${index}]`, inspectString));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      visitIdentifiers(
        child,
        `${path}.${key}`,
        /(?:^|_)(?:id|ids)$/u.test(key) || key === 'locator',
      );
    }
  };
  for (const path of ['common/fake-search-results.json', 'common/brain-evidence.json']) {
    visitIdentifiers(
      JSON.parse(readFileSync(join(PROJECT_ROOT, fixtureRoot, path), 'utf8')) as unknown,
      path,
    );
  }
  assert.deepEqual(identifierLeaks, []);
});

test('workspace update lock capability stays inside update and generated-artifact transaction seams', () => {
  const files = [...typescriptFiles('src'), ...typescriptFiles('test')];
  const lockModule = 'internal/workspace-update-lock';

  assert.deepEqual(importers(files, lockModule, 'withWorkspaceUpdateLock'), [{
    file: 'src/commands/update.ts',
    local: 'withWorkspaceUpdateLock',
  }]);
  assert.deepEqual(importedCallSites(files, lockModule, 'withWorkspaceUpdateLock'), [{
    file: 'src/commands/update.ts',
    calls: 1,
  }]);
  assert.deepEqual(importers(files, lockModule, 'assertWorkspaceUpdateLock'), [{
    file: 'src/lib/generated-artifacts.ts',
    local: 'assertWorkspaceUpdateLock',
  }]);
  assert.deepEqual(importedCallSites(files, lockModule, 'assertWorkspaceUpdateLock'), [{
    file: 'src/lib/generated-artifacts.ts',
    calls: 1,
  }]);
  assert.deepEqual(importers(files, lockModule, 'WorkspaceUpdateLockToken'), [{
    file: 'src/lib/generated-artifacts.ts',
    local: 'WorkspaceUpdateLockToken',
  }]);
  assert.deepEqual(
    files.flatMap((path) => moduleEdges(path)).filter((edge) =>
      moduleMatches(edge.module, lockModule) && (edge.kind === 'export' || edge.imported === '*')
    ),
    [],
  );

  const generatedModule = 'lib/generated-artifacts';
  const lockedUpdate = 'updateV2ProjectActivationsWithLockToken';
  assert.deepEqual(importers(files, generatedModule, lockedUpdate), [{
    file: 'src/commands/update.ts',
    local: lockedUpdate,
  }]);
  assert.deepEqual(importedCallSites(files, generatedModule, lockedUpdate), [{
    file: 'src/commands/update.ts',
    calls: 1,
  }]);

  const updatePath = join(PROJECT_ROOT, 'src/commands/update.ts');
  assert.deepEqual(callOptionKeys(updatePath, 'publishCreateOnly'), [[
    'captureCreation',
  ]]);
  assert.deepEqual(callOptionKeys(updatePath, 'removePublishedWorkspaceFile'), [[
    'maxBytes',
  ]]);
  assert.deepEqual(callOptionKeys(updatePath, 'replaceWorkspaceFile'), [
    ['capturePublication', 'expectedHash', 'maxBytes'],
    ['expectedHash', 'expectedIdentity', 'maxBytes'],
  ]);
});

test('generated adapter rendering stays isolated from runtime, Brain, scheduler, and approval modules', () => {
  const generatedPath = join(PROJECT_ROOT, 'src/lib/generated-artifacts.ts');
  const forbidden = [
    /(?:^|\/)brain(?:[-./]|$)/,
    /(?:^|\/)persistence(?:\/|$)/,
    /schedule/,
    /pending/,
    /(?:^|\/)ops(?:[-./]|$)/,
    /(?:^|\/)run(?:[-./]|$)/,
    /provider/,
    /router/,
    /approval/,
    /hitl/,
  ];
  for (const module of ['./brain-args.ts', './ops-args.ts', './run-args.ts']) {
    assert.equal(forbidden.some((pattern) => pattern.test(module)), true, module);
  }
  const violations = moduleEdges(generatedPath)
    .map((edge) => edge.module)
    .filter((module) => forbidden.some((pattern) => pattern.test(module)));
  assert.deepEqual(violations, []);
});

test('brain evidence DML stays in the evidence store and never reaches the record path object store', () => {
  const dml = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM)\s+brain_evidence\./iu;
  // Only the evidence store performs brain_evidence DML or content SELECT.
  // roles.ts and doctor.ts may name the schema in grant and audit statements.
  const allowed = new Map([
    ['src/lib/brain/evidence-store.ts', 'dml'],
    // #357: the Dreamer readiness read. It selects from brain_evidence and calls
    // the two admin-only dream state writers; the block below pins that it
    // performs no DML of its own and touches no #356 record broker.
    ['src/lib/brain/dream-readiness.ts', 'dml'],
    // #358: the candidate lifecycle. Both read from brain_evidence and call the
    // lifecycle brokers; neither issues INSERT/UPDATE/DELETE of its own -- every
    // write traverses a SECURITY DEFINER broker, exactly as #356 requires.
    ['src/lib/brain/dream-candidates.ts', 'dml'],
    ['src/lib/brain/lesson-materialize.ts', 'dml'],
    ['src/lib/brain/roles.ts', 'schema-name-only'],
    ['src/lib/brain/doctor.ts', 'schema-name-only'],
    // Names the SQL twin of its credential scan in a comment; issues no SQL.
    ['src/lib/brain/evidence-contracts.ts', 'schema-name-only'],
  ]);
  // The SQL SCHEMA reference, not the bare token: 'brain_evidence' is also a
  // context-bundle field name and a tripwire trust-source label.
  const schemaReference = /brain_evidence\.|SCHEMA brain_evidence/u;
  const offenders: string[] = [];
  for (const path of typescriptFiles('src')) {
    const relative = repositoryPath(path);
    const text = readFileSync(path, 'utf8');
    if (!schemaReference.test(text)) continue;
    const role = allowed.get(relative);
    if (role === undefined) {
      offenders.push(relative);
      continue;
    }
    if (role === 'schema-name-only') {
      assert.equal(dml.test(text), false, `${relative} must not perform brain_evidence DML`);
    }
  }
  assert.deepEqual(offenders, []);

  // The lifecycle modules read and call brokers; they never write directly.
  const writeDml = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+brain_evidence\./iu;
  for (const relative of ['src/lib/brain/dream-candidates.ts', 'src/lib/brain/lesson-materialize.ts']) {
    assert.equal(
      writeDml.test(readFileSync(join(PROJECT_ROOT, relative), 'utf8')),
      false,
      `${relative} must not perform brain_evidence DML`,
    );
  }

  const storePath = join(PROJECT_ROOT, 'src/lib/brain/evidence-store.ts');
  const store = readFileSync(storePath, 'utf8');
  assert.equal(dml.test(store), true);

  // The record verbs are pure Postgres: no object-store parameter anywhere on
  // the record path. Promotion is the only operation that ingests bytes.
  for (const verb of ['recordCompletedRun', 'recordRunArtifact', 'recordFeedback', 'recordHumanDecision']) {
    const start = store.indexOf(`export async function ${verb}(`);
    assert.notEqual(start, -1, verb);
    const signature = store.slice(start, store.indexOf('): Promise', start));
    assert.equal(/objectStore|BrainObjectStore/u.test(signature), false, verb);
  }
  assert.equal(/objectStore/u.test(store.slice(0, store.indexOf('export type PromoteEvidenceDeps'))), false);

  // Evidence modules never import the ops persistence tree (#362 deletes it).
  for (const module of [
    'src/lib/brain/evidence-contracts.ts',
    'src/lib/brain/evidence-identity.ts',
    'src/lib/brain/evidence-store.ts',
  ]) {
    const imported = moduleEdges(join(PROJECT_ROOT, module))
      .map((edge) => edge.module)
      .filter((specifier) => /(?:^|\/)persistence(?:\/|$)/u.test(specifier));
    assert.deepEqual(imported, [], module);
  }

  // Promotion is admin-path library-only: no CLI verb, no runtime broker.
  const brainArgs = readFileSync(join(PROJECT_ROOT, 'src/lib/brain-args.ts'), 'utf8');
  assert.equal(/promote/iu.test(brainArgs), false);
  const migration = readFileSync(join(PROJECT_ROOT, 'data/brain/schema/013_evidence_core.sql'), 'utf8');
  assert.equal(/CREATE FUNCTION brain_evidence\.(?:record_)?promote/iu.test(migration), false);

  // promoteEvidence is the ONLY evidence->semantic path: it alone calls the
  // source lifecycle, and it alone stamps promoted_from provenance. Asserted at
  // the call site, not by text search, so a quoted or dynamic reference cannot
  // slip an ingest past the boundary.
  // src/lib/brain/extraction.ts is #370's ingest-then-extract helper: a
  // separate subsystem that ingests ordinary company sources, never evidence.
  // It is allowlisted by name so a NEW unexpected importer still fails here.
  const NON_EVIDENCE_INGEST_CALLERS = ['src/lib/brain/extraction.ts'];
  const sourceFiles = [...typescriptFiles('src'), ...typescriptFiles('test')];
  const ingestImporters = importers(sourceFiles, 'source-lifecycle', 'ingestBrainSource')
    .filter((entry) => entry.file.startsWith('src/'));
  assert.deepEqual(
    ingestImporters.filter((entry) => !NON_EVIDENCE_INGEST_CALLERS.includes(entry.file)),
    [{ file: 'src/lib/brain/evidence-store.ts', local: 'ingestBrainSource' }],
  );
  const ingestCallSites = importedCallSites(sourceFiles, 'source-lifecycle', 'ingestBrainSource')
    .filter((entry) => entry.file.startsWith('src/'));
  assert.deepEqual(
    ingestCallSites.filter((entry) => !NON_EVIDENCE_INGEST_CALLERS.includes(entry.file)),
    [{ file: 'src/lib/brain/evidence-store.ts', calls: 1 }],
  );

  const promotionAt = store.indexOf('export async function promoteEvidence');
  assert.notEqual(promotionAt, -1);
  const ingestAt = store.indexOf('await ingestBrainSource(');
  assert.ok(ingestAt > promotionAt, 'ingestBrainSource is called outside promoteEvidence');
  const promotedFromSites = sourceFiles
    .filter((path) => repositoryPath(path).startsWith('src/'))
    .filter((path) => readFileSync(path, 'utf8').includes('promoted_from'))
    .map((path) => repositoryPath(path));
  assert.deepEqual(promotedFromSites, ['src/lib/brain/evidence-store.ts']);
  assert.ok(store.indexOf('promoted_from') > promotionAt, 'promoted_from is stamped outside promoteEvidence');
});

test('the dream readiness surface is a pure read with a deferred, deadlock-free observer', () => {
  const migrationPath = join(PROJECT_ROOT, 'data/brain/schema/014_dream_readiness.sql');
  const migration = readFileSync(migrationPath, 'utf8');
  // These modules deliberately DOCUMENT in prose what they refuse to build, so
  // every vocabulary assertion below runs against code with comments stripped.
  const withoutComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(?:\/\/|--)[^\n]*/gu, ' ');
  const migrationCode = withoutComments(migration);
  const dreamModules = [
    'src/lib/brain/dream-contracts.ts',
    'src/lib/brain/dream-readiness.ts',
    'src/lib/dream-args.ts',
    'src/commands/dream.ts',
  ];

  // #356 allowlists evidence-store.ts for brain_evidence DML; dream-readiness.ts
  // joins the allowlist for READS ONLY plus the two admin-only state writers.
  const readinessPath = join(PROJECT_ROOT, 'src/lib/brain/dream-readiness.ts');
  const readiness = readFileSync(readinessPath, 'utf8');
  const namedRelations = [...readiness.matchAll(/brain_evidence\.([a-z_]+)/gu)].map((m) => m[1]!);
  // #358 moved the eligible-set predicate into two server-side read functions
  // shared by this module and the candidate brokers, so readiness no longer
  // names the underlying evidence tables at all.
  assert.deepEqual([...new Set(namedRelations)].sort(), [
    'advance_dream_watermark',
    'dream_effective_policy',
    'dream_eligible',
    'dream_watermarks',
    'register_dream_policy',
  ]);
  // No DML against ANY #356 evidence table: readiness reads, it never records.
  assert.equal(
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+brain_evidence\./iu.test(readiness),
    false,
    'dream-readiness.ts must issue no brain_evidence DML',
  );
  for (const broker of ['record_completed_run', 'record_run_artifact', 'record_feedback', 'record_human_decision']) {
    assert.equal(readiness.includes(broker), false, broker);
  }

  // ONE statement, ONE snapshot. The only permitted alternative is an explicit
  // REPEATABLE READ wrapper, so a silently multi-statement read cannot slip in.
  const computeAt = readiness.indexOf('export async function computeDreamReadiness');
  assert.notEqual(computeAt, -1);
  const computeBody = readiness.slice(computeAt, readiness.indexOf('\n}\n', computeAt));
  assert.equal(computeBody.length > 200, true, 'computeDreamReadiness body was not isolated');
  const queryCalls = [...computeBody.matchAll(/pool\.query\s*(?:<[^>]*>)?\(/gu)].length;
  const repeatableRead = /ISOLATION LEVEL REPEATABLE READ/u.test(computeBody);
  assert.equal(queryCalls === 1 || repeatableRead, true, `computeDreamReadiness issues ${queryCalls} queries`);
  assert.equal(/pool\.connect\(/u.test(computeBody), false);

  // No scheduler, daemon, poller, or model invocation anywhere on the surface.
  for (const module of dreamModules) {
    const text = readFileSync(join(PROJECT_ROOT, module), 'utf8');
    assert.equal(
      /\b(?:cron|setInterval|setTimeout|setImmediate|daemon|polling|scheduler)\b/iu.test(text),
      false,
      `${module} names a scheduling primitive`,
    );
    const specifiers = moduleEdges(join(PROJECT_ROOT, module)).map((edge) => edge.module);
    for (const forbidden of [/child_process/u, /node:http/u, /node:net/u, /(?:^|\/)persistence(?:\/|$)/u]) {
      assert.equal(specifiers.some((specifier) => forbidden.test(specifier)), false, `${module} ${forbidden}`);
    }
  }

  // #358's POSITIVE contract, replacing the "not pre-built" assertion #357 held
  // here: the candidate ledger is named only by the modules that own it, and
  // readiness itself still names no candidate surface.
  assert.equal(
    /dream_candidates|dream_candidate_evidence|lesson_decisions/u.test(withoutComments(readiness)),
    false,
    'dream-readiness.ts must not reach into the candidate ledger',
  );
  const sourceFiles = typescriptFiles('src');
  const lifecycleOwners = [
    'src/lib/brain/dream-candidates.ts',
    'src/lib/brain/lesson-materialize.ts',
  ];
  const brokerNames = [
    'record_dream_candidate',
    'decide_lesson_candidate',
    'hold_dream_subject_lock',
    'verify_dream_subject_governor',
  ];
  // The grant list and the doctor's approved-signature audit necessarily NAME
  // the brokers; nothing else may CALL them.
  const grantAudits = ['src/lib/brain/roles.ts', 'src/lib/brain/doctor.ts'];
  for (const path of sourceFiles) {
    const relative = repositoryPath(path);
    if (!relative.startsWith('src/')) continue;
    if (lifecycleOwners.includes(relative) || grantAudits.includes(relative)) continue;
    const text = readFileSync(path, 'utf8');
    for (const broker of brokerNames) {
      assert.equal(text.includes(broker), false, `${relative} names ${broker}`);
    }
    assert.equal(
      text.includes(".roster/state/locks/dream-phase"),
      false,
      `${relative} names the dream-phase lock path`,
    );
    assert.equal(
      /SET LOCAL (?:idle_in_transaction_session_timeout|transaction_timeout)/u.test(text),
      false,
      `${relative} issues a fence timeout override`,
    );
  }
  const materialize = readFileSync(join(PROJECT_ROOT, 'src/lib/brain/lesson-materialize.ts'), 'utf8');
  assert.match(materialize, /SET LOCAL idle_in_transaction_session_timeout = 0/u);
  assert.match(materialize, /SET LOCAL transaction_timeout = 0/u);
  assert.match(materialize, /server_version_num/u);
  assert.match(materialize, /'\.roster\/state\/locks\/dream-phase'/u);

  // ONE injection gate, TWO importers: a divergent second copy would let a
  // candidate pass at promotion what the context bundle refuses at read.
  const gateOwners = sourceFiles
    .filter((path) => repositoryPath(path).startsWith('src/'))
    .filter((path) => readFileSync(path, 'utf8').includes('hasHostileBrainInstruction'))
    .map((path) => repositoryPath(path));
  assert.deepEqual(gateOwners.sort(), [
    'src/lib/brain/lesson-materialize.ts',
    'src/lib/context-injection-gate.ts',
    'src/lib/workspace-context.ts',
  ]);
  const gate = readFileSync(join(PROJECT_ROOT, 'src/lib/context-injection-gate.ts'), 'utf8');
  assert.match(gate, /export function hasHostileBrainInstruction/u);
  assert.equal(
    /function hasHostileBrainInstruction/u.test(
      readFileSync(join(PROJECT_ROOT, 'src/lib/workspace-context.ts'), 'utf8'),
    ),
    false,
    'workspace-context.ts must re-export the gate, never redefine it',
  );

  // B2: the deferral is a single keyword and the whole no-deadlock argument
  // rests on it. Both triggers are pinned by their exact declaration.
  for (const [name, table, argument] of [
    ['completed_runs_observed', 'completed_runs', "'completed-run', 'run_id'"],
    ['feedback_observed', 'feedback', "'feedback', 'feedback_id'"],
  ] as const) {
    const declaration = new RegExp(
      `CREATE CONSTRAINT TRIGGER ${name}\\s+AFTER INSERT ON brain_evidence\\.${table}\\s+`
        + `DEFERRABLE INITIALLY DEFERRED\\s+FOR EACH ROW EXECUTE FUNCTION `
        + `brain_evidence\\.observe_evidence\\(${argument.replace(/'/gu, "'")}\\)`,
      'u',
    );
    assert.match(migration, declaration);
  }
  // The commit barrier itself: the ordinal is drawn under the global
  // transaction-scoped advisory lock inside observe_evidence, never elsewhere.
  const observerAt = migration.indexOf('CREATE FUNCTION brain_evidence.observe_evidence()');
  assert.notEqual(observerAt, -1);
  const observerBody = migration.slice(observerAt, migration.indexOf('CREATE CONSTRAINT TRIGGER', observerAt));
  assert.match(observerBody, /pg_advisory_xact_lock\(\s*brain_evidence\.lock_key\('roster\.brain\.evidence\.lock\.observation\.v1'/u);
  assert.match(observerBody, /nextval\('brain_evidence\.evidence_observation_ordinal_seq'\)/u);
  assert.equal([...migrationCode.matchAll(/nextval\(/gu)].length, 1, 'only observe_evidence draws an ordinal');

  // 014 declares exactly one SECURITY DEFINER function, names it, and grants
  // EXECUTE to no role at all.
  const definers = [...migration.matchAll(/CREATE FUNCTION brain_evidence\.([a-z_]+)\([^)]*\)[\s\S]*?(?=\nAS \$fn\$|\n#variable_conflict|\nDECLARE|\nBEGIN)/gu)]
    .filter((match) => /SECURITY DEFINER/u.test(match[0]!))
    .map((match) => match[1]!);
  assert.deepEqual(definers, ['observe_evidence']);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION brain_evidence\.observe_evidence\(\) FROM PUBLIC/u);
  assert.equal(/\bGRANT\b/iu.test(migrationCode), false, '014 grants nothing to any role');
  assert.match(
    migration,
    /REVOKE ALL PRIVILEGES ON SEQUENCE brain_evidence\.evidence_observation_ordinal_seq FROM PUBLIC/u,
  );

  // B2's retry contract rests on Roster never batching: one broker call per
  // autocommit transaction means one rank-1 lock per transaction.
  const storeText = readFileSync(join(PROJECT_ROOT, 'src/lib/brain/evidence-store.ts'), 'utf8');
  assert.equal(/'BEGIN'|"BEGIN"|`BEGIN`|'COMMIT'|"COMMIT"|`COMMIT`/u.test(storeText), false);
  const brokerAt = storeText.indexOf('async function callBroker(');
  assert.notEqual(brokerAt, -1);
  assert.match(storeText.slice(brokerAt, storeText.indexOf('\n}', brokerAt)), /await pool\.query</u);

  // The B3 doctor clause: sequences in brain_evidence are audited by the
  // exact-privilege check, whose generic sibling is scoped to nspname = 'brain'.
  const doctorText = readFileSync(join(PROJECT_ROOT, 'src/lib/brain/doctor.ts'), 'utf8');
  const evidenceCheckAt = doctorText.indexOf("'brain-evidence-append-only'");
  assert.notEqual(evidenceCheckAt, -1);
  const evidenceCheck = doctorText.slice(evidenceCheckAt, doctorText.indexOf('[roleName],', evidenceCheckAt));
  assert.match(evidenceCheck, /has_sequence_privilege\(\$1, c\.oid, p\.priv\)/u);
  assert.match(evidenceCheck, /n\.nspname = 'brain_evidence' AND c\.relkind = 'S'/u);
});
