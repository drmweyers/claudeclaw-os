import { CronExpressionParser } from 'cron-parser';

import { AGENT_ID, ALLOWED_CHAT_ID, agentMcpAllowlist, agentDefaultModel } from './config.js';
import { ingestConversationTurn } from './memory-ingest.js';
import {
  getDueTasks,
  getSession,
  logConversationTurn,
  markTaskRunning,
  updateTaskAfterRun,
  resetStuckTasks,
  claimNextMissionTask,
  completeMissionTask,
  resetStuckMissionTasks,
  getMissionTask,
  getPersonaSpend24h,
  saveTokenUsage,
} from './db.js';
import { logger } from './logger.js';
import { messageQueue } from './message-queue.js';
import { runAgent } from './agent.js';
import { formatForTelegram, splitMessage } from './bot.js';
import {
  parsePersonaSnapshot,
  shouldDispatchUnderCap,
  resolveDispatchParams,
  formatPersonaFooter,
} from './personas.js';

type Sender = (text: string) => Promise<void>;

/** Max time (ms) a scheduled task can run before being killed. */
const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

let sender: Sender;

/**
 * In-memory set of task IDs currently being executed.
 * Acts as a fast-path guard alongside the DB-level lock in markTaskRunning.
 */
const runningTaskIds = new Set<string>();

/**
 * Initialise the scheduler. Call once after the Telegram bot is ready.
 * @param send  Function that sends a message to the user's Telegram chat.
 */
let schedulerAgentId = 'main';

export function initScheduler(send: Sender, agentId = 'main'): void {
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler will not send results');
  }
  sender = send;
  schedulerAgentId = agentId;

  // Recover tasks stuck in 'running' from a previous crash
  const recovered = resetStuckTasks(agentId);
  if (recovered > 0) {
    logger.warn({ recovered, agentId }, 'Reset stuck tasks from previous crash');
  }
  const recoveredMission = resetStuckMissionTasks(agentId);
  if (recoveredMission > 0) {
    logger.warn({ recovered: recoveredMission, agentId }, 'Reset stuck mission tasks from previous crash');
  }

  setInterval(() => void runDueTasks(), 60_000);
  logger.info({ agentId }, 'Scheduler started (checking every 60s)');
}

async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks(schedulerAgentId);

  if (tasks.length > 0) {
    logger.info({ count: tasks.length }, 'Running due scheduled tasks');
  }

  for (const task of tasks) {
    // In-memory guard: skip if already running in this process
    if (runningTaskIds.has(task.id)) {
      logger.warn({ taskId: task.id }, 'Task already running, skipping duplicate fire');
      continue;
    }

    // Compute next occurrence BEFORE executing so we can lock the task
    // in the DB immediately, preventing re-fire on subsequent ticks.
    const nextRun = computeNextRun(task.schedule);
    runningTaskIds.add(task.id);
    markTaskRunning(task.id, nextRun);

    logger.info({ taskId: task.id, prompt: task.prompt.slice(0, 60) }, 'Firing task');

    // Route through the message queue so scheduled tasks wait for any
    // in-flight user message to finish before running. This prevents
    // two Claude processes from hitting the same session simultaneously.
    const chatId = ALLOWED_CHAT_ID || 'scheduler';
    messageQueue.enqueue(chatId, async () => {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

      try {
        await sender(`Scheduled task running: "${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? '...' : ''}"`);

        // Run as a fresh agent call (no session — scheduled tasks are autonomous)
        const result = await runAgent(task.prompt, undefined, () => {}, undefined, agentDefaultModel, abortController, undefined, agentMcpAllowlist);
        clearTimeout(timeout);

        if (result.aborted) {
          updateTaskAfterRun(task.id, nextRun, 'Timed out after 10 minutes', 'timeout');
          await sender(`⏱ Task timed out after 10m: "${task.prompt.slice(0, 60)}..." — killed.`);
          logger.warn({ taskId: task.id }, 'Task timed out');
          return;
        }

        const text = result.text?.trim() || 'Task completed with no output.';
        for (const chunk of splitMessage(formatForTelegram(text))) {
          await sender(chunk);
        }

        // Inject task output into the active chat session so user replies have context
        if (ALLOWED_CHAT_ID) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'user', `[Scheduled task]: ${task.prompt}`, activeSession ?? undefined, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
        }

        // Fire-and-forget memory extraction. Synthetic chat_id when this agent has no
        // user-facing Telegram chat (specialists usually don't). Memory is valuable
        // even on background tasks — they produce content worth remembering, just
        // grouped under a per-agent synthetic thread instead of a real user chat.
        const ingestChatId = ALLOWED_CHAT_ID || `scheduled-${schedulerAgentId}`;
        void ingestConversationTurn(ingestChatId, `[Scheduled task]: ${task.prompt}`, text, schedulerAgentId).catch((err) => {
          logger.error({ err, taskId: task.id }, 'Memory ingestion fire-and-forget failed (scheduled task)');
        });

        updateTaskAfterRun(task.id, nextRun, text, 'success');

        logger.info({ taskId: task.id, nextRun }, 'Task complete, next run scheduled');
      } catch (err) {
        clearTimeout(timeout);
        const errMsg = err instanceof Error ? err.message : String(err);
        updateTaskAfterRun(task.id, nextRun, errMsg.slice(0, 500), 'failed');

        logger.error({ err, taskId: task.id }, 'Scheduled task failed');
        try {
          await sender(`❌ Task failed: "${task.prompt.slice(0, 60)}..." — ${errMsg.slice(0, 200)}`);
        } catch {
          // ignore send failure
        }
      } finally {
        runningTaskIds.delete(task.id);
      }
    });
  }

  // Also check for queued mission tasks (one-shot async tasks from Mission Control)
  await runDueMissionTasks();
}

async function runDueMissionTasks(): Promise<void> {
  const mission = claimNextMissionTask(schedulerAgentId);
  if (!mission) return;

  const missionKey = 'mission-' + mission.id;
  if (runningTaskIds.has(missionKey)) return;
  runningTaskIds.add(missionKey);

  // Pantheon: resolve persona from the snapshot stored on the row at queue
  // time. The snapshot — NOT the YAML file — is the source of truth here;
  // edits to personas/*.yaml while a mission is in flight do not affect it.
  const persona = parsePersonaSnapshot(mission.persona_snapshot);
  if (mission.persona_snapshot && !persona) {
    logger.error({ missionId: mission.id, persona: mission.persona }, 'Failed to parse persona_snapshot; running without persona');
  }

  // Cost-cap gate: if the persona's last-24h spend would breach the cap, refuse
  // to dispatch the mission. Mark it failed:cost_cap and notify Mark. The check
  // is conservative (before the call, with current spend) — a single mission
  // CAN push spend over the cap, but the NEXT mission will be blocked.
  //
  // Race condition: two concurrent missions for the same persona could both pass
  // the cap check, both run, and double the burst. Acceptable in this deployment
  // because: (1) one scheduler process per agent (the messageQueue.enqueue serialises
  // per-chat dispatch); (2) the runningTaskIds in-memory guard prevents the same
  // mission from being processed twice. If multi-process deployment is ever planned,
  // upgrade this to a SQLite BEGIN IMMEDIATE check-and-reserve.
  if (persona) {
    const spend24h = getPersonaSpend24h(persona.slug);
    const decision = shouldDispatchUnderCap(persona, spend24h);
    if (!decision.allowed) {
      completeMissionTask(mission.id, null, 'failed', `failed:cost_cap ${decision.reason}`);
      logger.warn({ missionId: mission.id, persona: persona.slug, spend24h, cap: persona.dailyCostCapUsd }, 'Mission rejected: persona cost cap exceeded');
      try {
        await sender(`Mission '${mission.title}' rejected: persona '${persona.slug}' has hit its $${persona.dailyCostCapUsd}/day cap (spent $${spend24h.toFixed(2)} in last 24h).`);
      } catch (sendErr) {
        logger.warn({ err: sendErr, missionId: mission.id }, 'Failed to send cost-cap notification');
      }
      runningTaskIds.delete(missionKey);
      return;
    }
  }

  logger.info(
    { missionId: mission.id, title: mission.title, persona: persona?.slug, model: persona?.model ?? agentDefaultModel },
    'Running mission task',
  );

  const chatId = ALLOWED_CHAT_ID || 'mission';
  messageQueue.enqueue(chatId, async () => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

    // Cross-process cancel signal: dashboard flips status to 'cancelled' in
    // SQLite, this poll picks it up within 5s and aborts the runAgent call.
    let cancelledByUser = false;
    const cancelPoll = setInterval(() => {
      const current = getMissionTask(mission.id);
      if (current?.status === 'cancelled') {
        cancelledByUser = true;
        abortController.abort();
        clearInterval(cancelPoll);
      }
    }, 5_000);

    try {
      // Persona overrides via the pure resolveDispatchParams helper. Centralises
      // the agent-default-vs-persona-override fallback logic and is the same code
      // path the unit tests in personas.test.ts cover. Defense-in-depth: MCP
      // allowlist re-intersected against agent.mcp_servers in case agent.yaml
      // changed between queue and dispatch.
      const dispatch = resolveDispatchParams(persona, agentDefaultModel, agentMcpAllowlist);

      const result = await runAgent(
        mission.prompt, undefined, () => {}, undefined,
        dispatch.model, abortController, undefined,
        dispatch.mcpAllowlist, dispatch.appendSystemPrompt,
      );
      clearTimeout(timeout);
      clearInterval(cancelPoll);

      if (result.aborted) {
        if (cancelledByUser) {
          // Status is already 'cancelled' from the dashboard write — leave it.
          logger.info({ missionId: mission.id }, 'Mission task cancelled by user');
        } else {
          completeMissionTask(mission.id, null, 'failed', 'Timed out after 10 minutes');
          logger.warn({ missionId: mission.id }, 'Mission task timed out');
          try {
            await sender('Mission task timed out: "' + mission.title + '"');
          } catch (sendErr) {
            // Sender can fail for Telegram API blips or chat-not-found. We
            // still want to see it so the user isn't silently unnotified.
            logger.warn({ err: sendErr, missionId: mission.id }, 'Failed to send mission timeout notification');
          }
        }
      } else {
        const baseText = result.text?.trim() || 'Task completed with no output.';

        // Pantheon: record persona+model on token_usage row so cost caps and
        // verifiability work. Skip if no usage info was emitted by the SDK.
        const costUsd = result.usage?.totalCostUsd ?? 0;
        if (result.usage) {
          saveTokenUsage(
            chatId,
            result.newSessionId,
            result.usage.inputTokens,
            result.usage.outputTokens,
            result.usage.cacheReadInputTokens,
            0, // contextTokens — not tracked per-mission today
            costUsd,
            result.usage.didCompact,
            schedulerAgentId,
            persona?.slug ?? null,
            dispatch.model ?? null,
          );
        }

        // Pantheon: append a footer so Mark sees which persona+model ran and
        // what it cost. Empty string when persona is null, so non-persona
        // missions keep their existing UX. Italic markdown separates it from
        // the answer body.
        const text = baseText + formatPersonaFooter(persona, dispatch.model, costUsd);
        completeMissionTask(mission.id, text, 'completed');
        logger.info({ missionId: mission.id, persona: persona?.slug, costUsd }, 'Mission task completed');

        // Send result to Telegram
        for (const chunk of splitMessage(formatForTelegram(text))) {
          await sender(chunk);
        }

        // Inject into conversation context so agent can reference it
        if (ALLOWED_CHAT_ID) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'user', '[Mission task: ' + mission.title + ']: ' + mission.prompt, activeSession ?? undefined, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
        }

        // Fire-and-forget memory extraction. Synthetic chat_id when this agent has no
        // user-facing Telegram chat (specialists usually don't). Mission tasks produce
        // content worth remembering, grouped under a per-agent synthetic thread.
        const ingestChatId = ALLOWED_CHAT_ID || `mission-${schedulerAgentId}`;
        void ingestConversationTurn(ingestChatId, '[Mission task: ' + mission.title + ']: ' + mission.prompt, text, schedulerAgentId).catch((err) => {
          logger.error({ err, missionId: mission.id }, 'Memory ingestion fire-and-forget failed (mission task)');
        });
      }
    } catch (err) {
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (cancelledByUser) {
        logger.info({ missionId: mission.id }, 'Mission task cancelled by user (threw on abort)');
      } else {
        completeMissionTask(mission.id, null, 'failed', errMsg.slice(0, 500));
        logger.error({ err, missionId: mission.id }, 'Mission task failed');
      }
    } finally {
      clearInterval(cancelPoll);
      runningTaskIds.delete(missionKey);
    }
  });
}

export function computeNextRun(cronExpression: string): number {
  const interval = CronExpressionParser.parse(cronExpression);
  return Math.floor(interval.next().getTime() / 1000);
}
