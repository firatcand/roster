import chalk from 'chalk';
import { getPackageVersion } from '../lib/paths.ts';
import {
  EXIT_ERROR,
  EXIT_OK,
  legacyWorkspaceError,
  mixedWorkspaceError,
  unsafeWorkspaceMarkerError,
  workspaceRequiredError,
} from '../lib/errors.ts';
import { probeWorkspace } from '../lib/workspace-probe.ts';
import {
  updateV2ProjectActivationsWithLockToken,
  type ProjectActivationUpdateResult,
} from '../lib/generated-artifacts.ts';
import { detectProjectHostVersions } from '../lib/install.ts';
import { prepareVendorSkillMap } from '../lib/workspace-registry.ts';
import {
  VENDOR_SKILL_MAP_MAX_BYTES,
  VENDOR_SKILL_MAP_PATH,
} from '../lib/vendor-skills/adapter-map.ts';
import {
  ensureRosterStateRoot,
  hashWorkspaceBytes,
  publishCreateOnly,
  removePublishedWorkspaceFile,
  replaceWorkspaceFile,
  tryReadWorkspaceFile,
  type WorkspaceFileIdentityToken,
} from '../lib/workspace-io.ts';
import { workspaceFailure } from '../lib/workspace-diagnostics.ts';
import { withWorkspaceUpdateLock } from '../lib/internal/workspace-update-lock.ts';

export type UpdateCommandOptions = {
  cwd: string;
  json: boolean;
};

type VendorSkillMapUpdateStatus = 'created' | 'updated' | 'unchanged' | 'blocked';

type VendorSkillMapMutation = {
  status: Exclude<VendorSkillMapUpdateStatus, 'blocked'>;
  identity?: WorkspaceFileIdentityToken;
};

type V2UpdateResult = ProjectActivationUpdateResult & {
  vendor_skill_map: { path: typeof VENDOR_SKILL_MAP_PATH; status: VendorSkillMapUpdateStatus };
};

function readVendorSkillMap(root: string): Buffer | null {
  return tryReadWorkspaceFile(root, VENDOR_SKILL_MAP_PATH, { maxBytes: VENDOR_SKILL_MAP_MAX_BYTES });
}

function mapWriteConflict(): never {
  throw workspaceFailure(
    'WRITE_CONFLICT',
    'The vendor-skill map changed during atomic synchronization.',
    'Preserve the concurrent bytes, re-run validation, and retry roster update.',
    { path: VENDOR_SKILL_MAP_PATH },
  );
}

function synchronizeVendorSkillMap(
  root: string,
  content: string,
  before: Buffer | null,
): VendorSkillMapMutation {
  const current = readVendorSkillMap(root);
  if (before === null) {
    if (current !== null) {
      if (current.toString('utf8') !== content) mapWriteConflict();
      return { status: 'unchanged' };
    }
    ensureRosterStateRoot(root);
    let identity: WorkspaceFileIdentityToken | undefined;
    const publication = publishCreateOnly(root, VENDOR_SKILL_MAP_PATH, content, {
      captureCreation(token) {
        identity = token;
      },
    });
    if (publication === 'created') return { status: 'created', identity };
    const published = readVendorSkillMap(root);
    if (published?.toString('utf8') !== content) mapWriteConflict();
    return { status: 'unchanged' };
  }
  if (current === null || !current.equals(before)) mapWriteConflict();
  if (current.toString('utf8') === content) return { status: 'unchanged' };
  let identity: WorkspaceFileIdentityToken | undefined;
  replaceWorkspaceFile(root, VENDOR_SKILL_MAP_PATH, content, {
    expectedHash: hashWorkspaceBytes(before),
    maxBytes: VENDOR_SKILL_MAP_MAX_BYTES,
    capturePublication(token) {
      identity = token;
    },
  });
  return { status: 'updated', identity };
}

function rollbackVendorSkillMap(
  root: string,
  content: string,
  before: Buffer | null,
  mutation: VendorSkillMapMutation,
): void {
  if (mutation.status === 'unchanged') return;
  if (mutation.identity === undefined) mapWriteConflict();
  if (before === null) {
    if (!removePublishedWorkspaceFile(root, VENDOR_SKILL_MAP_PATH, mutation.identity, {
      maxBytes: VENDOR_SKILL_MAP_MAX_BYTES,
    })) {
      mapWriteConflict();
    }
    return;
  }
  replaceWorkspaceFile(root, VENDOR_SKILL_MAP_PATH, before, {
    expectedHash: hashWorkspaceBytes(content),
    expectedIdentity: mutation.identity,
    maxBytes: VENDOR_SKILL_MAP_MAX_BYTES,
  });
}

function synchronizeV2WorkspaceUpdate(
  root: string,
  hostVersions: Partial<Record<'claude' | 'codex', string>>,
): V2UpdateResult {
  return withWorkspaceUpdateLock(root, (lockToken) => {
    const mapBefore = readVendorSkillMap(root);
    const preparedMap = prepareVendorSkillMap(root);
    const activation = updateV2ProjectActivationsWithLockToken({ root, hostVersions }, lockToken);
    if (!activation.ok) {
      return {
        ...activation,
        vendor_skill_map: { path: VENDOR_SKILL_MAP_PATH, status: 'blocked' },
      };
    }
    const revalidatedMap = prepareVendorSkillMap(root);
    if (revalidatedMap.content !== preparedMap.content) {
      throw workspaceFailure(
        'WRITE_CONFLICT',
        'Authored tool guidance changed while roster update was synchronizing generated files.',
        'Preserve the authored bytes, inspect generated activation changes, and retry roster update.',
        { path: VENDOR_SKILL_MAP_PATH },
      );
    }
    const mapMutation = synchronizeVendorSkillMap(root, preparedMap.content, mapBefore);
    let finalContent: string;
    try {
      finalContent = prepareVendorSkillMap(root).content;
    } catch {
      rollbackVendorSkillMap(root, preparedMap.content, mapBefore, mapMutation);
      throw workspaceFailure(
        'WRITE_CONFLICT',
        'Vendor-skill map inputs became invalid during atomic publication.',
        'The prior map bytes were restored; preserve the concurrent source edit and retry roster update.',
        { path: VENDOR_SKILL_MAP_PATH },
      );
    }
    if (finalContent !== preparedMap.content) {
      rollbackVendorSkillMap(root, preparedMap.content, mapBefore, mapMutation);
      throw workspaceFailure(
        'WRITE_CONFLICT',
        'Vendor-skill map inputs changed during atomic publication.',
        'The prior map bytes were restored; preserve the concurrent source edit and retry roster update.',
        { path: VENDOR_SKILL_MAP_PATH },
      );
    }
    return {
      ...activation,
      vendor_skill_map: {
        path: VENDOR_SKILL_MAP_PATH,
        status: mapMutation.status,
      },
    };
  });
}

function renderV2Update(result: V2UpdateResult): string[] {
  const lines = ['', chalk.bold('roster update') + chalk.dim('  (v2 activation + vendor-skill map)')];
  for (const host of result.results) {
    const mark = host.assurance === 'missing' ? chalk.red('✗') : chalk.green('✓');
    lines.push(`  ${mark} ${host.host}: ${host.assurance}`);
    for (const file of host.files) {
      const fileMark = file.status === 'conflict' || file.status === 'missing' ? chalk.yellow('!') : chalk.dim('·');
      lines.push(`    ${fileMark} ${file.status.padEnd(18)} ${file.path}`);
    }
  }
  if (result.results.length === 0) {
    lines.push(`  ${chalk.dim('·')} no enabled hosts; synchronized ROSTER.md and generated manifest only`);
  }
  for (const diagnostic of result.diagnostics) {
    lines.push(`  ${chalk.red('!')} ${diagnostic.code}: ${diagnostic.message}`);
    if (diagnostic.remedy !== undefined) lines.push(`    ${chalk.dim(diagnostic.remedy)}`);
  }
  const mapMark = result.vendor_skill_map.status === 'blocked' ? chalk.yellow('!') : chalk.dim('·');
  lines.push(`  ${mapMark} ${result.vendor_skill_map.status.padEnd(18)} ${result.vendor_skill_map.path}`);
  lines.push('');
  return lines;
}

export async function executeUpdate(opts: UpdateCommandOptions): Promise<number> {
  const { cwd } = opts;
  const probe = probeWorkspace(cwd);
  if (probe.kind === 'v2') {
    const result = synchronizeV2WorkspaceUpdate(cwd, detectProjectHostVersions());
    if (opts.json) {
      console.log(JSON.stringify({ version: getPackageVersion(), ...result }, null, 2));
    } else {
      console.log(renderV2Update(result).join('\n'));
    }
    return result.ok ? EXIT_OK : EXIT_ERROR;
  }
  if (probe.kind === 'legacy') throw legacyWorkspaceError(probe.legacySignals);
  if (probe.kind === 'mixed') throw mixedWorkspaceError(probe.v2Signals, probe.legacySignals);
  if (probe.kind === 'unsafe') throw unsafeWorkspaceMarkerError(probe.unsafeSignals);
  throw workspaceRequiredError(cwd);
}
