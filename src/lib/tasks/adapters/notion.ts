import { z } from 'zod';
import type {
  AssignedScope,
  ReadyScope,
  StatusOption,
  StatusSchema,
  Task,
  TaskIdentity,
  TaskSummary,
  TrackerAdapter,
} from './types.ts';

const NOTION_BASE = 'https://api.notion.com';
export const NOTION_VERSION = '2026-03-11';

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface NotionAdapterOptions {
  dataSourceId: string;
  statusProp?: string;
  assigneeProp?: string;
  token?: string;
  projectProp?: string;
  uniqueIdProp?: string;
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export class NotionError extends Error {
  readonly status: number;
  readonly body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'NotionError';
    this.status = status;
    this.body = body;
  }
}

// collection://<uuid> and bare-uuid handles both resolve to the same API id.
export function normalizeDataSourceId(raw: string): string {
  return raw.replace(/^collection:\/\//, '').trim();
}

const emailHolder = z.object({ email: z.string().nullish() }).nullish();
const userLeaf = z.object({ id: z.string(), name: z.string().nullish(), person: emailHolder });
const meSchema = z.union([
  z.object({ type: z.literal('person'), id: z.string(), name: z.string().nullish(), person: emailHolder }),
  z.object({
    type: z.literal('bot'),
    id: z.string(),
    bot: z.object({ owner: z.object({ type: z.string(), user: userLeaf.nullish() }).nullish() }).nullish(),
  }),
]);

const pageSchema = z.object({ id: z.string(), properties: z.record(z.string(), z.any()) });
const querySchema = z.object({
  results: z.array(pageSchema),
  has_more: z.boolean().default(false),
  next_cursor: z.string().nullish(),
});
const dataSourceSchema = z.object({ properties: z.record(z.string(), z.any()) });
const statusPropSchema = z.object({
  type: z.literal('status'),
  status: z.object({
    options: z.array(z.object({ id: z.string(), name: z.string() })),
    groups: z.array(z.object({ id: z.string(), name: z.string(), option_ids: z.array(z.string()) })),
  }),
});

function statusOptionsFromProp(raw: unknown): StatusOption[] {
  const parsed = statusPropSchema.safeParse(raw);
  if (!parsed.success) return [];
  const groupOf = new Map<string, string>();
  for (const group of parsed.data.status.groups) {
    for (const optionId of group.option_ids) groupOf.set(optionId, group.name);
  }
  return parsed.data.status.options.map((o) => ({ name: o.name, category: groupOf.get(o.id) }));
}

export interface BoardProperty {
  name: string;
  type: string;
}
export interface BoardStatusProperty {
  name: string;
  options: StatusOption[];
}
export interface BoardSchema {
  properties: BoardProperty[];
  statusProperties: BoardStatusProperty[];
  assigneeProperties: string[];
  uniqueId?: { property: string; prefix?: string };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class NotionAdapter implements TrackerAdapter {
  private readonly token: string;
  private readonly dataSourceId: string;
  private readonly statusProp: string | undefined;
  private readonly assigneeProp: string | undefined;
  private readonly projectProp?: string;
  private readonly uniqueIdProp?: string;
  private readonly fetchImpl: FetchImpl;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(opts: NotionAdapterOptions) {
    const token = opts.token ?? process.env['NOTION_TOKEN'];
    if (!token) {
      throw new NotionError(0, 'NOTION_TOKEN is not set — provide a Notion Personal Access Token (via Infisical).');
    }
    this.token = token;
    this.dataSourceId = normalizeDataSourceId(opts.dataSourceId);
    this.statusProp = opts.statusProp;
    this.assigneeProp = opts.assigneeProp;
    this.projectProp = opts.projectProp;
    this.uniqueIdProp = opts.uniqueIdProp;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleepImpl = opts.sleepImpl ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(NOTION_BASE + path, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
      if (res.status === 429 && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '0');
        await this.sleepImpl(Number.isFinite(retryAfter) ? retryAfter * 1000 : 0);
        continue;
      }
      const body = await res.json().catch(() => undefined);
      if (!res.ok) throw new NotionError(res.status, this.explain(res.status, body), body);
      return body;
    }
  }

  private explain(status: number, body: unknown): string {
    const detail = (body as { message?: string })?.message;
    switch (status) {
      case 401:
        return 'Notion auth failed (401) — check NOTION_TOKEN is a valid Personal Access Token.';
      case 403:
        return 'Notion access denied (403) — share the board/data source with this token.';
      case 404:
        return `Notion resource not found (404)${detail ? `: ${detail}` : ''}.`;
      case 429:
        return 'Notion rate limit (429) — retries exhausted.';
      default:
        return `Notion request failed (${status})${detail ? `: ${detail}` : ''}.`;
    }
  }

  private requireStatusProp(): string {
    if (!this.statusProp) {
      throw new NotionError(0, 'NotionAdapter has no status property configured — run `roster task setup` to write roster/tracker.yaml first.');
    }
    return this.statusProp;
  }

  private requireAssigneeProp(): string {
    if (!this.assigneeProp) {
      throw new NotionError(0, 'NotionAdapter has no assignee property configured — run `roster task setup` to write roster/tracker.yaml first.');
    }
    return this.assigneeProp;
  }

  async self(): Promise<TaskIdentity> {
    const me = meSchema.parse(await this.request('/v1/users/me'));
    if (me.type === 'person') {
      return { id: me.id, name: me.name ?? undefined, email: me.person?.email ?? undefined };
    }
    const user = me.bot?.owner?.user;
    if (!user) {
      throw new NotionError(
        0,
        'Token resolves to a workspace-level bot with no user owner — use a user-scoped Personal Access Token so assignment can be attributed to you.',
      );
    }
    return { id: user.id, name: user.name ?? undefined, email: user.person?.email ?? undefined };
  }

  async listReady(scope: ReadyScope): Promise<TaskSummary[]> {
    if (scope.readyStatuses.length === 0) {
      throw new NotionError(0, 'listReady requires at least one ready status name — the caller must pass the mapped "ready" statuses, not an empty list.');
    }
    if (scope.projectValues?.length && !this.projectProp) {
      throw new NotionError(0, 'listReady received projectValues but no projectProp is configured — refusing to silently widen the query to all projects.');
    }
    const statusProp = this.requireStatusProp();
    const assigneeProp = this.requireAssigneeProp();
    const and: unknown[] = [
      { or: scope.readyStatuses.map((name) => ({ property: statusProp, status: { equals: name } })) },
    ];
    if (scope.assigneeId) {
      and.push({
        or: [
          { property: assigneeProp, people: { contains: scope.assigneeId } },
          { property: assigneeProp, people: { is_empty: true } },
        ],
      });
    }
    if (scope.projectValues?.length && this.projectProp) {
      const prop = this.projectProp;
      and.push({ or: scope.projectValues.map((value) => ({ property: prop, select: { equals: value } })) });
    }

    const out: TaskSummary[] = [];
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = {};
      if (and.length > 0) body['filter'] = { and };
      if (cursor) body['start_cursor'] = cursor;
      const page = querySchema.parse(
        await this.request(`/v1/data_sources/${this.dataSourceId}/query`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );
      for (const result of page.results) out.push(this.toSummary(result));
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
      if (page.has_more && !cursor) break;
    } while (cursor);
    return out;
  }

  async listAssigned(scope: AssignedScope): Promise<TaskSummary[]> {
    if (scope.projectValues?.length && !this.projectProp) {
      throw new NotionError(0, 'listAssigned received projectValues but no projectProp is configured — refusing to silently widen the query to all projects.');
    }
    const statusProp = this.requireStatusProp();
    const assigneeProp = this.requireAssigneeProp();
    const and: unknown[] = [{ property: assigneeProp, people: { contains: scope.assigneeId } }];
    if (scope.statusNames?.length) {
      and.push({ or: scope.statusNames.map((name) => ({ property: statusProp, status: { equals: name } })) });
    }
    if (scope.projectValues?.length && this.projectProp) {
      const prop = this.projectProp;
      and.push({ or: scope.projectValues.map((value) => ({ property: prop, select: { equals: value } })) });
    }

    const out: TaskSummary[] = [];
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = { filter: { and } };
      if (cursor) body['start_cursor'] = cursor;
      const page = querySchema.parse(
        await this.request(`/v1/data_sources/${this.dataSourceId}/query`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );
      for (const result of page.results) out.push(this.toSummary(result));
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
      if (page.has_more && !cursor) break;
    } while (cursor);
    return out;
  }

  async getTask(handle: string): Promise<Task> {
    this.requireStatusProp();
    this.requireAssigneeProp();
    const byUniqueId = this.parseUniqueId(handle);
    if (byUniqueId !== undefined && this.uniqueIdProp) {
      const prop = this.uniqueIdProp;
      const page = querySchema.parse(
        await this.request(`/v1/data_sources/${this.dataSourceId}/query`, {
          method: 'POST',
          body: JSON.stringify({ filter: { property: prop, unique_id: { equals: byUniqueId } }, page_size: 2 }),
        }),
      );
      if (page.results.length === 0) throw new NotionError(404, `No task matches handle "${handle}".`);
      if (page.results.length > 1) throw new NotionError(409, `Handle "${handle}" is ambiguous (${page.results.length} matches).`);
      return this.toTask(page.results[0]!);
    }
    const page = pageSchema.parse(await this.request(`/v1/pages/${handle}`));
    return this.toTask(page);
  }

  async setStatus(taskId: string, statusName: string): Promise<void> {
    await this.request(`/v1/pages/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { [this.requireStatusProp()]: { status: { name: statusName } } } }),
    });
  }

  async setAssignee(taskId: string, userId: string): Promise<void> {
    await this.setAssignees(taskId, [userId]);
  }

  // Replace the full assignee set. Passing [] clears it. Used to restore prior
  // state (including multi-user and empty) after a claim.
  async setAssignees(taskId: string, userIds: string[]): Promise<void> {
    await this.request(`/v1/pages/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { [this.requireAssigneeProp()]: { people: userIds.map((id) => ({ id })) } } }),
    });
  }

  // Post a comment on the task page. Notion comments carry no idempotency key,
  // so a retry after a partial failure can duplicate — the verb layer documents
  // this. Used to record a block reason on the shared board.
  async comment(taskId: string, text: string): Promise<void> {
    await this.request('/v1/comments', {
      method: 'POST',
      body: JSON.stringify({ parent: { page_id: taskId }, rich_text: [{ type: 'text', text: { content: text } }] }),
    });
  }

  async introspectStatuses(): Promise<StatusSchema> {
    const statusProp = this.requireStatusProp();
    const board = await this.describeBoard();
    const status = board.statusProperties.find((s) => s.name === statusProp);
    if (!status) {
      throw new NotionError(0, `Property "${statusProp}" is not a Notion status property on this data source.`);
    }
    return {
      statuses: status.options,
      hasUniqueId: board.uniqueId !== undefined,
      uniqueIdPrefix: board.uniqueId?.prefix,
    };
  }

  // Schema discovery that presumes nothing configured — used by `roster task
  // setup` to find the status/assignee/unique-id columns before a mapping exists.
  async describeBoard(): Promise<BoardSchema> {
    const ds = dataSourceSchema.parse(await this.request(`/v1/data_sources/${this.dataSourceId}`));
    const properties: BoardProperty[] = [];
    const statusProperties: BoardStatusProperty[] = [];
    const assigneeProperties: string[] = [];
    let uniqueId: BoardSchema['uniqueId'];
    for (const [name, value] of Object.entries(ds.properties)) {
      const type = (value as { type?: string })?.type ?? 'unknown';
      properties.push({ name, type });
      if (type === 'status') {
        statusProperties.push({ name, options: statusOptionsFromProp(value) });
      } else if (type === 'people') {
        assigneeProperties.push(name);
      } else if (type === 'unique_id') {
        const prefix = (value as { unique_id?: { prefix?: string | null } }).unique_id?.prefix;
        uniqueId = { property: name, prefix: prefix ?? undefined };
      }
    }
    return { properties, statusProperties, assigneeProperties, uniqueId };
  }

  private parseUniqueId(handle: string): number | undefined {
    const m = /^(?:[A-Za-z][A-Za-z0-9]*-)?(\d+)$/.exec(handle.trim());
    return m ? Number(m[1]) : undefined;
  }

  private toSummary(page: z.infer<typeof pageSchema>): TaskSummary {
    const props = page.properties;
    return {
      id: page.id,
      handle: this.handleOf(page),
      title: this.titleOf(props),
      status: this.statusOf(props, this.requireStatusProp()),
      assigneeIds: this.assigneesOf(props, this.requireAssigneeProp()),
    };
  }

  private toTask(page: z.infer<typeof pageSchema>): Task {
    return { ...this.toSummary(page), props: page.properties };
  }

  private handleOf(page: z.infer<typeof pageSchema>): string {
    if (this.uniqueIdProp) {
      const uid = page.properties[this.uniqueIdProp]?.unique_id as { prefix?: string | null; number?: number } | undefined;
      if (uid?.number !== undefined && uid.number !== null) {
        return uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number);
      }
    }
    return page.id;
  }

  private titleOf(props: Record<string, unknown>): string {
    for (const value of Object.values(props)) {
      const v = value as { type?: string; title?: Array<{ plain_text?: string }> };
      if (v?.type === 'title') return (v.title ?? []).map((t) => t.plain_text ?? '').join('');
    }
    return '';
  }

  private statusOf(props: Record<string, unknown>, statusProp: string): string {
    const v = props[statusProp] as { status?: { name?: string } | null } | undefined;
    return v?.status?.name ?? '';
  }

  private assigneesOf(props: Record<string, unknown>, assigneeProp: string): string[] {
    const v = props[assigneeProp] as { people?: Array<{ id?: string }> } | undefined;
    return (v?.people ?? []).map((p) => p.id).filter((id): id is string => typeof id === 'string');
  }
}
