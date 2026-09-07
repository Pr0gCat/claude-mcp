import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

import type {
  Agent,
  AgentState,
  ClaudeEvent,
  CreateAgentInput,
  Event,
  EventType,
  Message,
  MessageKind,
  ProcessIdentity,
  ReadEventsInput,
  ScheduledAgent,
  RuntimeLease,
  RuntimeExecutable,
  TerminalTurnStatus,
  Turn,
  TurnStatus,
  WorkspaceLockMode,
} from './domain.js';

interface AgentRow {
  id: string;
  session_id: string;
  session_started_at: string | null;
  state: AgentState;
  task: string;
  cwd: string | null;
  permission_profile: Agent['permissionProfile'];
  model: string | null;
  effort: string | null;
  name: string | null;
  last_activity_at: string | null;
  stall_reported_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  id: string;
  agent_id: string;
  number: bigint;
  status: TurnStatus;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  agent_id: string;
  kind: MessageKind;
  content: string;
  state: Message['state'];
  created_at: string;
}

interface EventRow {
  sequence: bigint;
  agent_id: string;
  type: EventType;
  payload: string;
  created_at: string;
}

interface RuntimeLeaseRow {
  agent_id: string;
  server_id: string;
  acquired_at: string;
  expires_at: string | null;
  pid: bigint | null;
  process_started_at: string | null;
  confirmed_dead_at: string | null;
}

interface ClaudeEventRow {
  sequence: bigint;
  agent_id: string;
  turn_id: string;
  type: string;
  payload: string;
  raw: string;
  created_at: string;
}

export class AgentMailStateError extends Error {
  constructor(readonly state: AgentState) {
    super(`agent state does not accept mail: ${state}`);
    this.name = 'AgentMailStateError';
  }
}

function asAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionStartedAt: row.session_started_at,
    state: row.state,
    task: row.task,
    cwd: row.cwd,
    permissionProfile: row.permission_profile,
    model: row.model,
    effort: row.effort,
    name: row.name,
    lastActivityAt: row.last_activity_at,
    stallReportedAt: row.stall_reported_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asTurn(row: TurnRow): Turn {
  if (row.number < 1n || row.number > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('turn number must be a positive safe integer');
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    number: Number(row.number),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asMessage(row: MessageRow): Message {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind,
    content: row.content,
    state: row.state,
    createdAt: row.created_at,
  };
}

function asEvent(row: EventRow): Event {
  return {
    sequence: row.sequence.toString(),
    agentId: row.agent_id,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  };
}

function asRuntimeLease(row: RuntimeLeaseRow): RuntimeLease {
  if (row.pid !== null && (row.pid < 1n || row.pid > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error('runtime process PID must be a positive safe integer');
  }
  return {
    agentId: row.agent_id,
    serverId: row.server_id,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    pid: row.pid === null ? null : Number(row.pid),
    processStartedAt: row.process_started_at,
    confirmedDeadAt: row.confirmed_dead_at,
  };
}

function asClaudeEvent(row: ClaudeEventRow): ClaudeEvent {
  return {
    sequence: row.sequence.toString(),
    agentId: row.agent_id,
    turnId: row.turn_id,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    raw: row.raw,
    createdAt: row.created_at,
  };
}

function parseCursor(cursor: number | string): string {
  if (typeof cursor === 'number') {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error('event cursor must be a non-negative safe integer');
    }
    return cursor.toString();
  }
  if (!/^(0|[1-9]\d*)$/.test(cursor)) {
    throw new Error('event cursor must be a non-negative integer');
  }
  return cursor;
}

export class AgentStore {
  readonly #database: Database.Database;
  readonly #eventListeners = new Set<() => void>();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new Database(path);
    this.#database.pragma('journal_mode = WAL');
    this.#database.pragma('foreign_keys = ON');
    this.#database.pragma('busy_timeout = 5000');
    this.#database.defaultSafeIntegers(true);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        session_started_at TEXT,
        state TEXT NOT NULL,
        task TEXT NOT NULL,
        cwd TEXT,
        permission_profile TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        number INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, number)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS turn_messages (
        turn_id TEXT NOT NULL REFERENCES turns(id),
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (turn_id, ordinal)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS scheduler_queue (
        sequence INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id),
        workspace_key TEXT NOT NULL,
        lock_mode TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS process_leases (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        server_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT,
        pid INTEGER,
        process_started_at TEXT,
        confirmed_dead_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workspace_locks (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        workspace_key TEXT NOT NULL,
        lock_mode TEXT NOT NULL,
        server_id TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_agent_sequence ON events(agent_id, sequence);
      CREATE INDEX IF NOT EXISTS messages_agent_state ON messages(agent_id, state);
      CREATE TABLE IF NOT EXISTS claude_events (
        sequence INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        turn_id TEXT NOT NULL REFERENCES turns(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        raw TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS claude_events_agent_sequence
        ON claude_events(agent_id, sequence);
      CREATE TABLE IF NOT EXISTS runtime_executables (
        server_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        version TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS interrupt_requests (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        requested_at TEXT NOT NULL,
        acknowledged_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS server_instances (
        server_id TEXT PRIMARY KEY,
        registered_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      ) STRICT;
    `);
    this.ensureColumn('agents', 'session_started_at', 'TEXT');
    this.ensureColumn('agents', 'last_activity_at', 'TEXT');
    this.ensureColumn('agents', 'stall_reported_at', 'TEXT');
    this.ensureColumn('process_leases', 'expires_at', 'TEXT');
    this.ensureColumn('process_leases', 'pid', 'INTEGER');
    this.ensureColumn('process_leases', 'process_started_at', 'TEXT');
    this.ensureColumn('process_leases', 'confirmed_dead_at', 'TEXT');
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS agents_stall_candidates
      ON agents(last_activity_at)
      WHERE state = 'running'
        AND stall_reported_at IS NULL
        AND last_activity_at IS NOT NULL
    `);
  }

  close(): void {
    this.#eventListeners.clear();
    this.#database.close();
  }

  registerServerInstance(serverId: string, at = new Date().toISOString()): void {
    this.validateServerHeartbeat(serverId, at);
    this.#database.prepare(`
      INSERT INTO server_instances (server_id, registered_at, heartbeat_at)
      VALUES (?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        registered_at = excluded.registered_at,
        heartbeat_at = excluded.heartbeat_at
    `).run(serverId, at, at);
  }

  heartbeatServerInstance(serverId: string, at = new Date().toISOString()): boolean {
    this.validateServerHeartbeat(serverId, at);
    const result = this.#database.prepare(`
      UPDATE server_instances SET heartbeat_at = ? WHERE server_id = ?
    `).run(at, serverId);
    return result.changes === 1;
  }

  unregisterServerInstance(serverId: string): boolean {
    const result = this.#database.prepare(`DELETE FROM server_instances WHERE server_id = ?`)
      .run(serverId);
    return result.changes === 1;
  }

  isServerInstanceFresh(serverId: string, staleBefore: string): boolean {
    this.validateServerHeartbeat(serverId, staleBefore);
    return this.#database.prepare(`
      SELECT 1 FROM server_instances
      WHERE server_id = ? AND heartbeat_at >= ?
    `).get(serverId, staleBefore) !== undefined;
  }

  private validateServerHeartbeat(serverId: string, at: string): void {
    if (serverId.trim() === '') throw new Error('server instance id must not be empty');
    if (Number.isNaN(Date.parse(at))) throw new Error('server heartbeat must be an ISO timestamp');
  }

  private ensureColumn(table: 'agents' | 'process_leases', name: string, type: 'TEXT' | 'INTEGER'): void {
    const columns = this.#database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }

  createAgent(input: CreateAgentInput): { agent: Agent; turn: Turn } {
    if (input.task.trim() === '') throw new Error('agent task must not be empty');

    const createdAt = new Date().toISOString();
    const agent: Agent = {
      id: randomUUID(),
      sessionId: input.sessionId ?? randomUUID(),
      sessionStartedAt: null,
      state: 'queued',
      task: input.task,
      cwd: input.cwd ?? null,
      permissionProfile: input.permissionProfile ?? 'read_only',
      model: input.model ?? null,
      effort: input.effort ?? null,
      name: input.name ?? null,
      lastActivityAt: null,
      stallReportedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    const turn: Turn = {
      id: randomUUID(),
      agentId: agent.id,
      number: 1,
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
    };

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        INSERT INTO agents (id, session_id, session_started_at, state, task, cwd, permission_profile, model, effort, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        agent.id, agent.sessionId, agent.sessionStartedAt, agent.state, agent.task, agent.cwd, agent.permissionProfile,
        agent.model, agent.effort, agent.name, agent.createdAt, agent.updatedAt,
      );
      this.#database.prepare(`
        INSERT INTO turns (id, agent_id, number, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(turn.id, turn.agentId, turn.number, turn.status, turn.createdAt, turn.updatedAt);
      this.insertEvent(agent.id, 'agent.created', { agentId: agent.id, turnId: turn.id }, createdAt);
      const persistedTurn = this.#database.prepare(`
        SELECT id, agent_id, number, status, created_at, updated_at
        FROM turns
        WHERE id = ?
      `).get(turn.id) as TurnRow | undefined;
      if (!persistedTurn) throw new Error('created turn could not be read');
      const mappedTurn = asTurn(persistedTurn);
      this.#database.exec('COMMIT');
      this.notifyEventListeners();
      return { agent, turn: mappedTurn };
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  createAgentWithInitialTask(
    input: CreateAgentInput,
  ): { agent: Agent; turn: Turn; message: Message; cursor: string } {
    if (input.task.trim() === '') throw new Error('agent task must not be empty');

    const createdAt = new Date().toISOString();
    const agent: Agent = {
      id: randomUUID(),
      sessionId: input.sessionId ?? randomUUID(),
      sessionStartedAt: null,
      state: 'queued',
      task: input.task,
      cwd: input.cwd ?? null,
      permissionProfile: input.permissionProfile ?? 'read_only',
      model: input.model ?? null,
      effort: input.effort ?? null,
      name: input.name ?? null,
      lastActivityAt: null,
      stallReportedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    const turn: Turn = {
      id: randomUUID(),
      agentId: agent.id,
      number: 1,
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
    };
    const message: Message = {
      id: randomUUID(),
      agentId: agent.id,
      kind: 'followup',
      content: input.task,
      state: 'pending',
      createdAt,
    };

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        INSERT INTO agents (id, session_id, session_started_at, state, task, cwd, permission_profile, model, effort, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        agent.id, agent.sessionId, agent.sessionStartedAt, agent.state, agent.task, agent.cwd,
        agent.permissionProfile, agent.model, agent.effort, agent.name, agent.createdAt, agent.updatedAt,
      );
      this.#database.prepare(`
        INSERT INTO turns (id, agent_id, number, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(turn.id, turn.agentId, turn.number, turn.status, turn.createdAt, turn.updatedAt);
      this.#database.prepare(`
        INSERT INTO messages (id, agent_id, kind, content, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(message.id, message.agentId, message.kind, message.content, message.state, message.createdAt);
      this.insertEvent(agent.id, 'agent.created', { agentId: agent.id, turnId: turn.id }, createdAt);
      const cursor = this.insertEvent(
        agent.id,
        'message.enqueued',
        { messageId: message.id, kind: message.kind },
        createdAt,
      );
      this.#database.exec('COMMIT');
      this.notifyEventListeners();
      return { agent, turn, message, cursor };
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  enqueueMessage(
    agentId: string,
    kind: MessageKind,
    content: string,
    acceptedStates?: readonly AgentState[],
  ): { message: Message; cursor: string } {
    if (content.trim() === '') throw new Error('message content must not be empty');

    const message: Message = {
      id: randomUUID(),
      agentId,
      kind,
      content,
      state: 'pending',
      createdAt: new Date().toISOString(),
    };

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const agent = this.#database.prepare(`SELECT state FROM agents WHERE id = ?`)
        .get(agentId) as { state: AgentState } | undefined;
      if (!agent) throw new Error('agent not found');
      if (acceptedStates && !acceptedStates.includes(agent.state)) {
        throw new AgentMailStateError(agent.state);
      }
      this.#database.prepare(`
        INSERT INTO messages (id, agent_id, kind, content, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(message.id, message.agentId, message.kind, message.content, message.state, message.createdAt);
      const cursor = this.insertEvent(agentId, 'message.enqueued', { messageId: message.id }, message.createdAt);
      this.#database.exec('COMMIT');
      this.notifyEventListeners();
      return { message, cursor: String(cursor) };
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  leaseMessages(agentId: string, turnId: string): Message[] {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const messages = this.leaseMessagesInTransaction(agentId, turnId);
      this.#database.exec('COMMIT');
      return messages;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  leasePendingMessages(agentId: string, turnId: string, serverId: string): Message[] {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const ownership = this.#database.prepare(`
        SELECT 1 FROM process_leases WHERE agent_id = ? AND server_id = ?
      `).get(agentId, serverId);
      if (!ownership) throw new Error('runtime lease is not owned by server');
      const messages = this.leasePendingMessagesInTransaction(agentId, turnId, undefined, true);
      this.#database.exec('COMMIT');
      return messages;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  completeTurn(
    turnId: string,
    status: TerminalTurnStatus,
  ): { acknowledged: number; completed: boolean } {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const completedAt = new Date().toISOString();
      const completed = this.#database.prepare(`
        UPDATE turns
        SET status = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(status, completedAt, turnId);
      if (completed.changes === 0) {
        this.#database.exec('COMMIT');
        return { acknowledged: 0, completed: false };
      }
      const acknowledged = this.#database.prepare(`
        UPDATE messages
        SET state = 'acknowledged'
        WHERE state = 'leased'
          AND id IN (SELECT message_id FROM turn_messages WHERE turn_id = ?)
      `).run(turnId);
      const turn = this.#database.prepare(`
        SELECT agent_id FROM turns WHERE id = ?
      `).get(turnId) as { agent_id: string };
      const eventType: EventType = status === 'succeeded'
        ? 'turn.completed'
        : status === 'interrupted'
          ? 'turn.interrupted'
          : 'turn.failed';
      this.insertEvent(
        turn.agent_id,
        eventType,
        { turnId, status, acknowledged: Number(acknowledged.changes) },
        completedAt,
      );
      this.#database.exec('COMMIT');
      this.notifyEventListeners();
      return { acknowledged: Number(acknowledged.changes), completed: true };
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  getAgent(agentId: string): Agent | undefined {
    const row = this.#database.prepare(`
      SELECT id, session_id, session_started_at, state, task, cwd, permission_profile, model, effort, name, last_activity_at, stall_reported_at, created_at, updated_at
      FROM agents WHERE id = ?
    `).get(agentId) as AgentRow | undefined;
    return row ? asAgent(row) : undefined;
  }

  listAgents(): Agent[] {
    const rows = this.#database.prepare(`
      SELECT id, session_id, session_started_at, state, task, cwd, permission_profile, model, effort, name, last_activity_at, stall_reported_at, created_at, updated_at
      FROM agents
      ORDER BY created_at ASC, id ASC
    `).all() as AgentRow[];
    return rows.map(asAgent);
  }

  getTurn(turnId: string): Turn | undefined {
    const row = this.#database.prepare(`
      SELECT id, agent_id, number, status, created_at, updated_at
      FROM turns WHERE id = ?
    `).get(turnId) as TurnRow | undefined;
    return row ? asTurn(row) : undefined;
  }

  listTurns(agentId: string): Turn[] {
    const rows = this.#database.prepare(`
      SELECT id, agent_id, number, status, created_at, updated_at
      FROM turns WHERE agent_id = ?
      ORDER BY number ASC
    `).all(agentId) as TurnRow[];
    return rows.map(asTurn);
  }

  getMessage(messageId: string): Message | undefined {
    const row = this.#database.prepare(`
      SELECT id, agent_id, kind, content, state, created_at
      FROM messages WHERE id = ?
    `).get(messageId) as MessageRow | undefined;
    return row ? asMessage(row) : undefined;
  }

  readPendingMessages(agentId: string): Message[] {
    const rows = this.#database.prepare(`
      SELECT id, agent_id, kind, content, state, created_at
      FROM messages
      WHERE agent_id = ? AND state = 'pending'
      ORDER BY rowid ASC
    `).all(agentId) as MessageRow[];
    return rows.map(asMessage);
  }

  mailboxDepth(agentId: string): number {
    const row = this.#database.prepare(`
      SELECT count(*) AS count FROM messages
      WHERE agent_id = ? AND state != 'acknowledged'
    `).get(agentId) as { count: bigint };
    if (row.count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('mailbox depth exceeds safe integer range');
    return Number(row.count);
  }

  mailboxReceipt(agentId: string, messageId: string): { queuedOnly: boolean; mailboxDepth: number } {
    this.#database.exec('BEGIN');
    try {
      const message = this.#database.prepare(`
        SELECT state FROM messages WHERE id = ? AND agent_id = ?
      `).get(messageId, agentId) as { state: Message['state'] } | undefined;
      if (!message) throw new Error('message not found');
      const row = this.#database.prepare(`
        SELECT count(*) AS count FROM messages
        WHERE agent_id = ? AND state != 'acknowledged'
      `).get(agentId) as { count: bigint };
      if (row.count > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('mailbox depth exceeds safe integer range');
      }
      this.#database.exec('COMMIT');
      return {
        queuedOnly: message.state === 'pending',
        mailboxDepth: Number(row.count),
      };
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  pendingMessageCount(agentId: string): number {
    const row = this.#database.prepare(`
      SELECT count(*) AS count FROM messages
      WHERE agent_id = ? AND state = 'pending'
    `).get(agentId) as { count: bigint };
    if (row.count > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('pending message count exceeds safe integer range');
    }
    return Number(row.count);
  }

  isClaudeSessionStarted(agentId: string): boolean {
    const row = this.#database.prepare(`
      SELECT session_started_at FROM agents WHERE id = ?
    `).get(agentId) as { session_started_at: string | null } | undefined;
    if (!row) throw new Error('agent not found');
    return row.session_started_at !== null;
  }

  markClaudeSessionStarted(agentId: string): string {
    const startedAt = new Date().toISOString();
    const result = this.#database.prepare(`
      UPDATE agents
      SET session_started_at = COALESCE(session_started_at, ?), updated_at = ?
      WHERE id = ?
    `).run(startedAt, startedAt, agentId);
    if (result.changes !== 1) throw new Error('agent not found');
    const row = this.#database.prepare(`
      SELECT session_started_at FROM agents WHERE id = ?
    `).get(agentId) as { session_started_at: string };
    return row.session_started_at;
  }

  recordRuntimeExecutable(serverId: string, path: string, version: string): RuntimeExecutable {
    if (serverId.trim() === '' || path.trim() === '' || version.trim() === '') {
      throw new Error('runtime executable metadata must not be empty');
    }
    const recordedAt = new Date().toISOString();
    this.#database.prepare(`
      INSERT OR IGNORE INTO runtime_executables (server_id, path, version, recorded_at)
      VALUES (?, ?, ?, ?)
    `).run(serverId, path, version, recordedAt);
    const executable = this.getRuntimeExecutable(serverId);
    if (!executable) throw new Error('runtime executable metadata was not recorded');
    if (executable.path !== path || executable.version !== version) {
      throw new Error('runtime executable changed for an existing server');
    }
    return executable;
  }

  getRuntimeExecutable(serverId: string): RuntimeExecutable | undefined {
    const row = this.#database.prepare(`
      SELECT server_id, path, version, recorded_at
      FROM runtime_executables WHERE server_id = ?
    `).get(serverId) as {
      server_id: string;
      path: string;
      version: string;
      recorded_at: string;
    } | undefined;
    return row ? {
      serverId: row.server_id,
      path: row.path,
      version: row.version,
      recordedAt: row.recorded_at,
    } : undefined;
  }

  attachRuntimeProcess(
    agentId: string,
    serverId: string,
    identity: ProcessIdentity,
    expiresAt: string,
  ): boolean {
    if (!Number.isSafeInteger(identity.pid) || identity.pid < 1) {
      throw new Error('runtime process PID must be a positive safe integer');
    }
    if (Number.isNaN(Date.parse(identity.startedAt))) {
      throw new Error('runtime process creation time must be an ISO timestamp');
    }
    if (Number.isNaN(Date.parse(expiresAt))) {
      throw new Error('runtime lease expiry must be an ISO timestamp');
    }
    const result = this.#database.prepare(`
      UPDATE process_leases
      SET pid = ?, process_started_at = ?, expires_at = ?, confirmed_dead_at = NULL
      WHERE agent_id = ? AND server_id = ?
    `).run(identity.pid, identity.startedAt, expiresAt, agentId, serverId);
    return result.changes === 1;
  }

  containRuntimeProcess(
    agentId: string,
    serverId: string,
    identity: ProcessIdentity,
    expiresAt: string,
  ): boolean {
    if (!Number.isSafeInteger(identity.pid) || identity.pid < 1) {
      throw new Error('runtime process PID must be a positive safe integer');
    }
    if (Number.isNaN(Date.parse(identity.startedAt))) {
      throw new Error('runtime process creation time must be an ISO timestamp');
    }
    if (Number.isNaN(Date.parse(expiresAt))) {
      throw new Error('runtime lease expiry must be an ISO timestamp');
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const retained = this.#database.prepare(`
        UPDATE process_leases
        SET pid = ?, process_started_at = ?, expires_at = ?, confirmed_dead_at = NULL
        WHERE agent_id = ? AND server_id = ?
      `).run(identity.pid, identity.startedAt, expiresAt, agentId, serverId);
      if (retained.changes === 1) {
        this.markNeedsAttentionInTransaction(agentId, 'runtime_containment');
      }
      this.#database.exec('COMMIT');
      if (retained.changes === 1) this.notifyEventListeners();
      return retained.changes === 1;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  markRuntimeNeedsAttention(agentId: string): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.markNeedsAttentionInTransaction(agentId, 'runtime_ownership_unknown');
      this.#database.exec('COMMIT');
      if (changed) this.notifyEventListeners();
      return changed;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  markRuntimeNeedsAttentionIfOwnerStale(lease: RuntimeLease, staleBefore: string): boolean {
    this.validateServerHeartbeat(lease.serverId, staleBefore);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const stillOrphaned = this.#database.prepare(`
        SELECT 1
        FROM process_leases p
        WHERE p.agent_id = ?
          AND p.server_id = ?
          AND p.pid IS ?
          AND p.process_started_at IS ?
          AND p.confirmed_dead_at IS ?
          AND NOT EXISTS (
            SELECT 1 FROM server_instances s
            WHERE s.server_id = p.server_id AND s.heartbeat_at >= ?
          )
      `).get(
        lease.agentId,
        lease.serverId,
        lease.pid,
        lease.processStartedAt,
        lease.confirmedDeadAt,
        staleBefore,
      );
      const changed = stillOrphaned
        ? this.markNeedsAttentionInTransaction(lease.agentId, 'runtime_ownership_unknown')
        : false;
      this.#database.exec('COMMIT');
      if (changed) this.notifyEventListeners();
      return changed;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  retainUnconfirmedRuntimeProcess(
    agentId: string,
    serverId: string,
    pid: number,
    expiresAt: string,
  ): boolean {
    if (!Number.isSafeInteger(pid) || pid < 1) {
      throw new Error('runtime process PID must be a positive safe integer');
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const retained = this.#database.prepare(`
        UPDATE process_leases
        SET pid = ?, process_started_at = NULL, expires_at = ?, confirmed_dead_at = NULL
        WHERE agent_id = ? AND server_id = ?
      `).run(pid, expiresAt, agentId, serverId);
      if (retained.changes === 1) {
        this.markNeedsAttentionInTransaction(agentId, 'runtime_identity_incomplete');
      }
      this.#database.exec('COMMIT');
      if (retained.changes === 1) this.notifyEventListeners();
      return retained.changes === 1;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  listRuntimeLeases(): RuntimeLease[] {
    const rows = this.#database.prepare(`
      SELECT agent_id, server_id, acquired_at, expires_at, pid,
             process_started_at, confirmed_dead_at
      FROM process_leases
      ORDER BY acquired_at, agent_id
    `).all() as RuntimeLeaseRow[];
    return rows.map(asRuntimeLease);
  }

  confirmRuntimeProcessDead(agentId: string, identity: ProcessIdentity): boolean {
    const result = this.#database.prepare(`
      UPDATE process_leases
      SET confirmed_dead_at = ?
      WHERE agent_id = ? AND pid = ? AND process_started_at = ?
        AND confirmed_dead_at IS NULL
    `).run(new Date().toISOString(), agentId, identity.pid, identity.startedAt);
    return result.changes === 1;
  }

  reconcileDeadRuntime(
    agentId: string,
    identity: ProcessIdentity,
    staleOwner?: { serverId: string; staleBefore: string },
  ): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (staleOwner) this.validateServerHeartbeat(staleOwner.serverId, staleOwner.staleBefore);
      const lease = (staleOwner
        ? this.#database.prepare(`
            SELECT p.server_id
            FROM process_leases p
            WHERE p.agent_id = ? AND p.pid = ? AND p.process_started_at = ?
              AND p.server_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM server_instances s
                WHERE s.server_id = p.server_id AND s.heartbeat_at >= ?
              )
          `).get(
            agentId,
            identity.pid,
            identity.startedAt,
            staleOwner.serverId,
            staleOwner.staleBefore,
          )
        : this.#database.prepare(`
            SELECT server_id FROM process_leases
            WHERE agent_id = ? AND pid = ? AND process_started_at = ?
          `).get(agentId, identity.pid, identity.startedAt)) as { server_id: string } | undefined;
      if (!lease) {
        this.#database.exec('COMMIT');
        return false;
      }
      const confirmedAt = new Date().toISOString();
      this.#database.prepare(`
        UPDATE process_leases SET confirmed_dead_at = ?
        WHERE agent_id = ? AND pid = ? AND process_started_at = ?
      `).run(confirmedAt, agentId, identity.pid, identity.startedAt);
      const ownership = this.#database.prepare(`
        SELECT workspace_key, lock_mode FROM workspace_locks
        WHERE agent_id = ? AND server_id = ?
      `).get(agentId, lease.server_id) as {
        workspace_key: string;
        lock_mode: WorkspaceLockMode;
      } | undefined;
      const runningTurn = this.#database.prepare(`
        SELECT id FROM turns WHERE agent_id = ? AND status = 'running'
        ORDER BY number ASC LIMIT 1
      `).get(agentId) as { id: string } | undefined;
      if (!ownership || !runningTurn) {
        this.markNeedsAttentionInTransaction(
          agentId,
          ownership ? 'runtime_turn_missing' : 'runtime_lock_missing',
        );
        this.#database.exec('COMMIT');
        this.notifyEventListeners();
        return false;
      }

      const pendingInterrupt = this.#database.prepare(`
        SELECT 1 FROM interrupt_requests WHERE agent_id = ? AND acknowledged_at IS NULL
      `).get(agentId);
      if (pendingInterrupt) {
        // The old owner's process is exactly confirmed dead, so a successor
        // can honor the durable interrupt without restarting the turn: cancel
        // every message present at the boundary and commit the one interrupted
        // terminal outcome the requester was promised.
        const acknowledged = this.#database.prepare(`
          UPDATE messages SET state = 'acknowledged'
          WHERE (state = 'leased' AND id IN (SELECT message_id FROM turn_messages WHERE turn_id = ?))
             OR (agent_id = ? AND state = 'pending')
        `).run(runningTurn.id, agentId);
        this.#database.prepare(`
          UPDATE turns SET status = 'interrupted', updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(confirmedAt, runningTurn.id);
        this.#database.prepare(`
          UPDATE interrupt_requests SET acknowledged_at = ?
          WHERE agent_id = ? AND acknowledged_at IS NULL
        `).run(confirmedAt, agentId);
        this.#database.prepare(`DELETE FROM workspace_locks WHERE agent_id = ? AND server_id = ?`)
          .run(agentId, lease.server_id);
        this.#database.prepare(`DELETE FROM process_leases WHERE agent_id = ? AND server_id = ?`)
          .run(agentId, lease.server_id);
        this.#database.prepare(`DELETE FROM scheduler_queue WHERE agent_id = ?`).run(agentId);
        this.#database.prepare(`UPDATE agents SET state = 'idle', updated_at = ? WHERE id = ?`)
          .run(confirmedAt, agentId);
        this.insertEvent(
          agentId,
          'turn.interrupted',
          { turnId: runningTurn.id, status: 'interrupted', acknowledged: Number(acknowledged.changes) },
          confirmedAt,
        );
        this.#database.exec('COMMIT');
        this.notifyEventListeners();
        return true;
      }

      this.#database.prepare(`
        UPDATE messages SET state = 'pending'
        WHERE state = 'leased'
          AND id IN (SELECT message_id FROM turn_messages WHERE turn_id = ?)
      `).run(runningTurn.id);
      this.#database.prepare(`DELETE FROM turn_messages WHERE turn_id = ?`).run(runningTurn.id);
      this.#database.prepare(`
        UPDATE turns SET status = 'queued', updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(confirmedAt, runningTurn.id);
      this.#database.prepare(`DELETE FROM workspace_locks WHERE agent_id = ? AND server_id = ?`)
        .run(agentId, lease.server_id);
      this.#database.prepare(`DELETE FROM process_leases WHERE agent_id = ? AND server_id = ?`)
        .run(agentId, lease.server_id);
      this.#database.prepare(`UPDATE agents SET state = 'queued', updated_at = ? WHERE id = ?`)
        .run(confirmedAt, agentId);
      this.#database.prepare(`
        INSERT INTO scheduler_queue (agent_id, workspace_key, lock_mode)
        VALUES (?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          workspace_key = excluded.workspace_key,
          lock_mode = excluded.lock_mode
      `).run(agentId, ownership.workspace_key, ownership.lock_mode);
      this.insertEvent(
        agentId,
        'agent.queued',
        { reason: 'runtime_reconciled', turnId: runningTurn.id },
        confirmedAt,
      );
      this.#database.exec('COMMIT');
      this.notifyEventListeners();
      return true;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  reconcileConfirmedDeadRuntime(agentId: string, identity: ProcessIdentity): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.#database.prepare(`
        SELECT server_id FROM process_leases
        WHERE agent_id = ? AND pid = ? AND process_started_at = ?
          AND confirmed_dead_at IS NOT NULL
      `).get(agentId, identity.pid, identity.startedAt) as { server_id: string } | undefined;
      if (!lease) {
        this.#database.exec('COMMIT');
        return false;
      }
      const ownership = this.#database.prepare(`
        SELECT workspace_key, lock_mode
        FROM workspace_locks
        WHERE agent_id = ? AND server_id = ?
      `).get(agentId, lease.server_id) as {
        workspace_key: string;
        lock_mode: WorkspaceLockMode;
      } | undefined;
      if (!ownership) {
        this.markNeedsAttentionInTransaction(agentId, 'runtime_lock_missing');
        this.#database.exec('COMMIT');
        this.notifyEventListeners();
        return false;
      }
      const runningTurn = this.#database.prepare(`
        SELECT id FROM turns WHERE agent_id = ? AND status = 'running'
        ORDER BY number ASC LIMIT 1
      `).get(agentId) as { id: string } | undefined;
      if (!runningTurn) {
        this.markNeedsAttentionInTransaction(agentId, 'runtime_turn_missing');
        this.#database.exec('COMMIT');
        this.notifyEventListeners();
        return false;
      }
      const recoveredAt = new Date().toISOString();
      this.#database.prepare(`
        UPDATE messages SET state = 'pending'
        WHERE state = 'leased'
          AND id IN (SELECT message_id FROM turn_messages WHERE turn_id = ?)
      `).run(runningTurn.id);
      this.#database.prepare(`DELETE FROM turn_messages WHERE turn_id = ?`).run(runningTurn.id);
      this.#database.prepare(`
        UPDATE turns SET status = 'queued', updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(recoveredAt, runningTurn.id);
      this.#database.prepare(`DELETE FROM workspace_locks WHERE agent_id = ? AND server_id = ?`)
        .run(agentId, lease.server_id);
      this.#database.prepare(`DELETE FROM process_leases WHERE agent_id = ? AND server_id = ?`)
        .run(agentId, lease.server_id);
      this.#database.prepare(`
        UPDATE agents SET state = 'queued', updated_at = ? WHERE id = ?
      `).run(recoveredAt, agentId);
      this.#database.prepare(`
        INSERT INTO scheduler_queue (agent_id, workspace_key, lock_mode)
        VALUES (?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          workspace_key = excluded.workspace_key,
          lock_mode = excluded.lock_mode
      `).run(agentId, ownership.workspace_key, ownership.lock_mode);
      this.insertEvent(
        agentId,
        'agent.queued',
        { reason: 'runtime_reconciled', turnId: runningTurn.id },
        recoveredAt,
      );
      this.#database.exec('COMMIT');
      this.notifyEventListeners();
      return true;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  appendClaudeEvent(
    agentId: string,
    turnId: string,
    serverId: string,
    type: string,
    payload: unknown,
    raw: string,
  ): string {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const createdAt = new Date().toISOString();
      const result = this.#database.prepare(`
        INSERT INTO claude_events (agent_id, turn_id, type, payload, raw, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(agentId, turnId, type, JSON.stringify(payload), raw, createdAt);
      this.#database.prepare(`
        UPDATE agents
        SET last_activity_at = ?, stall_reported_at = NULL
        WHERE id = ?
          AND state = 'running'
          AND EXISTS (
            SELECT 1 FROM turns
            WHERE turns.id = ?
              AND turns.agent_id = agents.id
              AND turns.status = 'running'
          )
          AND EXISTS (
            SELECT 1 FROM process_leases
            WHERE process_leases.agent_id = agents.id
              AND process_leases.server_id = ?
              AND process_leases.confirmed_dead_at IS NULL
          )
      `).run(createdAt, agentId, turnId, serverId);
      this.#database.exec('COMMIT');
      return String(result.lastInsertRowid);
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  detectStalledAgents(serverId: string, timeoutMs: number): string[] {
    if (serverId.trim() === '') throw new Error('server ID must not be empty');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('stall timeout must be a positive integer');
    }
    const probeThreshold = new Date(Date.now() - timeoutMs).toISOString();
    const candidates = this.#database.prepare(`
      SELECT a.id, t.id AS turn_id
      FROM agents a
      JOIN process_leases p
        ON p.agent_id = a.id
       AND p.server_id = ?
       AND p.confirmed_dead_at IS NULL
      JOIN turns t
        ON t.agent_id = a.id AND t.status = 'running'
      WHERE a.state = 'running'
        AND a.last_activity_at IS NOT NULL
        AND a.last_activity_at <= ?
        AND a.stall_reported_at IS NULL
    `).all(serverId, probeThreshold) as Array<{ id: string; turn_id: string }>;
    // The 100ms service pump stays read-only while no owned runtime is due.
    if (candidates.length === 0) return [];
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const threshold = new Date(nowMs - timeoutMs).toISOString();
      const stalledAgentIds: string[] = [];
      for (const { id, turn_id: turnId } of candidates) {
        const claimed = this.#database.prepare(`
          UPDATE agents
          SET stall_reported_at = ?
          WHERE id = ?
            AND state = 'running'
            AND stall_reported_at IS NULL
            AND last_activity_at IS NOT NULL
            AND last_activity_at <= ?
            AND EXISTS (
              SELECT 1 FROM process_leases
              WHERE process_leases.agent_id = agents.id
                AND process_leases.server_id = ?
                AND process_leases.confirmed_dead_at IS NULL
            )
            AND EXISTS (
              SELECT 1 FROM turns
              WHERE turns.id = ?
                AND turns.agent_id = agents.id
                AND turns.status = 'running'
            )
          RETURNING last_activity_at
        `).get(nowIso, id, threshold, serverId, turnId) as { last_activity_at: string } | undefined;
        if (!claimed) continue;
        const stalledForMs = Math.max(0, nowMs - Date.parse(claimed.last_activity_at));
        this.insertEvent(id, 'agent.stalled', {
          turnId,
          lastActivityAt: claimed.last_activity_at,
          stalledForMs,
        }, nowIso);
        stalledAgentIds.push(id);
      }
      this.#database.exec('COMMIT');
      if (stalledAgentIds.length > 0) this.notifyEventListeners();
      return stalledAgentIds;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  readClaudeEvents(
    agentId: string,
    after: number | string,
    limit: number,
  ): ClaudeEvent[] {
    const cursor = parseCursor(after);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Claude event limit must be a positive integer');
    }
    const rows = this.#database.prepare(`
      SELECT sequence, agent_id, turn_id, type, payload, raw, created_at
      FROM claude_events
      WHERE agent_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(agentId, cursor, limit) as ClaudeEventRow[];
    return rows.map(asClaudeEvent);
  }

  latestClaudeCursor(agentId: string): string {
    const row = this.#database.prepare(`
      SELECT max(sequence) AS sequence FROM claude_events WHERE agent_id = ?
    `).get(agentId) as { sequence: bigint | null };
    return row.sequence?.toString() ?? '0';
  }

  scheduleAgent(agentId: string, workspaceKey: string, lockMode: WorkspaceLockMode): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const agent = this.#database.prepare(`SELECT state FROM agents WHERE id = ?`)
        .get(agentId) as { state: AgentState } | undefined;
      if (!agent) throw new Error('agent not found');
      const shouldSchedule = this.ensureQueuedTurnInTransaction(agentId);
      if (shouldSchedule) this.scheduleInTransaction(agentId, workspaceKey, lockMode);
      if (shouldSchedule && agent.state !== 'running') {
        const transitionedAt = new Date().toISOString();
        this.#database.prepare(`UPDATE agents SET state = 'queued', updated_at = ? WHERE id = ?`)
          .run(transitionedAt, agentId);
        if (agent.state !== 'queued') {
          this.insertEvent(agentId, 'agent.queued', { reason: 'followup' }, transitionedAt);
        }
      }
      this.#database.exec('COMMIT');
      if (shouldSchedule && agent.state !== 'queued' && agent.state !== 'running') {
        this.notifyEventListeners();
      }
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  claimNextScheduled(serverId: string, processLimit = 4): ScheduledAgent | undefined {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const scheduled = this.#database.prepare(`
        SELECT q.agent_id, q.workspace_key, q.lock_mode
        FROM scheduler_queue q
        ORDER BY q.sequence ASC
        LIMIT 1
      `).get() as { agent_id: string; workspace_key: string; lock_mode: WorkspaceLockMode } | undefined;
      if (!scheduled) {
        this.#database.exec('COMMIT');
        return undefined;
      }

      const leaseCount = this.#database.prepare(`SELECT count(*) AS count FROM process_leases`)
        .get() as { count: bigint };
      if (leaseCount.count >= BigInt(processLimit)) {
        this.#database.exec('COMMIT');
        return undefined;
      }
      const conflict = this.#database.prepare(`
        SELECT 1
        FROM workspace_locks
        WHERE workspace_key = ? AND (? = 'writer' OR lock_mode = 'writer')
        LIMIT 1
      `).get(scheduled.workspace_key, scheduled.lock_mode);
      if (conflict) {
        this.#database.exec('COMMIT');
        return undefined;
      }
      const agentRow = this.#database.prepare(`
        SELECT id, session_id, session_started_at, state, task, cwd, permission_profile, model, effort, name, last_activity_at, stall_reported_at, created_at, updated_at
        FROM agents WHERE id = ?
      `).get(scheduled.agent_id) as AgentRow | undefined;
      const turnRow = this.#database.prepare(`
        SELECT id, agent_id, number, status, created_at, updated_at
        FROM turns
        WHERE agent_id = ? AND status = 'queued'
        ORDER BY number ASC
        LIMIT 1
      `).get(scheduled.agent_id) as TurnRow | undefined;
      if (!agentRow || !turnRow) throw new Error('scheduled agent has no queued turn');

      const acquiredAt = new Date().toISOString();
      this.#database.prepare(`
        INSERT INTO process_leases (agent_id, server_id, acquired_at) VALUES (?, ?, ?)
      `).run(scheduled.agent_id, serverId, acquiredAt);
      this.#database.prepare(`
        INSERT INTO workspace_locks (agent_id, workspace_key, lock_mode, server_id)
        VALUES (?, ?, ?, ?)
      `).run(scheduled.agent_id, scheduled.workspace_key, scheduled.lock_mode, serverId);
      this.#database.prepare(`DELETE FROM scheduler_queue WHERE agent_id = ?`).run(scheduled.agent_id);
      this.#database.prepare(`
        UPDATE agents
        SET state = 'running', updated_at = ?, last_activity_at = ?, stall_reported_at = NULL
        WHERE id = ?
      `).run(acquiredAt, acquiredAt, scheduled.agent_id);
      this.#database.prepare(`UPDATE turns SET status = 'running', updated_at = ? WHERE id = ?`)
        .run(acquiredAt, turnRow.id);
      const messages = this.leaseMessagesInTransaction(scheduled.agent_id, turnRow.id);
      this.insertEvent(
        scheduled.agent_id,
        'turn.started',
        { turnId: turnRow.id, number: Number(turnRow.number) },
        acquiredAt,
      );
      this.#database.exec('COMMIT');
      this.notifyEventListeners();
      return {
        agent: {
          ...asAgent(agentRow),
          state: 'running',
          updatedAt: acquiredAt,
          lastActivityAt: acquiredAt,
          stallReportedAt: null,
        },
        turn: { ...asTurn(turnRow), status: 'running', updatedAt: acquiredAt },
        messages,
      };
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  releaseRuntimeLease(agentId: string, serverId: string): boolean {
    return this.releaseRuntimeLeaseInTransaction(agentId, serverId, false);
  }

  releaseRuntimeAtBoundary(agentId: string, serverId: string): boolean {
    return this.releaseRuntimeLeaseInTransaction(agentId, serverId, true);
  }

  private releaseRuntimeLeaseInTransaction(
    agentId: string,
    serverId: string,
    schedulePending: boolean,
  ): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const ownership = this.#database.prepare(`
        SELECT workspace_key, lock_mode
        FROM workspace_locks
        WHERE agent_id = ? AND server_id = ?
      `).get(agentId, serverId) as {
        workspace_key: string;
        lock_mode: WorkspaceLockMode;
      } | undefined;
      this.#database.prepare(`
        DELETE FROM workspace_locks WHERE agent_id = ? AND server_id = ?
      `).run(agentId, serverId);
      const result = this.#database.prepare(`
        DELETE FROM process_leases WHERE agent_id = ? AND server_id = ?
      `).run(agentId, serverId);
      if (result.changes === 1) {
        const shouldSchedule = schedulePending && this.ensureQueuedTurnInTransaction(agentId);
        if (shouldSchedule) {
          if (!ownership) throw new Error('runtime lease has no workspace lock');
          this.scheduleInTransaction(agentId, ownership.workspace_key, ownership.lock_mode);
        }
        this.#database.prepare(`UPDATE agents SET state = ?, updated_at = ? WHERE id = ?`)
          .run(shouldSchedule ? 'queued' : 'idle', new Date().toISOString(), agentId);
        const transitionedAt = new Date().toISOString();
        this.#database.prepare(`
          UPDATE interrupt_requests SET acknowledged_at = COALESCE(acknowledged_at, ?)
          WHERE agent_id = ?
        `).run(transitionedAt, agentId);
        this.insertEvent(
          agentId,
          shouldSchedule ? 'agent.queued' : 'agent.idle',
          { reason: 'turn_boundary' },
          transitionedAt,
        );
      }
      this.#database.exec('COMMIT');
      if (result.changes === 1) this.notifyEventListeners();
      return result.changes === 1;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  recoverRuntimeFailure(agentId: string, turnId: string, serverId: string): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const process = this.#database.prepare(`
        SELECT pid FROM process_leases WHERE agent_id = ? AND server_id = ?
      `).get(agentId, serverId) as {
        pid: bigint | null;
      } | undefined;
      if (process?.pid !== null && process?.pid !== undefined) {
        this.#database.exec('COMMIT');
        return false;
      }
      const ownership = this.#database.prepare(`
        SELECT workspace_key, lock_mode
        FROM workspace_locks
        WHERE agent_id = ? AND server_id = ?
      `).get(agentId, serverId) as {
        workspace_key: string;
        lock_mode: WorkspaceLockMode;
      } | undefined;
      if (!ownership) {
        this.#database.exec('COMMIT');
        return false;
      }

      this.#database.prepare(`
        UPDATE messages
        SET state = 'pending'
        WHERE state = 'leased'
          AND id IN (SELECT message_id FROM turn_messages WHERE turn_id = ?)
      `).run(turnId);
      this.#database.prepare(`DELETE FROM turn_messages WHERE turn_id = ?`).run(turnId);
      const turn = this.#database.prepare(`
        UPDATE turns SET status = 'queued', updated_at = ?
        WHERE id = ? AND agent_id = ? AND status = 'running'
      `).run(new Date().toISOString(), turnId, agentId);
      if (turn.changes !== 1) throw new Error('runtime failure turn is not running');
      this.#database.prepare(`
        UPDATE agents SET state = 'queued', updated_at = ? WHERE id = ?
      `).run(new Date().toISOString(), agentId);
      this.#database.prepare(`DELETE FROM workspace_locks WHERE agent_id = ? AND server_id = ?`)
        .run(agentId, serverId);
      this.#database.prepare(`DELETE FROM process_leases WHERE agent_id = ? AND server_id = ?`)
        .run(agentId, serverId);
      this.#database.prepare(`
        INSERT OR IGNORE INTO scheduler_queue (agent_id, workspace_key, lock_mode)
        VALUES (?, ?, ?)
      `).run(agentId, ownership.workspace_key, ownership.lock_mode);
      this.insertEvent(
        agentId,
        'agent.queued',
        { reason: 'runtime_failure', turnId },
        new Date().toISOString(),
      );
      this.#database.exec('COMMIT');
      this.notifyEventListeners();
      return true;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  recoverRuntimeFailureNeedsAttention(
    agentId: string,
    turnId: string,
    serverId: string,
    reason: string,
  ): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.#database.prepare(`
        SELECT pid FROM process_leases WHERE agent_id = ? AND server_id = ?
      `).get(agentId, serverId) as { pid: bigint | null } | undefined;
      if (!lease || lease.pid !== null) {
        this.#database.exec('COMMIT');
        return false;
      }
      this.#database.prepare(`
        UPDATE messages SET state = 'pending'
        WHERE state = 'leased'
          AND id IN (SELECT message_id FROM turn_messages WHERE turn_id = ?)
      `).run(turnId);
      this.#database.prepare(`DELETE FROM turn_messages WHERE turn_id = ?`).run(turnId);
      this.#database.prepare(`
        UPDATE turns SET status = 'queued', updated_at = ?
        WHERE id = ? AND agent_id = ? AND status = 'running'
      `).run(new Date().toISOString(), turnId, agentId);
      this.#database.prepare(`DELETE FROM scheduler_queue WHERE agent_id = ?`).run(agentId);
      this.#database.prepare(`DELETE FROM workspace_locks WHERE agent_id = ? AND server_id = ?`)
        .run(agentId, serverId);
      this.#database.prepare(`DELETE FROM process_leases WHERE agent_id = ? AND server_id = ?`)
        .run(agentId, serverId);
      this.markNeedsAttentionInTransaction(agentId, reason);
      this.#database.exec('COMMIT');
      this.notifyEventListeners();
      return true;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  requestInterrupt(
    agentId: string,
  ): { state: AgentState; interrupted: boolean; cursor: string } | undefined {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const agent = this.#database.prepare(`SELECT state FROM agents WHERE id = ?`)
        .get(agentId) as { state: AgentState } | undefined;
      if (!agent) throw new Error('agent not found');
      const turn = this.#database.prepare(`
        SELECT id, status FROM turns
        WHERE agent_id = ? AND status IN ('queued', 'running')
        ORDER BY number ASC LIMIT 1
      `).get(agentId) as { id: string; status: 'queued' | 'running' } | undefined;
      if (!turn || !['queued', 'running', 'cancelling'].includes(agent.state)) {
        this.#database.exec('COMMIT');
        return undefined;
      }

      const requestedAt = new Date().toISOString();
      if (turn.status === 'queued') {
        this.#database.prepare(`
          UPDATE messages SET state = 'acknowledged'
          WHERE agent_id = ? AND state = 'pending'
        `).run(agentId);
        this.#database.prepare(`
          UPDATE turns SET status = 'interrupted', updated_at = ?
          WHERE id = ? AND status = 'queued'
        `).run(requestedAt, turn.id);
        this.#database.prepare(`DELETE FROM scheduler_queue WHERE agent_id = ?`).run(agentId);
        this.#database.prepare(`UPDATE agents SET state = 'idle', updated_at = ? WHERE id = ?`)
          .run(requestedAt, agentId);
        this.#database.prepare(`
          INSERT INTO interrupt_requests (agent_id, requested_at, acknowledged_at)
          VALUES (?, ?, ?)
          ON CONFLICT(agent_id) DO UPDATE SET
            requested_at = excluded.requested_at,
            acknowledged_at = excluded.acknowledged_at
        `).run(agentId, requestedAt, requestedAt);
        const cursor = this.insertEvent(
          agentId,
          'turn.interrupted',
          { turnId: turn.id, status: 'interrupted', acknowledged: 0 },
          requestedAt,
        );
        this.#database.exec('COMMIT');
        this.notifyEventListeners();
        return { state: 'idle', interrupted: true, cursor };
      }

      const pending = this.#database.prepare(`
        SELECT 1 FROM interrupt_requests
        WHERE agent_id = ? AND acknowledged_at IS NULL
      `).get(agentId);
      let cursor = this.latestCursor();
      if (!pending) {
        this.#database.prepare(`
          INSERT INTO interrupt_requests (agent_id, requested_at, acknowledged_at)
          VALUES (?, ?, NULL)
          ON CONFLICT(agent_id) DO UPDATE SET
            requested_at = excluded.requested_at,
            acknowledged_at = NULL
        `).run(agentId, requestedAt);
        this.#database.prepare(`UPDATE agents SET state = 'cancelling', updated_at = ? WHERE id = ?`)
          .run(requestedAt, agentId);
        cursor = this.insertEvent(
          agentId,
          'agent.cancelling',
          { turnId: turn.id },
          requestedAt,
        );
      }
      this.#database.exec('COMMIT');
      if (!pending) this.notifyEventListeners();
      return { state: 'cancelling', interrupted: false, cursor };
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  listOwnedInterruptRequests(serverId: string): Array<{ agentId: string; turnId: string }> {
    const rows = this.#database.prepare(`
      SELECT r.agent_id, t.id AS turn_id
      FROM interrupt_requests r
      JOIN process_leases p ON p.agent_id = r.agent_id AND p.server_id = ?
      JOIN turns t ON t.agent_id = r.agent_id AND t.status = 'running'
      WHERE r.acknowledged_at IS NULL
      ORDER BY r.requested_at ASC, r.agent_id ASC
    `).all(serverId) as Array<{ agent_id: string; turn_id: string }>;
    return rows.map((row) => ({ agentId: row.agent_id, turnId: row.turn_id }));
  }

  completeOwnedInterrupt(agentId: string, turnId: string, serverId: string): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const ownership = this.#database.prepare(`
        SELECT p.pid, p.confirmed_dead_at
        FROM interrupt_requests r
        JOIN process_leases p ON p.agent_id = r.agent_id AND p.server_id = ?
        WHERE r.agent_id = ? AND r.acknowledged_at IS NULL
      `).get(serverId, agentId) as { pid: bigint | null; confirmed_dead_at: string | null } | undefined;
      if (!ownership) {
        this.#database.exec('COMMIT');
        return false;
      }
      if (ownership.pid !== null && ownership.confirmed_dead_at === null) {
        throw new Error('runtime process death is not confirmed');
      }
      const completedAt = new Date().toISOString();
      const terminal = this.#database.prepare(`
        UPDATE turns SET status = 'interrupted', updated_at = ?
        WHERE id = ? AND agent_id = ? AND status = 'running'
      `).run(completedAt, turnId, agentId);
      if (terminal.changes === 0) {
        // The turn reached a terminal status concurrently; the boundary path
        // owns lease/state teardown, so only retire the durable request.
        this.#database.prepare(`
          UPDATE interrupt_requests SET acknowledged_at = ?
          WHERE agent_id = ? AND acknowledged_at IS NULL
        `).run(completedAt, agentId);
        this.#database.exec('COMMIT');
        return false;
      }
      // Interruption cancels every message present at the boundary, including
      // pending mail that was never leased, so no stale followup can later be
      // started by a context-only send.
      const acknowledged = this.#database.prepare(`
        UPDATE messages SET state = 'acknowledged'
        WHERE (state = 'leased' AND id IN (SELECT message_id FROM turn_messages WHERE turn_id = ?))
           OR (agent_id = ? AND state = 'pending')
      `).run(turnId, agentId);
      this.#database.prepare(`
        UPDATE interrupt_requests SET acknowledged_at = ?
        WHERE agent_id = ? AND acknowledged_at IS NULL
      `).run(completedAt, agentId);
      this.#database.prepare(`DELETE FROM workspace_locks WHERE agent_id = ? AND server_id = ?`)
        .run(agentId, serverId);
      this.#database.prepare(`DELETE FROM process_leases WHERE agent_id = ? AND server_id = ?`)
        .run(agentId, serverId);
      this.#database.prepare(`DELETE FROM scheduler_queue WHERE agent_id = ?`).run(agentId);
      this.#database.prepare(`UPDATE agents SET state = 'idle', updated_at = ? WHERE id = ?`)
        .run(completedAt, agentId);
      this.insertEvent(
        agentId,
        'turn.interrupted',
        { turnId, status: 'interrupted', acknowledged: Number(acknowledged.changes) },
        completedAt,
      );
      this.#database.exec('COMMIT');
      this.notifyEventListeners();
      return true;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  acknowledgeOwnedInterruptNeedsAttention(agentId: string, serverId: string): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const acknowledgedAt = new Date().toISOString();
      const result = this.#database.prepare(`
        UPDATE interrupt_requests SET acknowledged_at = ?
        WHERE agent_id = ? AND acknowledged_at IS NULL
          AND EXISTS (
            SELECT 1 FROM process_leases
            WHERE process_leases.agent_id = interrupt_requests.agent_id
              AND process_leases.server_id = ?
          )
      `).run(acknowledgedAt, agentId, serverId);
      if (result.changes === 1) {
        this.markNeedsAttentionInTransaction(agentId, 'interrupt_unconfirmed');
      }
      this.#database.exec('COMMIT');
      if (result.changes === 1) this.notifyEventListeners();
      return result.changes === 1;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  private ensureQueuedTurnInTransaction(agentId: string): boolean {
    const queued = this.#database.prepare(`
      SELECT 1 FROM turns WHERE agent_id = ? AND status = 'queued' LIMIT 1
    `).get(agentId);
    if (queued) return true;

    const pendingFollowup = this.#database.prepare(`
      SELECT 1
      FROM messages
      WHERE agent_id = ? AND state = 'pending' AND kind = 'followup'
      LIMIT 1
    `).get(agentId);
    if (!pendingFollowup) return false;

    const latest = this.#database.prepare(`
      SELECT id, agent_id, number, status, created_at, updated_at
      FROM turns WHERE agent_id = ? ORDER BY number DESC LIMIT 1
    `).get(agentId) as TurnRow | undefined;
    if (!latest || latest.status === 'running') throw new Error('agent has no schedulable turn');
    if (latest.number >= BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('turn number exceeds safe integer range');
    }
    const createdAt = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO turns (id, agent_id, number, status, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?)
    `).run(randomUUID(), agentId, latest.number + 1n, createdAt, createdAt);
    return true;
  }

  private scheduleInTransaction(
    agentId: string,
    workspaceKey: string,
    lockMode: WorkspaceLockMode,
  ): void {
    this.#database.prepare(`
      INSERT OR IGNORE INTO scheduler_queue (agent_id, workspace_key, lock_mode)
      VALUES (?, ?, ?)
    `).run(agentId, workspaceKey, lockMode);
  }

  private leaseMessagesInTransaction(agentId: string, turnId: string): Message[] {
    const turn = this.#database.prepare(`
      SELECT status FROM turns WHERE id = ? AND agent_id = ?
    `).get(turnId, agentId) as { status: TurnStatus } | undefined;
    if (!turn) throw new Error('turn does not belong to agent');

    const existing = this.#database.prepare(`
      SELECT m.id, m.agent_id, m.kind, m.content, m.state, m.created_at
      FROM turn_messages tm
      JOIN messages m ON m.id = tm.message_id
      WHERE tm.turn_id = ?
      ORDER BY tm.ordinal ASC
    `).all(turnId) as MessageRow[];
    if (turn.status !== 'queued' && turn.status !== 'running') return existing.map(asMessage);
    const leased = this.leasePendingMessagesInTransaction(agentId, turnId, existing.length);
    return [...existing.map(asMessage), ...leased];
  }

  private leasePendingMessagesInTransaction(
    agentId: string,
    turnId: string,
    startingOrdinal?: number,
    requireRunning = false,
  ): Message[] {
    const turn = this.#database.prepare(`
      SELECT status FROM turns WHERE id = ? AND agent_id = ?
    `).get(turnId, agentId) as { status: TurnStatus } | undefined;
    if (!turn) throw new Error('turn does not belong to agent');
    if (requireRunning && turn.status !== 'running') return [];

    const ordinal = startingOrdinal ?? Number((this.#database.prepare(`
      SELECT count(*) AS count FROM turn_messages WHERE turn_id = ?
    `).get(turnId) as { count: bigint }).count);

    const manifestHasFollowup = this.#database.prepare(`
      SELECT 1
      FROM turn_messages tm
      JOIN messages m ON m.id = tm.message_id
      WHERE tm.turn_id = ? AND m.kind = 'followup'
      LIMIT 1
    `).get(turnId);
    if (manifestHasFollowup) return [];

    const allPending = this.#database.prepare(`
      SELECT id, agent_id, kind, content, state, created_at
      FROM messages
      WHERE agent_id = ? AND state = 'pending'
      ORDER BY rowid ASC
    `).all(agentId) as MessageRow[];
    const firstFollowup = allPending.findIndex(({ kind }) => kind === 'followup');
    const pending = firstFollowup < 0 ? allPending : allPending.slice(0, firstFollowup + 1);
    const addToManifest = this.#database.prepare(`
      INSERT INTO turn_messages (turn_id, message_id, ordinal) VALUES (?, ?, ?)
    `);
    const markLeased = this.#database.prepare(`
      UPDATE messages SET state = 'leased' WHERE id = ? AND state = 'pending'
    `);
    pending.forEach((message, offset) => {
      addToManifest.run(turnId, message.id, ordinal + offset);
      const result = markLeased.run(message.id);
      if (result.changes !== 1) throw new Error('message could not be leased');
      message.state = 'leased';
    });
    return pending.map(asMessage);
  }

  readEvents(input: ReadEventsInput): Event[] {
    const after = parseCursor(input.after);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new Error('event limit must be a positive integer');
    }
    if (input.agentIds.length === 0) return [];

    const placeholders = input.agentIds.map(() => '?').join(', ');
    const rows = this.#database.prepare(`
      SELECT sequence, agent_id, type, payload, created_at
      FROM events
      WHERE agent_id IN (${placeholders}) AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(...input.agentIds, after, input.limit) as EventRow[];
    return rows.map(asEvent);
  }

  appendPublicEvent(agentId: string, type: EventType, payload: unknown): string {
    const createdAt = new Date().toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (!this.getAgent(agentId)) throw new Error('agent not found');
      const cursor = this.insertEvent(agentId, type, payload, createdAt);
      this.#database.exec('COMMIT');
      this.notifyEventListeners();
      return cursor;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  latestCursor(): string {
    const row = this.#database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events
    `).get() as { sequence: bigint };
    return row.sequence.toString();
  }

  onEventCommitted(listener: () => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  private notifyEventListeners(): void {
    for (const listener of [...this.#eventListeners]) {
      try {
        listener();
      } catch {
        // SQLite is authoritative; a process-local wakeup must not change a committed write.
      }
    }
  }

  private markNeedsAttentionInTransaction(agentId: string, reason: string): boolean {
    const agent = this.#database.prepare(`SELECT state FROM agents WHERE id = ?`)
      .get(agentId) as { state: AgentState } | undefined;
    if (!agent) return false;
    if (agent.state === 'needs_attention') return true;
    const transitionedAt = new Date().toISOString();
    const result = this.#database.prepare(`
      UPDATE agents SET state = 'needs_attention', updated_at = ? WHERE id = ?
    `).run(transitionedAt, agentId);
    if (result.changes === 1) {
      this.insertEvent(agentId, 'agent.needs_attention', { reason }, transitionedAt);
    }
    return result.changes === 1;
  }

  private insertEvent(agentId: string, type: EventType, payload: unknown, createdAt: string): string {
    const result = this.#database.prepare(`
      INSERT INTO events (agent_id, type, payload, created_at) VALUES (?, ?, ?, ?)
    `).run(agentId, type, JSON.stringify(payload), createdAt);
    return String(result.lastInsertRowid);
  }
}

export function openStore(path: string): AgentStore {
  return new AgentStore(path);
}
