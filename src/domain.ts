export const agentStates = [
  'new',
  'queued',
  'running',
  'idle',
  'cancelling',
  'disconnected',
  'needs_attention',
  'closed',
] as const;

export type AgentState = (typeof agentStates)[number];

export const turnStatuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'interrupted',
  'timed_out',
] as const;

export type TurnStatus = (typeof turnStatuses)[number];

export type TerminalTurnStatus = Exclude<TurnStatus, 'queued' | 'running'>;

export const messageStates = ['pending', 'leased', 'acknowledged'] as const;

export type MessageState = (typeof messageStates)[number];

export const permissionProfiles = ['read_only', 'workspace_write'] as const;

export type PermissionProfile = (typeof permissionProfiles)[number];

export type WorkspaceLockMode = 'reader' | 'writer';

export const messageKinds = ['message', 'followup'] as const;

export type MessageKind = (typeof messageKinds)[number];

export const eventTypes = [
  'agent.created',
  'agent.queued',
  'agent.idle',
  'agent.cancelling',
  'agent.needs_attention',
  'agent.stalled',
  'message.enqueued',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
] as const;

export type EventType = (typeof eventTypes)[number];

export interface Agent {
  id: string;
  sessionId: string;
  sessionStartedAt: string | null;
  state: AgentState;
  task: string;
  cwd: string | null;
  permissionProfile: PermissionProfile;
  model: string | null;
  effort: string | null;
  name: string | null;
  lastActivityAt: string | null;
  stallReportedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Turn {
  id: string;
  agentId: string;
  number: number;
  status: TurnStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  kind: MessageKind;
  content: string;
  state: MessageState;
  createdAt: string;
}

export interface Event {
  sequence: string;
  agentId: string;
  type: EventType;
  payload: unknown;
  createdAt: string;
}

export interface ProcessIdentity {
  pid: number;
  startedAt: string;
}

export interface RuntimeLease {
  agentId: string;
  serverId: string;
  acquiredAt: string;
  expiresAt: string | null;
  pid: number | null;
  processStartedAt: string | null;
  confirmedDeadAt: string | null;
}

export interface RuntimeExecutable {
  serverId: string;
  path: string;
  version: string;
  recordedAt: string;
}

export interface ClaudeEvent {
  sequence: string;
  agentId: string;
  turnId: string;
  type: string;
  payload: unknown;
  raw: string;
  createdAt: string;
}

export interface CreateAgentInput {
  task: string;
  cwd?: string;
  permissionProfile?: PermissionProfile;
  model?: string;
  effort?: string;
  name?: string;
  sessionId?: string;
}

export interface ReadEventsInput {
  agentIds: readonly string[];
  after: number | string;
  limit: number;
}

export interface ScheduledAgent {
  agent: Agent;
  turn: Turn;
  messages: Message[];
}
