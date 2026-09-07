import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';

import {
  AgentServiceError,
  sanitizeAgentServiceError,
  type AgentReadPage,
  type AgentServiceApi,
  type AgentSummary,
} from './agent-service.js';
import type { ClaudeEvent, Event, Turn } from './domain.js';

function jsonResult(structuredContent: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

const INVALID_INPUT = Symbol('invalid_input');

// McpServer validates before invoking a tool callback. Field-level catches keep
// malformed argument objects inside our callback, while the strict validator
// remains the source of truth and the metadata preserves the advertised schema.
function stableObject<T extends Record<string, z.ZodType>>(
  shape: T,
  defaults: Partial<Record<keyof T, unknown>> = {},
): { inputSchema: z.ZodObject<Record<keyof T, z.ZodCatch<T[keyof T]>>>; validator: z.ZodObject<T> } {
  const inputShape = Object.fromEntries(Object.entries(shape).map(([key, field]) => [
    key,
    field
      .catch(INVALID_INPUT as unknown as z.output<typeof field>)
      .meta({ default: Object.prototype.hasOwnProperty.call(defaults, key) ? defaults[key] : undefined }),
  ])) as Record<keyof T, z.ZodCatch<T[keyof T]>>;
  return {
    inputSchema: z.object(inputShape).passthrough().meta({ additionalProperties: false }),
    validator: z.object(shape).strict(),
  };
}

function executeInput<T extends z.ZodType>(
  validator: T,
  input: unknown,
  action: (value: z.output<T>) => unknown | Promise<unknown>,
): Promise<CallToolResult> {
  const parsed = validator.safeParse(input);
  if (!parsed.success) {
    return Promise.resolve(jsonResult({
      error: { code: 'invalid_input', message: 'Invalid tool arguments.' },
    }, true));
  }
  return execute(() => action(parsed.data));
}

function errorDetails(error: AgentServiceError): Record<string, unknown> | undefined {
  if (!error.details) return undefined;
  return {
    ...(error.details.agentId ? { agent_id: error.details.agentId } : {}),
    ...(error.details.state ? { state: error.details.state } : {}),
    ...(error.details.process ? {
      process: {
        pid: error.details.process.pid,
        started_at: error.details.process.startedAt,
      },
    } : {}),
  };
}

async function execute(action: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await action() as Record<string, unknown>);
  } catch (error) {
    const sanitized = sanitizeAgentServiceError(error);
    const details = errorDetails(sanitized);
    return jsonResult({
      error: {
        code: sanitized.code,
        message: sanitized.message,
        ...(details && Object.keys(details).length > 0 ? { details } : {}),
      },
    }, true);
  }
}

function eventOutput(event: Event): Record<string, unknown> {
  return {
    sequence: event.sequence,
    agent_id: event.agentId,
    type: event.type,
    payload: event.payload,
    created_at: event.createdAt,
  };
}

function turnOutput(turn: Turn): Record<string, unknown> {
  return {
    turn_id: turn.id,
    agent_id: turn.agentId,
    number: turn.number,
    status: turn.status,
    created_at: turn.createdAt,
    updated_at: turn.updatedAt,
  };
}

function rawEventOutput(event: ClaudeEvent): Record<string, unknown> {
  return {
    sequence: event.sequence,
    agent_id: event.agentId,
    turn_id: event.turnId,
    type: event.type,
    payload: event.payload,
    raw: event.raw,
    created_at: event.createdAt,
  };
}

function summaryOutput(summary: AgentSummary): Record<string, unknown> {
  return {
    agent_id: summary.id,
    name: summary.name,
    state: summary.state,
    last_turn_status: summary.lastTurnStatus,
    pending_message_count: summary.pendingMessageCount,
    cwd: summary.cwd,
    permission_profile: summary.permissionProfile,
    last_activity_at: summary.lastActivityAt,
    stalled: summary.stalled,
    created_at: summary.createdAt,
    updated_at: summary.updatedAt,
  };
}

function readOutput(page: AgentReadPage): Record<string, unknown> {
  return {
    agent: summaryOutput(page.agent),
    turns: page.turns.map(turnOutput),
    events: page.events.map(eventOutput),
    cursor: page.cursor,
    has_more: page.hasMore,
    ...(page.rawEvents ? { raw_events: page.rawEvents.map(rawEventOutput) } : {}),
    ...(page.rawCursor !== undefined ? { raw_cursor: page.rawCursor } : {}),
  };
}

function modelCatalogOutput(): Record<string, unknown> {
  return {
    models: [
      {
        id: 'default',
        spawn_value: null,
        recommended_for: 'Use the model configured as Claude Code\'s local default.',
      },
      {
        id: 'fable',
        spawn_value: 'fable',
        recommended_for: 'Routine implementation, bounded fixes, and fast iteration.',
      },
      {
        id: 'sonnet',
        spawn_value: 'sonnet',
        recommended_for: 'Complex coding, debugging, and code review.',
      },
      {
        id: 'opus',
        spawn_value: 'opus',
        recommended_for: 'Hard architecture, security, concurrency, or escalation after another model fails.',
      },
    ],
    effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    accepts_full_model_id: true,
    availability_note: 'Aliases come from Claude Code. Account availability is validated only when spawn_agent starts Claude.',
  };
}

const nonEmpty = z.string().trim().min(1);

const spawnAgentInput = stableObject({
  task: nonEmpty,
  cwd: nonEmpty.optional(),
  permission_profile: z.enum(['read_only', 'workspace_write']).default('read_only'),
  model: nonEmpty.describe(
    'Claude Code model alias or full model ID. Omit for the local Claude default; use fable for routine implementation, sonnet for complex debugging/review, and opus for the hardest architecture, security, or failed-escalation work.',
  ).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).describe(
    'Reasoning effort. Use low for mechanical work, medium for normal coding, high for debugging/review, and xhigh or max only for unusually hard tasks.',
  ).optional(),
  name: nonEmpty.optional(),
}, { permission_profile: 'read_only' });
const messageInput = stableObject({ agent_id: nonEmpty, message: nonEmpty });
const waitAgentInput = stableObject({
  agent_ids: z.array(nonEmpty).min(1).max(8),
  after_cursor: z.string().default('0'),
  timeout_ms: z.number().int().min(0).max(600_000).default(30_000),
}, { after_cursor: '0', timeout_ms: 30_000 });
const interruptAgentInput = stableObject({ agent_id: nonEmpty });
const listAgentsInput = stableObject({});
const listModelsInput = stableObject({});
const readAgentInput = stableObject({
  agent_id: nonEmpty,
  after_cursor: z.string().default('0'),
  limit: z.number().int().min(1).max(1_000).default(100),
  include_raw: z.boolean().default(false),
  after_raw_cursor: z.string().default('0'),
}, { after_cursor: '0', limit: 100, include_raw: false, after_raw_cursor: '0' });

export function registerAgentTools(server: McpServer, service: AgentServiceApi): void {
  server.registerTool('spawn_agent', {
    description: 'Create a Claude Code subagent and start its first turn. Model routing: omit model for the local default; fable handles routine implementation, sonnet handles complex coding/debugging/review, and opus is reserved for the hardest architecture, security, or escalation work.',
    inputSchema: spawnAgentInput.inputSchema,
  }, (input) => executeInput(spawnAgentInput.validator, input, async (input) => {
    const result = await service.spawnAgent({
      task: input.task,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.permission_profile !== undefined ? { permissionProfile: input.permission_profile } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
    });
    return {
      agent_id: result.agentId,
      session_id: result.sessionId,
      turn_id: result.turnId,
      state: result.state,
      cursor: result.cursor,
    };
  }));

  server.registerTool('send_message', {
    description: 'Queue context for an existing Claude Code subagent without starting a model query.',
    inputSchema: messageInput.inputSchema,
  }, (input) => executeInput(messageInput.validator, input, async (input) => {
    const result = await service.sendMessage(input.agent_id, input.message);
    return {
      message_id: result.messageId,
      queued_only: result.queuedOnly,
      mailbox_depth: result.mailboxDepth,
      cursor: result.cursor,
    };
  }));

  server.registerTool('followup_task', {
    description: 'Queue a query-producing followup for an existing Claude Code subagent.',
    inputSchema: messageInput.inputSchema,
  }, (input) => executeInput(messageInput.validator, input, async (input) => {
    const result = await service.followupTask(input.agent_id, input.message);
    return {
      message_id: result.messageId,
      state: result.state,
      cursor: result.cursor,
    };
  }));

  server.registerTool('wait_agent', {
    description: 'Long-poll durable semantic events for one to eight agents.',
    inputSchema: waitAgentInput.inputSchema,
  }, (input) => executeInput(waitAgentInput.validator, input, async (input) => {
    const result = await service.waitAgent(input.agent_ids, input.after_cursor, input.timeout_ms);
    return {
      events: result.events.map(eventOutput),
      cursor: result.cursor,
      timed_out: result.timedOut,
    };
  }));

  server.registerTool('interrupt_agent', {
    description: 'Durably request interruption of an active Claude Code subagent turn.',
    inputSchema: interruptAgentInput.inputSchema,
  }, (input) => executeInput(interruptAgentInput.validator, input, async (input) => {
    const result = await service.interruptAgent(input.agent_id);
    return { state: result.state, interrupted: result.interrupted, cursor: result.cursor };
  }));

  server.registerTool('list_agents', {
    description: 'List persisted Claude Code subagents and their current state.',
    inputSchema: listAgentsInput.inputSchema,
  }, (input) => executeInput(listAgentsInput.validator, input, () => ({ agents: service.listAgents().map(summaryOutput) })));

  server.registerTool('list_models', {
    description: 'List Claude Code model choices and task-routing guidance before calling spawn_agent. Availability is confirmed by Claude Code when the agent starts.',
    inputSchema: listModelsInput.inputSchema,
  }, (input) => executeInput(listModelsInput.validator, input, modelCatalogOutput));

  server.registerTool('read_agent', {
    description: 'Read persisted semantic events and turn outcomes for an agent.',
    inputSchema: readAgentInput.inputSchema,
  }, (input) => executeInput(readAgentInput.validator, input, (input) => readOutput(service.readAgent(
    input.agent_id,
    input.after_cursor,
    input.limit,
    input.include_raw,
    input.after_raw_cursor,
  ))));
}
