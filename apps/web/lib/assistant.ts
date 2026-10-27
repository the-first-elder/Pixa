/**
 * Conversational pipeline: retrieve → Spark tool loop → validate → dispatch
 * → record → grounded answer (PRD §§ 12, 13, 24).
 * Server-only. Secrets never leave here.
 */
import 'server-only';
import { chat, type ToolCall } from '@worldlens/model-adapters';
import type { ActionResult } from '@worldlens/shared-types';
import {
  appendHistory,
  getOrCreateSession,
  recordAction,
  type ConversationSession,
} from './store';
import { getSceneIndex } from './scene-index';
import { TOOL_DEFS, validateToolCall } from './tools';

const SYSTEM_PROMPT = `You are the WorldLens scene assistant. You control a reconstructed 3D environment through tools — you never manipulate the renderer directly.

Grounding rules (no exceptions):
- OBSERVED: only what the provided scene summary and evidence support.
- INFERRED: mark clearly as interpretation ("this area may be…").
- UNKNOWN: if evidence is missing or the target is not identified, say what is missing. Never invent rooms, objects, positions, measurements, or routes.
- Numbers/measurements: only from validated geometry, with uncertainty. Never present a guess as verified.
- Tool results: explain the ACTUAL validation outcome returned to you. If status is not_found, tell the user plainly and do not claim the action happened.
- Follow-ups ("it", "there") refer to the most recently selected entity, resolved server-side.

Behavior:
- Prefer calling exactly the tools needed, then answer concisely (2-4 sentences) describing what the user now sees and citing evidence (entity labels, frame ids) where relevant.
- If nothing needs a tool (greetings, capability questions), answer directly and honestly about current capabilities.`;

export interface DispatchedAction extends ActionResult {
  actionId: string;
  camera?: { type: 'tween'; position: [number, number, number]; target: [number, number, number]; durationMs: number };
  positions?: [number, number, number][];
  evidence?: unknown;
}

export interface QueryOutcome {
  sessionId: string;
  response: string;
  actions: DispatchedAction[];
}

function sceneSummary(sceneId: string): string {
  const index = getSceneIndex(sceneId);
  if (index.status === 'pending') {
    return 'Scene index: PENDING. No entities, relationships, or viewpoints are indexed yet. ' +
      'Any location/object/route request will validate as not_found — say so explicitly.';
  }
  const lines = index.entities.map(
    (e) => `- ${e.label} [${e.type}] id=${e.id} status=${e.status} ` +
      (e.position ? `registered@${e.position.join(',')}` : 'position=unregistered') +
      ` frames=${e.evidence.frames.join(',') || 'none'}`,
  );
  const vps = index.viewpoints.map((v) => `- viewpoint ${v.label} id=${v.id}`).join('\n');
  return `Scene index (${index.status}). Entities:\n${lines.join('\n') || '(none)'}\nViewpoints:\n${vps || '(none)'}`;
}

export async function runQuery(
  sceneId: string,
  message: string,
  sessionId?: string,
): Promise<QueryOutcome> {
  const session: ConversationSession = getOrCreateSession(sceneId, sessionId);
  const history = session.history.map((h) => ({
    role: h.role as 'user' | 'assistant',
    content: h.content,
  }));

  const result = await chat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Active scene ${sceneId}.\n${sceneSummary(sceneId)}` },
      ...history,
      { role: 'user', content: message },
    ],
    tools: TOOL_DEFS,
    maxTokens: 2048,
  });

  const dispatched: DispatchedAction[] = [];
  for (const call of result.toolCalls as ToolCall[]) {
    const name = call.function.name;
    const validation = validateToolCall(sceneId, name, call.function.arguments);
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch {
      // parsedArgs stays {}; validation already reports invalid_args.
    }
    const action = recordAction({
      sessionId: session.id,
      actionType: name,
      targetEntityId: validation.targetId,
      arguments: parsedArgs,
      status: validation.status,
      executionResult: null,
      executed: false,
    });
    dispatched.push({
      action: name as DispatchedAction['action'],
      status: validation.status,
      targetId: validation.targetId,
      executed: false,
      message: 'message' in validation ? validation.message : undefined,
      actionId: action.id,
      camera: 'camera' in validation ? validation.camera : undefined,
      positions: 'positions' in validation ? validation.positions : undefined,
      entityIds: 'entityIds' in validation ? validation.entityIds : undefined,
      evidence: 'evidence' in validation ? validation.evidence : undefined,
    });
  }

  // Second pass: model explains the ACTUAL validation outcomes (never claims success on failure).
  let response = result.content?.trim() ?? '';
  if (dispatched.length > 0) {
    const report = dispatched
      .map((d) => `- ${d.action}: status=${d.status} target=${d.targetId ?? 'none'}${d.message ? ` — ${d.message}` : ''}`)
      .join('\n');
    const follow = await chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `User request: ${message}\nTool execution results (ground truth, explain these exactly):\n${report}\n` +
            `Write the user-facing reply (2-4 sentences, evidence-cited, honest about failures).`,
        },
      ],
      maxTokens: 2048,
    });
    if (follow.content?.trim()) response = follow.content.trim();
  }
  if (!response) {
    response = dispatched.length > 0
      ? 'I processed that request — see the action panel for what executed.'
      : 'I could not produce an answer for that. Try asking about a specific place or object.';
  }

  appendHistory(session.id, [
    { role: 'user', content: message },
    { role: 'assistant', content: response },
  ]);
  return { sessionId: session.id, response, actions: dispatched };
}
