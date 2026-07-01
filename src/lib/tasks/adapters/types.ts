// Generic tracker-adapter contract. No tracker-specific vocabulary leaks here —
// Notion/Linear/GitHub encodings live entirely inside their own adapter file.

export interface TaskIdentity {
  id: string;
  name?: string;
  email?: string;
}

// A status option as it exists on the user's board. `category` is an optional,
// generic grouping hint (Notion status group, Linear state type, GitHub
// open/closed) that the setup wizard (C3) uses to suggest canonical mappings.
export interface StatusOption {
  name: string;
  category?: string;
}

export interface TaskSummary {
  id: string;
  handle: string;
  title: string;
  status: string;
  assigneeIds: string[];
}

export interface Task extends TaskSummary {
  props?: Record<string, unknown>;
  body?: string;
}

// Concrete filter values supplied by the caller (the verb layer, after reading
// the C3 mapping). The adapter is mapping-agnostic: it never knows which
// canonical state a status name maps to — it only filters on the names given.
export interface ReadyScope {
  readyStatuses: string[];
  assigneeId?: string;
  projectValues?: string[];
}

// Bounded query for a user's in-flight tasks. `statusNames` restricts to mapped
// statuses (so reverse-mapping can never hit an unmapped status), and
// `projectValues` honors the configured project filter. Both keep the fuzzy
// selector pool + status report from pulling in out-of-scope rows.
export interface AssignedScope {
  assigneeId: string;
  statusNames?: string[];
  projectValues?: string[];
}

export interface StatusSchema {
  statuses: StatusOption[];
  hasUniqueId: boolean;
  uniqueIdPrefix?: string;
}

export interface TrackerAdapter {
  self(): Promise<TaskIdentity>;
  listReady(scope: ReadyScope): Promise<TaskSummary[]>;
  listAssigned(scope: AssignedScope): Promise<TaskSummary[]>;
  getTask(handle: string): Promise<Task>;
  setStatus(taskId: string, statusName: string): Promise<void>;
  setAssignee(taskId: string, userId: string): Promise<void>;
  comment(taskId: string, text: string): Promise<void>;
  introspectStatuses(): Promise<StatusSchema>;
}
