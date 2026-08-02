import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ROSTER_STATE_GITIGNORE,
  createWorkspaceReadSession,
  ensureRosterStateRoot,
  ensureWorkspaceDirectory,
  enumerateWorkspaceSlot,
  hashWorkspaceBytes,
  publishCreateOnly,
  readWorkspaceFile,
  realWorkspaceDurabilityFs,
  realWorkspaceMutationFs,
  realWorkspaceReadFs,
  removeEmptyWorkspaceDirectories,
  removeManagedWorkspaceFileIfHash,
  removePublishedWorkspaceFile,
  replaceWorkspaceFile,
  syncWorkspaceDirectory,
  withWorkspaceLock,
  type WorkspaceFileIdentityToken,
} from '../src/lib/workspace-io.ts';
import { isWorkspaceFailure, workspaceFailure, type WorkspaceRosterError } from '../src/lib/workspace-diagnostics.ts';

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-io-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function failureCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    assert.equal(isWorkspaceFailure(error), true);
    return isWorkspaceFailure(error) ? error.code : undefined;
  }
}

function captureFailure(run: () => unknown): WorkspaceRosterError {
  try {
    run();
  } catch (error) {
    assert.equal(isWorkspaceFailure(error), true);
    if (isWorkspaceFailure(error)) return error;
  }
  throw new assert.AssertionError({ message: 'expected workspace failure' });
}

test('create-only publication adopts exact bytes and refuses differing bytes', () => {
  const fx = fixture();
  try {
    ensureWorkspaceDirectory(fx.root, 'functions/gtm');
    assert.equal(publishCreateOnly(fx.root, 'functions/gtm/function.yaml', 'same\n'), 'created');
    assert.equal(statSync(join(fx.root, 'functions/gtm/function.yaml')).mode & 0o777, 0o644);
    assert.equal(publishCreateOnly(fx.root, 'functions/gtm/function.yaml', 'same\n'), 'adopted');
    let adoptionSyncs = 0;
    const adoptionOpens: string[] = [];
    assert.equal(publishCreateOnly(fx.root, 'functions/gtm/function.yaml', 'same\n', {
      durabilityFs: {
        ...realWorkspaceDurabilityFs,
        openSync(path, flags, mode) {
          adoptionOpens.push(String(path));
          return realWorkspaceDurabilityFs.openSync(path, flags, mode);
        },
        fsyncSync(fd) {
          adoptionSyncs++;
          realWorkspaceDurabilityFs.fsyncSync(fd);
        },
      },
    }), 'adopted');
    assert.equal(adoptionSyncs, 3);
    assert.deepEqual(adoptionOpens, ['function.yaml', '.', '.']);
    assert.equal(failureCode(() => publishCreateOnly(fx.root, 'functions/gtm/function.yaml', 'same\n', {
      durabilityFs: {
        ...realWorkspaceDurabilityFs,
        fsyncSync() {
          const error = new Error('sync failed') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        },
      },
    })), 'WRITE_CONFLICT');
    assert.equal(
      failureCode(() => publishCreateOnly(fx.root, 'functions/gtm/function.yaml', 'different\n')),
      'WRITE_CONFLICT',
    );
    assert.equal(readFileSync(join(fx.root, 'functions/gtm/function.yaml'), 'utf8'), 'same\n');
  } finally {
    fx.cleanup();
  }
});

test('create-only publication preserves larger existing managed files and reports a conflict', () => {
  const cases = [
    {
      path: 'ROSTER.md',
      proposed: '# Roster\n',
      existing: Buffer.from('# Roster\nkeep this authored content\n', 'utf8'),
    },
    {
      path: '.roster/.gitignore',
      proposed: ROSTER_STATE_GITIGNORE,
      existing: Buffer.from(`${ROSTER_STATE_GITIGNORE}keep-this-rule/\n`, 'utf8'),
    },
  ];

  for (const fixtureCase of cases) {
    const fx = fixture();
    try {
      if (fixtureCase.path.includes('/')) ensureWorkspaceDirectory(fx.root, '.roster');
      writeFileSync(join(fx.root, fixtureCase.path), fixtureCase.existing);

      assert.ok(fixtureCase.existing.byteLength > Buffer.byteLength(fixtureCase.proposed));
      assert.equal(
        failureCode(() => publishCreateOnly(fx.root, fixtureCase.path, fixtureCase.proposed)),
        'WRITE_CONFLICT',
        fixtureCase.path,
      );
      assert.deepEqual(readFileSync(join(fx.root, fixtureCase.path)), fixtureCase.existing, fixtureCase.path);
    } finally {
      fx.cleanup();
    }
  }
});

test('created and adopted publication end with parent fsync after temporary unlink', () => {
  for (const mode of ['created', 'adopted'] as const) {
    const fx = fixture();
    try {
      if (mode === 'adopted') publishCreateOnly(fx.root, 'record', 'same\n');
      const events: string[] = [];
      const paths = new Map<number, string>();
      assert.equal(publishCreateOnly(fx.root, 'record', 'same\n', {
        durabilityFs: {
          ...realWorkspaceDurabilityFs,
          openSync(path, flags, permissions) {
            const fd = realWorkspaceDurabilityFs.openSync(path, flags, permissions);
            paths.set(fd, String(path));
            return fd;
          },
          fsyncSync(fd) {
            events.push(`fsync:${paths.get(fd) ?? 'unknown'}`);
            realWorkspaceDurabilityFs.fsyncSync(fd);
          },
          closeSync(fd) {
            realWorkspaceDurabilityFs.closeSync(fd);
            paths.delete(fd);
          },
        },
        mutationFs: {
          ...realWorkspaceMutationFs,
          unlinkSync(path) {
            if (String(path).includes('.record.roster-')) events.push('unlink:temporary');
            realWorkspaceMutationFs.unlinkSync(path);
          },
        },
      }), mode);
      assert.equal(events.at(-1), 'fsync:.', mode);
      assert.ok(events.lastIndexOf('unlink:temporary') < events.length - 1, mode);
    } finally {
      fx.cleanup();
    }
  }
});

test('bounded reads reject oversized, non-regular, and symlinked components', () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.root, 'safe'));
    writeFileSync(join(fx.root, 'safe', 'large'), Buffer.alloc(32));
    assert.equal(failureCode(() => readWorkspaceFile(fx.root, 'safe/large', { maxBytes: 8 })), 'READ_LIMIT_EXCEEDED');
    symlinkSync(join(fx.root, 'safe', 'large'), join(fx.root, 'safe', 'link'));
    assert.equal(failureCode(() => readWorkspaceFile(fx.root, 'safe/link')), 'SYMLINK_COMPONENT');
    symlinkSync(join(fx.root, 'safe'), join(fx.root, 'diverted'));
    assert.equal(failureCode(() => readWorkspaceFile(fx.root, 'diverted/large')), 'SYMLINK_COMPONENT');
    writeFileSync(join(fx.root, 'safe', 'unreadable'), 'private');
    chmodSync(join(fx.root, 'safe', 'unreadable'), 0o000);
    assert.equal(failureCode(() => readWorkspaceFile(fx.root, 'safe/unreadable')), 'NOT_REGULAR_FILE');
  } finally {
    fx.cleanup();
  }
});

test('bounded reads detect growth after EOF and same-size leaf replacement', () => {
  const fx = fixture();
  try {
    const growing = join(fx.root, 'growing');
    writeFileSync(growing, 'abc');
    let grew = false;
    assert.equal(failureCode(() => readWorkspaceFile(fx.root, 'growing', {
      fs: {
        ...realWorkspaceReadFs,
        readSync(fd, buffer, offset, length, position) {
          const count = realWorkspaceReadFs.readSync(fd, buffer, offset, length, position);
          if (count > 0 && !grew) {
            grew = true;
            appendFileSync(growing, 'x');
          }
          return count;
        },
      },
    })), 'WRITE_CONFLICT');

    const replaced = join(fx.root, 'replaced');
    const replacement = join(fx.root, 'replacement');
    writeFileSync(replaced, 'old');
    writeFileSync(replacement, 'new');
    let swapped = false;
    assert.equal(failureCode(() => readWorkspaceFile(fx.root, 'replaced', {
      fs: {
        ...realWorkspaceReadFs,
        readSync(fd, buffer, offset, length, position) {
          const count = realWorkspaceReadFs.readSync(fd, buffer, offset, length, position);
          if (count > 0 && !swapped) {
            swapped = true;
            renameSync(replacement, replaced);
          }
          return count;
        },
      },
    })), 'WRITE_CONFLICT');
    assert.equal(readFileSync(replaced, 'utf8'), 'new');
  } finally {
    fx.cleanup();
  }
});

test('read sessions recheck every cached ancestor and reject rename-to-symlink diversion', () => {
  const fx = fixture();
  const moved = `${fx.root}-moved`;
  try {
    mkdirSync(join(fx.root, 'a', 'b'), { recursive: true });
    writeFileSync(join(fx.root, 'a', 'b', 'record'), 'safe');
    const session = createWorkspaceReadSession(fx.root);
    assert.equal(session.readText('a/b/record'), 'safe');
    renameSync(join(fx.root, 'a'), moved);
    symlinkSync(moved, join(fx.root, 'a'));
    assert.equal(failureCode(() => session.readText('a/b/record')), 'SYMLINK_COMPONENT');
  } finally {
    rmSync(moved, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('deferred read sessions never return bytes from a swap-and-restore diversion', () => {
  const fx = fixture();
  const outside = fixture();
  try {
    mkdirSync(join(fx.root, 'safe'));
    writeFileSync(join(fx.root, 'safe/record'), 'inside!');
    writeFileSync(join(outside.root, 'record'), 'outside');
    const moved = join(fx.root, 'safe-moved');
    let restored = false;
    const session = createWorkspaceReadSession(fx.root, { deferParentChecks: true });
    const error = captureFailure(() => session.readFile('safe/record', {
      beforeOpen() {
        renameSync(join(fx.root, 'safe'), moved);
        symlinkSync(outside.root, join(fx.root, 'safe'));
      },
      fs: {
        ...realWorkspaceReadFs,
        readSync(fd, buffer, offset, length, position) {
          const count = realWorkspaceReadFs.readSync(fd, buffer, offset, length, position);
          if (!restored) {
            restored = true;
            rmSync(join(fx.root, 'safe'));
            renameSync(moved, join(fx.root, 'safe'));
          }
          return count;
        },
      },
    }));
    assert.equal(error.code, 'WRITE_CONFLICT');
    assert.equal(readFileSync(join(fx.root, 'safe/record'), 'utf8'), 'inside!');
  } finally {
    outside.cleanup();
    fx.cleanup();
  }
});

test('context read sessions terminally revalidate selected leaf hashes and identities', () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.root, 'safe'));
    writeFileSync(join(fx.root, 'safe/a'), 'alpha');
    writeFileSync(join(fx.root, 'safe/b'), 'bravo');

    const changedBytes = createWorkspaceReadSession(fx.root, {
      deferParentChecks: true,
      contextMode: true,
    });
    assert.equal(changedBytes.readText('safe/a'), 'alpha');
    assert.equal(changedBytes.readText('safe/b'), 'bravo');
    writeFileSync(join(fx.root, 'safe/a'), 'omega');
    assert.equal(failureCode(() => changedBytes.verify()), 'WRITE_CONFLICT');

    writeFileSync(join(fx.root, 'safe/a'), 'alpha');
    const replacedIdentity = createWorkspaceReadSession(fx.root, {
      deferParentChecks: true,
      contextMode: true,
    });
    assert.equal(replacedIdentity.readText('safe/a'), 'alpha');
    writeFileSync(join(fx.root, 'safe/replacement'), 'alpha');
    renameSync(join(fx.root, 'safe/replacement'), join(fx.root, 'safe/a'));
    assert.equal(failureCode(() => replacedIdentity.verify(['safe/a'])), 'WRITE_CONFLICT');
  } finally {
    fx.cleanup();
  }
});

test('context leaf selection does not pin an unselected record body', () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.root, 'safe'));
    writeFileSync(join(fx.root, 'safe/selected'), 'selected');
    writeFileSync(join(fx.root, 'safe/catalog-only'), 'catalog');
    const session = createWorkspaceReadSession(fx.root, {
      deferParentChecks: true,
      contextMode: true,
    });
    session.readFile('safe/selected');
    session.readFile('safe/catalog-only');
    writeFileSync(join(fx.root, 'safe/catalog-only'), 'changed');
    session.verify(['safe/selected']);

    const ordinary = createWorkspaceReadSession(fx.root, { deferParentChecks: true });
    ordinary.readFile('safe/selected');
    writeFileSync(join(fx.root, 'safe/selected'), 'ordinary');
    ordinary.verify();
  } finally {
    fx.cleanup();
  }
});

test('context sessions do not inode-pin root-level vendor provenance outside the session', () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.root, 'safe'));
    writeFileSync(join(fx.root, 'safe/selected'), 'selected');
    writeFileSync(join(fx.root, 'founder-skills.lock'), 'same vendor bytes');
    const session = createWorkspaceReadSession(fx.root, {
      deferParentChecks: true,
      contextMode: true,
    });
    session.readFile('safe/selected');

    writeFileSync(join(fx.root, 'replacement'), 'same vendor bytes');
    renameSync(join(fx.root, 'replacement'), join(fx.root, 'founder-skills.lock'));
    session.verify(['safe/selected']);
  } finally {
    fx.cleanup();
  }
});

test('replace requires the exact source hash and publishes parent bytes last', () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.root, 'roster.yaml'), 'one\n');
    replaceWorkspaceFile(fx.root, 'roster.yaml', 'two\n', { expectedHash: hashWorkspaceBytes('one\n') });
    assert.equal(readFileSync(join(fx.root, 'roster.yaml'), 'utf8'), 'two\n');
    assert.equal(
      failureCode(() => replaceWorkspaceFile(fx.root, 'roster.yaml', 'three\n', { expectedHash: hashWorkspaceBytes('one\n') })),
      'WRITE_CONFLICT',
    );
    writeFileSync(join(fx.root, 'roster.yaml'), 'expected\n');
    assert.equal(failureCode(() => replaceWorkspaceFile(fx.root, 'roster.yaml', 'published\n', {
      expectedHash: hashWorkspaceBytes('expected\n'),
      beforePublish() {
        writeFileSync(join(fx.root, 'replacement'), 'concurrent\n');
        renameSync(join(fx.root, 'replacement'), join(fx.root, 'roster.yaml'));
      },
    })), 'WRITE_CONFLICT');
    assert.equal(readFileSync(join(fx.root, 'roster.yaml'), 'utf8'), 'concurrent\n');
  } finally {
    fx.cleanup();
  }
});

test('rollback deletion never removes a same-byte concurrent replacement', () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.root, 'child.yaml'), 'child\n');
    assert.equal(failureCode(() => removeManagedWorkspaceFileIfHash(
      fx.root,
      'child.yaml',
      hashWorkspaceBytes('child\n'),
      {
        beforeQuarantine() {
          writeFileSync(join(fx.root, 'replacement'), 'child\n');
          renameSync(join(fx.root, 'replacement'), join(fx.root, 'child.yaml'));
        },
      },
    )), 'WRITE_CONFLICT');
    assert.equal(readFileSync(join(fx.root, 'child.yaml'), 'utf8'), 'child\n');
  } finally {
    fx.cleanup();
  }
});

test('remove cleanup failure discloses the retained exact quarantine', () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.root, 'record'), 'old\n');
    const error = captureFailure(() => removeManagedWorkspaceFileIfHash(
      fx.root,
      'record',
      hashWorkspaceBytes('old\n'),
      {
        mutationFs: {
          ...realWorkspaceMutationFs,
          unlinkSync(path) {
            if (String(path).includes('.record.roster-')) {
              const failure = new Error('permission denied') as NodeJS.ErrnoException;
              failure.code = 'EACCES';
              throw failure;
            }
            realWorkspaceMutationFs.unlinkSync(path);
          },
        },
      },
    ));
    assert.equal(error.code, 'FILESYSTEM_WRITE_FAILED');
    assert.equal(error.details['state'], 'deleted-with-quarantine');
    assert.equal(existsSync(join(fx.root, 'record')), false);
    assert.equal(existsSync(join(fx.root, String(error.details['quarantinePath']))), true);
  } finally {
    fx.cleanup();
  }
});

test('directory durability failures are stable and fail closed', () => {
  const fx = fixture();
  try {
    assert.equal(failureCode(() => syncWorkspaceDirectory(fx.root, {
      ...realWorkspaceDurabilityFs,
      openSync() {
        const error = new Error('unsupported') as NodeJS.ErrnoException;
        error.code = 'ENOTSUP';
        throw error;
      },
    })), 'ATOMIC_PUBLICATION_UNSUPPORTED');
    assert.equal(failureCode(() => syncWorkspaceDirectory(fx.root, {
      ...realWorkspaceDurabilityFs,
      fsyncSync() {
        const error = new Error('sync failed') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      },
    })), 'ATOMIC_PUBLICATION_UNSUPPORTED');
  } finally {
    fx.cleanup();
  }
});

test('post-mutation fsync failures preserve recoverable canonical file state', () => {
  const failingDurability = {
    ...realWorkspaceDurabilityFs,
    fsyncSync() {
      const error = new Error('sync failed') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    },
  };

  for (const operation of ['publish', 'replace', 'remove'] as const) {
    const fx = fixture();
    try {
      writeFileSync(join(fx.root, 'record'), 'old\n');
      if (operation === 'publish') rmSync(join(fx.root, 'record'));
      const error = captureFailure(() => {
        if (operation === 'publish') {
          publishCreateOnly(fx.root, 'record', 'new\n', { durabilityFs: failingDurability });
        } else if (operation === 'replace') {
          replaceWorkspaceFile(fx.root, 'record', 'new\n', {
            expectedHash: hashWorkspaceBytes('old\n'),
            durabilityFs: failingDurability,
          });
        } else {
          removeManagedWorkspaceFileIfHash(fx.root, 'record', hashWorkspaceBytes('old\n'), {
            durabilityFs: failingDurability,
          });
        }
      });
      assert.equal(error.code, 'WRITE_CONFLICT', operation);
      assert.equal(typeof error.details['quarantinePath'], 'string', operation);
      assert.equal(existsSync(join(fx.root, String(error.details['quarantinePath']))), true, operation);
      if (operation === 'publish') assert.equal(existsSync(join(fx.root, 'record')), false);
      else assert.equal(readFileSync(join(fx.root, 'record'), 'utf8'), 'old\n');
    } finally {
      fx.cleanup();
    }
  }
});

test('temporary write, hard-link, and rename faults return stable workspace diagnostics', () => {
  const fx = fixture();
  try {
    assert.equal(failureCode(() => publishCreateOnly(fx.root, 'record', 'bytes', {
      mutationFs: {
        ...realWorkspaceMutationFs,
        openSync() {
          const error = new Error('permission denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        },
      },
    })), 'FILESYSTEM_WRITE_FAILED');
    assert.equal(failureCode(() => publishCreateOnly(fx.root, 'record-close', 'bytes', {
      mutationFs: {
        ...realWorkspaceMutationFs,
        closeSync(fd) {
          realWorkspaceMutationFs.closeSync(fd);
          const error = new Error('close failed') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        },
      },
    })), 'FILESYSTEM_WRITE_FAILED');
    assert.equal(failureCode(() => publishCreateOnly(fx.root, 'record', 'bytes', {
      mutationFs: {
        ...realWorkspaceMutationFs,
        writeSync() {
          const error = new Error('disk full') as NodeJS.ErrnoException;
          error.code = 'ENOSPC';
          throw error;
        },
      },
    })), 'FILESYSTEM_WRITE_FAILED');
    assert.equal(failureCode(() => publishCreateOnly(fx.root, 'record', 'bytes', {
      mutationFs: {
        ...realWorkspaceMutationFs,
        linkSync() {
          const error = new Error('unsupported') as NodeJS.ErrnoException;
          error.code = 'ENOTSUP';
          throw error;
        },
      },
    })), 'ATOMIC_PUBLICATION_UNSUPPORTED');
    writeFileSync(join(fx.root, 'parent.yaml'), 'old\n');
    assert.equal(failureCode(() => replaceWorkspaceFile(fx.root, 'parent.yaml', 'new\n', {
      expectedHash: hashWorkspaceBytes('old\n'),
      mutationFs: {
        ...realWorkspaceMutationFs,
        renameSync() {
          const error = new Error('rename failed') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        },
      },
    })), 'FILESYSTEM_WRITE_FAILED');
    assert.equal(readFileSync(join(fx.root, 'parent.yaml'), 'utf8'), 'old\n');

    let targetStats = 0;
    assert.equal(failureCode(() => replaceWorkspaceFile(fx.root, 'parent.yaml', 'new\n', {
      expectedHash: hashWorkspaceBytes('old\n'),
      mutationFs: {
        ...realWorkspaceMutationFs,
        lstatSync(path) {
          if (String(path) === 'parent.yaml' && ++targetStats === 3) {
            const error = new Error('metadata failed') as NodeJS.ErrnoException;
            error.code = 'EIO';
            throw error;
          }
          return realWorkspaceMutationFs.lstatSync(path);
        },
      },
    })), 'FILESYSTEM_WRITE_FAILED');
    assert.equal(readFileSync(join(fx.root, 'parent.yaml'), 'utf8'), 'old\n');
  } finally {
    fx.cleanup();
  }
});

test('anchored parent operations never follow a concurrently installed parent symlink', () => {
  const cases = ['read', 'publish', 'replace', 'remove'] as const;
  for (const operation of cases) {
    const fx = fixture();
    const outside = fixture();
    try {
      mkdirSync(join(fx.root, 'safe'));
      writeFileSync(join(fx.root, 'safe', 'record'), 'inside\n');
      writeFileSync(join(outside.root, 'record'), 'outside\n');
      const moved = join(fx.root, 'moved');
      const swapParent = (): void => {
        renameSync(join(fx.root, 'safe'), moved);
        symlinkSync(outside.root, join(fx.root, 'safe'));
      };
      const code = operation === 'read'
        ? failureCode(() => readWorkspaceFile(fx.root, 'safe/record', { beforeOpen: swapParent }))
        : operation === 'publish'
          ? failureCode(() => publishCreateOnly(fx.root, 'safe/new-record', 'created\n', { beforePublish: swapParent }))
          : operation === 'replace'
            ? failureCode(() => replaceWorkspaceFile(fx.root, 'safe/record', 'updated\n', {
                expectedHash: hashWorkspaceBytes('inside\n'),
                beforePublish: swapParent,
              }))
            : failureCode(() => removeManagedWorkspaceFileIfHash(
                fx.root,
                'safe/record',
                hashWorkspaceBytes('inside\n'),
                { beforeQuarantine: swapParent },
              ));
      assert.equal(code, 'SYMLINK_COMPONENT', operation);
      assert.equal(readFileSync(join(outside.root, 'record'), 'utf8'), 'outside\n', operation);
      assert.equal(existsSync(join(outside.root, 'new-record')), false, operation);
      assert.equal(readFileSync(join(moved, 'record'), 'utf8'), 'inside\n', operation);
      assert.equal(existsSync(join(moved, 'new-record')), false, operation);
    } finally {
      outside.cleanup();
      fx.cleanup();
    }
  }
});

test('detached-parent detection rolls back every completed leaf mutation before throwing', () => {
  for (const operation of ['publish', 'replace', 'remove'] as const) {
    const fx = fixture();
    const outside = fixture();
    try {
      mkdirSync(join(fx.root, 'safe'));
      writeFileSync(join(fx.root, 'safe', 'record'), 'inside\n');
      writeFileSync(join(outside.root, 'record'), 'outside\n');
      const moved = join(fx.root, 'moved');
      const detachParent = (): void => {
        renameSync(join(fx.root, 'safe'), moved);
        symlinkSync(outside.root, join(fx.root, 'safe'));
      };
      const code = operation === 'publish'
        ? failureCode(() => publishCreateOnly(fx.root, 'safe/new-record', 'created\n', { afterMutation: detachParent }))
        : operation === 'replace'
          ? failureCode(() => replaceWorkspaceFile(fx.root, 'safe/record', 'updated\n', {
              expectedHash: hashWorkspaceBytes('inside\n'),
              afterMutation: detachParent,
            }))
          : failureCode(() => removeManagedWorkspaceFileIfHash(
              fx.root,
              'safe/record',
              hashWorkspaceBytes('inside\n'),
              { afterMutation: detachParent },
            ));
      assert.equal(code, 'SYMLINK_COMPONENT', operation);
      assert.equal(readFileSync(join(moved, 'record'), 'utf8'), 'inside\n', operation);
      assert.equal(existsSync(join(moved, 'new-record')), false, operation);
      assert.equal(readFileSync(join(outside.root, 'record'), 'utf8'), 'outside\n', operation);
    } finally {
      outside.cleanup();
      fx.cleanup();
    }
  }
});

test('same-parent leaf replacement is preserved after every mutation linearization hook', () => {
  for (const operation of ['publish', 'replace', 'remove'] as const) {
    const fx = fixture();
    try {
      if (operation !== 'publish') writeFileSync(join(fx.root, 'record'), 'old\n');
      const replaceLeaf = (): void => {
        if (existsSync(join(fx.root, 'record'))) renameSync(join(fx.root, 'record'), join(fx.root, 'moved-record'));
        writeFileSync(join(fx.root, 'record'), 'concurrent\n');
      };
      const error = captureFailure(() => {
        if (operation === 'publish') {
          publishCreateOnly(fx.root, 'record', 'new\n', { afterMutation: replaceLeaf });
        } else if (operation === 'replace') {
          replaceWorkspaceFile(fx.root, 'record', 'new\n', {
            expectedHash: hashWorkspaceBytes('old\n'),
            afterMutation: replaceLeaf,
          });
        } else {
          removeManagedWorkspaceFileIfHash(fx.root, 'record', hashWorkspaceBytes('old\n'), {
            afterMutation() {
              writeFileSync(join(fx.root, 'record'), 'concurrent\n');
            },
          });
        }
      });
      assert.equal(error.code, 'WRITE_CONFLICT', operation);
      assert.equal(readFileSync(join(fx.root, 'record'), 'utf8'), 'concurrent\n', operation);
      assert.equal(typeof error.details['quarantinePath'], 'string', operation);
      assert.equal(existsSync(join(fx.root, String(error.details['quarantinePath']))), true, operation);
    } finally {
      fx.cleanup();
    }
  }
});

test('creation tokens prevent hash-equal replacement cleanup', () => {
  const fx = fixture();
  try {
    let token: WorkspaceFileIdentityToken | undefined;
    assert.equal(publishCreateOnly(fx.root, 'record', 'same\n', {
      captureCreation(created) {
        token = created;
      },
    }), 'created');
    renameSync(join(fx.root, 'record'), join(fx.root, 'original'));
    writeFileSync(join(fx.root, 'record'), 'same\n');
    assert.notEqual(token, undefined);
    assert.equal(removePublishedWorkspaceFile(fx.root, 'record', token!), false);
    assert.equal(readFileSync(join(fx.root, 'record'), 'utf8'), 'same\n');
  } finally {
    fx.cleanup();
  }
});

test('replacement tokens prevent hash-equal concurrent bytes from being overwritten during rollback', () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.root, 'record'), 'prior\n');
    let token: WorkspaceFileIdentityToken | undefined;
    replaceWorkspaceFile(fx.root, 'record', 'published\n', {
      expectedHash: hashWorkspaceBytes('prior\n'),
      capturePublication(published) {
        token = published;
      },
    });
    assert.notEqual(token, undefined);
    renameSync(join(fx.root, 'record'), join(fx.root, 'published-by-roster'));
    writeFileSync(join(fx.root, 'record'), 'published\n');

    assert.equal(failureCode(() => replaceWorkspaceFile(fx.root, 'record', 'prior\n', {
      expectedHash: hashWorkspaceBytes('published\n'),
      expectedIdentity: token!,
    })), 'WRITE_CONFLICT');
    assert.equal(readFileSync(join(fx.root, 'record'), 'utf8'), 'published\n');
  } finally {
    fx.cleanup();
  }
});

test('artifact-owned bounds support identity-guarded create and replacement rollback above 512 KiB', () => {
  const fx = fixture();
  const maxBytes = 1024 * 1024;
  const prior = Buffer.alloc(600 * 1024, 'a');
  const published = Buffer.alloc(600 * 1024, 'b');
  try {
    let creation: WorkspaceFileIdentityToken | undefined;
    assert.equal(publishCreateOnly(fx.root, 'large-created', published, {
      captureCreation(token) {
        creation = token;
      },
    }), 'created');
    assert.notEqual(creation, undefined);
    assert.equal(removePublishedWorkspaceFile(fx.root, 'large-created', creation!, { maxBytes }), true);
    assert.equal(existsSync(join(fx.root, 'large-created')), false);

    writeFileSync(join(fx.root, 'large-replaced'), prior);
    let replacement: WorkspaceFileIdentityToken | undefined;
    replaceWorkspaceFile(fx.root, 'large-replaced', published, {
      expectedHash: hashWorkspaceBytes(prior),
      maxBytes,
      capturePublication(token) {
        replacement = token;
      },
    });
    assert.notEqual(replacement, undefined);
    replaceWorkspaceFile(fx.root, 'large-replaced', prior, {
      expectedHash: hashWorkspaceBytes(published),
      expectedIdentity: replacement!,
      maxBytes,
    });
    assert.deepEqual(readFileSync(join(fx.root, 'large-replaced')), prior);
  } finally {
    fx.cleanup();
  }
});

test('directory creation rolls back partial trees and preserves replaced final components', () => {
  const partial = fixture();
  try {
    let calls = 0;
    const error = captureFailure(() => ensureWorkspaceDirectory(partial.root, 'a/b', {
      mutationFs: {
        ...realWorkspaceMutationFs,
        mkdirSync(path, options) {
          calls++;
          if (calls === 2) {
            const failure = new Error('mkdir failed') as NodeJS.ErrnoException;
            failure.code = 'EIO';
            throw failure;
          }
          return realWorkspaceMutationFs.mkdirSync(path, options);
        },
      },
    }));
    assert.equal(error.code, 'FILESYSTEM_WRITE_FAILED');
    assert.equal(existsSync(join(partial.root, 'a')), false);
  } finally {
    partial.cleanup();
  }

  const metadataFault = fixture();
  try {
    let stats = 0;
    const error = captureFailure(() => ensureWorkspaceDirectory(metadataFault.root, 'a', {
      mutationFs: {
        ...realWorkspaceMutationFs,
        lstatSync(path) {
          if (String(path) === 'a' && ++stats === 3) {
            const failure = new Error('metadata failed') as NodeJS.ErrnoException;
            failure.code = 'EIO';
            throw failure;
          }
          return realWorkspaceMutationFs.lstatSync(path);
        },
      },
    }));
    assert.equal(error.code, 'FILESYSTEM_WRITE_FAILED');
    assert.equal(existsSync(join(metadataFault.root, 'a')), false);
  } finally {
    metadataFault.cleanup();
  }

  const replaced = fixture();
  const outside = fixture();
  try {
    const moved = join(replaced.root, 'a-moved');
    const error = captureFailure(() => ensureWorkspaceDirectory(replaced.root, 'a', {
      afterMutation() {
        renameSync(join(replaced.root, 'a'), moved);
        symlinkSync(outside.root, join(replaced.root, 'a'));
      },
    }));
    assert.equal(error.code, 'WRITE_CONFLICT');
    assert.equal(error.details['quarantinePath'], 'a-moved');
    assert.equal(statSync(moved).isDirectory(), true);
    assert.equal(statSync(join(replaced.root, 'a')).dev, statSync(outside.root).dev);
  } finally {
    outside.cleanup();
    replaced.cleanup();
  }
});

test('workspace root replacement during canonicalization cannot redirect creation', () => {
  const fx = fixture();
  const outside = fixture();
  const moved = `${fx.root}-moved`;
  try {
    const error = captureFailure(() => ensureWorkspaceDirectory(fx.root, 'a', {
      beforeRootRealpath() {
        renameSync(fx.root, moved);
        symlinkSync(outside.root, fx.root);
      },
    }));
    assert.equal(error.code, 'WRITE_CONFLICT');
    assert.equal(existsSync(join(outside.root, 'a')), false);
    assert.equal(existsSync(join(moved, 'a')), false);
  } finally {
    rmSync(moved, { recursive: true, force: true });
    outside.cleanup();
    fx.cleanup();
  }
});

test('workspace root disappearance during canonicalization is a stable conflict', () => {
  const fx = fixture();
  const moved = `${fx.root}-moved`;
  try {
    const error = captureFailure(() => ensureWorkspaceDirectory(fx.root, 'a', {
      beforeRootRealpath() {
        renameSync(fx.root, moved);
      },
    }));
    assert.equal(error.code, 'WRITE_CONFLICT');
    assert.equal(error.details['cause'], 'ENOENT');
    assert.equal(existsSync(join(moved, 'a')), false);
  } finally {
    rmSync(moved, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('directory cleanup only removes the exact created inode', () => {
  const fx = fixture();
  try {
    const created = ensureWorkspaceDirectory(fx.root, 'a').creationTokens;
    renameSync(join(fx.root, 'a'), join(fx.root, 'a-moved'));
    mkdirSync(join(fx.root, 'a'));
    const error = captureFailure(() => removeEmptyWorkspaceDirectories(fx.root, created));
    assert.equal(error.code, 'WRITE_CONFLICT');
    assert.equal(error.details['quarantinePath'], 'a-moved');
    assert.equal(statSync(join(fx.root, 'a')).isDirectory(), true);
    assert.equal(statSync(join(fx.root, 'a-moved')).isDirectory(), true);
  } finally {
    fx.cleanup();
  }
});

test('state gitignore exists before lock state and lock contention is actionable', () => {
  const fx = fixture();
  try {
    ensureRosterStateRoot(fx.root);
    assert.equal(readFileSync(join(fx.root, '.roster/.gitignore'), 'utf8'), ROSTER_STATE_GITIGNORE);
    let contention: string | undefined;
    withWorkspaceLock(fx.root, () => {
      assert.equal(readFileSync(join(fx.root, '.roster/.gitignore'), 'utf8'), ROSTER_STATE_GITIGNORE);
      contention = failureCode(() => withWorkspaceLock(fx.root, () => undefined));
    });
    assert.equal(contention, 'WORKSPACE_BUSY');
  } finally {
    fx.cleanup();
  }
});

test('lock cleanup stays on the acquired inode after lock-parent replacement', () => {
  const fx = fixture();
  const outside = fixture();
  try {
    const movedLocks = join(fx.root, '.roster/state/locks-moved');
    const error = captureFailure(() => withWorkspaceLock(fx.root, () => {
      renameSync(join(fx.root, '.roster/state/locks'), movedLocks);
      mkdirSync(join(outside.root, 'scaffold'));
      writeFileSync(join(outside.root, 'scaffold/owner.json'), 'outside\n');
      symlinkSync(outside.root, join(fx.root, '.roster/state/locks'));
    }));
    assert.equal(error.code, 'WORKSPACE_BUSY');
    assert.equal(readFileSync(join(outside.root, 'scaffold/owner.json'), 'utf8'), 'outside\n');
    assert.equal(existsSync(join(movedLocks, 'scaffold')), false);
  } finally {
    outside.cleanup();
    fx.cleanup();
  }
});

test('lock cleanup failure retains the callback failure and discloses recovery', () => {
  const fx = fixture();
  try {
    const error = captureFailure(() => withWorkspaceLock(fx.root, () => {
      const owner = join(fx.root, '.roster/state/locks/scaffold/owner.json');
      renameSync(owner, join(fx.root, '.roster/state/locks/scaffold/original-owner.json'));
      writeFileSync(owner, 'replacement\n');
      throw workspaceFailure('PARENT_NOT_FOUND', 'callback failed', 'retry later', { path: 'record' });
    }));
    assert.equal(error.code, 'WORKSPACE_BUSY');
    assert.equal(error.details['operationCode'], 'PARENT_NOT_FOUND');
    assert.equal(error.details['recoveryLockPath'], '.roster/state/locks/scaffold');
    assert.equal(readFileSync(join(fx.root, '.roster/state/locks/scaffold/owner.json'), 'utf8'), 'replacement\n');
  } finally {
    fx.cleanup();
  }
});

test('slot enumeration is non-recursive, capped, and rejects symlink entries', () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.root, 'slot'));
    mkdirSync(join(fx.root, 'slot', 'child'));
    writeFileSync(join(fx.root, 'slot', 'record.yaml'), 'x');
    assert.deepEqual(enumerateWorkspaceSlot(fx.root, 'slot'), [
      { name: 'child', kind: 'directory' },
      { name: 'record.yaml', kind: 'file' },
    ]);
    assert.equal(failureCode(() => enumerateWorkspaceSlot(fx.root, 'slot', { maxEntries: 1 })), 'READ_LIMIT_EXCEEDED');
    symlinkSync(join(fx.root, 'slot', 'record.yaml'), join(fx.root, 'slot', 'alias'));
    assert.equal(failureCode(() => enumerateWorkspaceSlot(fx.root, 'slot')), 'SYMLINK_COMPONENT');
  } finally {
    fx.cleanup();
  }
});

test('slot enumeration never follows a concurrently installed directory symlink', () => {
  const fx = fixture();
  const outside = fixture();
  try {
    mkdirSync(join(fx.root, 'slot'));
    writeFileSync(join(fx.root, 'slot/inside'), 'inside');
    writeFileSync(join(outside.root, 'outside'), 'outside');
    const moved = join(fx.root, 'slot-moved');
    const error = captureFailure(() => enumerateWorkspaceSlot(fx.root, 'slot', {
      beforeOpen() {
        renameSync(join(fx.root, 'slot'), moved);
        symlinkSync(outside.root, join(fx.root, 'slot'));
      },
    }));
    assert.equal(error.code, 'SYMLINK_COMPONENT');
    assert.equal(readFileSync(join(outside.root, 'outside'), 'utf8'), 'outside');
    assert.equal(readFileSync(join(moved, 'inside'), 'utf8'), 'inside');
  } finally {
    outside.cleanup();
    fx.cleanup();
  }
});
