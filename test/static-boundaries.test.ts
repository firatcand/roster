import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
  const violations: string[] = [];
  for (const path of files) {
    for (const edge of moduleEdges(path)) {
      if (forbiddenBoundaryDependency(edge.module)) {
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
  const protectedNames = new Set([
    capability,
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

  const oracleMarkers = ['expected-semantic-result', 'host-led-learning-oracle'];
  const oracleLeaks = regularFiles(fixtureRoot).flatMap((path) => {
    const content = readFileSync(path, 'utf8').toLowerCase();
    return oracleMarkers
      .filter((marker) => content.includes(marker))
      .map((marker) => `${repositoryPath(path)}:${marker}`);
  });
  assert.deepEqual(oracleLeaks, []);

  const mechanicsOnly = [
    'common/fixture-lifecycle.md',
    'common/host-launch-contract.json',
    'common/output-schema.json',
    ...skillCopies.flat(),
  ];
  const forbiddenAnswerMarkers = [
    'result-valid-practitioner',
    'result-profile',
    'result-crypto',
    'result-prior',
    'result-injection',
    'candidate-opportunity-discovery-001',
    'prefer-attributable-practitioner-posts',
    'require a canonical public url',
    'exclude cryptocurrency topics',
    'reject profile and company-homepage urls',
    'exclude urls presented in prior discovery runs',
  ];
  const answerLeaks = mechanicsOnly.flatMap((path) => {
    const content = readFileSync(join(PROJECT_ROOT, fixtureRoot, path), 'utf8').toLowerCase();
    return forbiddenAnswerMarkers
      .filter((marker) => content.includes(marker))
      .map((marker) => `${path}:${marker}`);
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
