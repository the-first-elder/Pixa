/**
 * Conversational pipeline: retrieve → Spark tool loop → validate → dispatch
 * → record → grounded answer (PRD §§ 12, 13, 24).
 * Server-only. Secrets never leave here.
 */
import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chat, type ChatContentPart, type ToolCall } from '@pixa/model-adapters';
import type { ActionResult } from '@pixa/shared-types';
import { STORAGE_DIR } from './config';
import {
  appendHistory,
  getOrCreateSession,
  recordAction,
  updateLastEntity,
  type ConversationSession,
} from './store';
import { getSceneIndex, relatedEntities } from './scene-index';
import { TOOL_DEFS, describeRelated, validateToolCall } from './tools';
import { calibrateSceneScale, measureLabel } from './scale';

const SYSTEM_PROMPT = `You are the Pixa scene assistant. You control a reconstructed 3D environment through tools — you never manipulate the renderer directly.

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
  stops?: { type: 'tween'; position: [number, number, number]; target: [number, number, number]; durationMs: number }[];
  positions?: [number, number, number][];
  evidence?: unknown;
  result?: unknown;
}

export interface QueryOutcome {
  sessionId: string;
  response: string;
  actions: DispatchedAction[];
}

function sceneSummary(sceneId: string): string {
  const index = getSceneIndex(sceneId);
  const scaleNote =
    'Scale: UNCALIBRATED reconstruction units — never report meters, widths, or room dimensions as measured. ' +
    'If asked for size/dimensions, explain scale is not established and give only qualitative relations.';
  const coverageNote = (() => {
    if (!index.coverage) return 'Coverage: unknown (no coverage report yet) — do not claim full coverage.';
    const base = 'Coverage: ' + index.coverage.registeredFrames + '/' + index.coverage.totalFrames +
      ' frames registered (' + index.coverage.percent + '%). ';
    if (index.coverage.gapRanges.length === 0) return base + 'No unreconstructed gaps.';
    const gaps = index.coverage.gapRanges.map(([a, b]) => (a === b ? String(a) : a + '-' + b)).join(', ');
    return base + 'Unreconstructed gaps (treat as damaged/unknown, warn before navigating there): frames ' + gaps + '.';
  })();
  if (index.status === 'pending') {
    return `Scene index: PENDING. No entities, relationships, or viewpoints are indexed yet. ${scaleNote} ${coverageNote} ` +
      'Any location/object/route request will validate as not_found — say so explicitly.';
  }
  const lines = index.entities.map(
    (e) => `- ${e.label} [${e.type}] id=${e.id} status=${e.status} ` +
      (e.position ? `registered@${e.position.join(',')}` : 'position=unregistered') +
      ` frames=${e.evidence.frames.join(',') || 'none'}`,
  );
  const vps = index.viewpoints.map((v) => `- viewpoint ${v.label} id=${v.id}`).join('\n');
  return `Scene index (${index.status}). Entities:\n${lines.join('\n') || '(none)'}\nViewpoints:\n${vps || '(none)'}\n${scaleNote}\n${coverageNote}`;
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

  // Pronoun follow-ups ("what is beside it?") resolve against the previously
  // selected entity via the scene graph — scoped to this scene/session.
  let effectiveMessage = message;
  const lastId = session.lastEntityId;
  if (lastId && /\b(it|that|there|this one|the same)\b/i.test(message) &&
      !/\b(bed|chair|table|door|window|wardrobe|bag|clothes|handbag|shirt|entrance|room|area|region|view|route|tour)\b/i.test(message)) {
    const index0 = getSceneIndex(sceneId);
    const prev = index0.entities.find((e) => e.id === lastId);
    if (prev) {
      const rel = relatedEntities(index0, lastId);
      const relText = rel.length > 0
        ? rel.map((e) => `'${e.label}' (${e.type}, id=${e.id})`).join(', ')
        : 'nothing recorded';
      effectiveMessage =
        `[Follow-up context: the user previously selected '${prev.label}' (id=${prev.id}). ` +
        `Graph relations for it: ${describeRelated(sceneId, lastId)}. ` +
        `Related entities: ${relText}.] User request: ${message}`;
    }
  }

  const result = await chat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Active scene ${sceneId}.\n${sceneSummary(sceneId)}` },
      ...history,
      { role: 'user', content: effectiveMessage },
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
    // Server-side measurement execution (needs filesystem + geometry).
    let execResult: Record<string, unknown> | null = null;
    let execMessage: string | undefined;
    let execStatus: ActionResult['status'] = validation.status === 'success' || validation.status === 'not_found' || validation.status === 'invalid_args' || validation.status === 'unsupported'
      ? validation.status
      : 'execution_failed';
    if (validation.status === 'success' && (name === 'measureObject' || name === 'calibrateScale')) {
      try {
        if (name === 'measureObject') {
          const dim = parsedArgs.dimension === 'width' ? 'width' : 'height';
          const m = measureLabel(sceneId, String(parsedArgs.label ?? ''), dim as 'height' | 'width');
          execResult = { ...(m as unknown as Record<string, unknown>) };
          execMessage = m.calibrated && m.meters !== null
            ? `${m.label} ${m.dimension}: ${m.meters.toFixed(2)} m ±${m.uncertaintyPct}% (frames ${m.frames.join(',') || 'n/a'})`
            : `${m.label} ${m.dimension}: ${m.units.toFixed(2)} reconstruction units (UNCALIBRATED — not meters). Give me one real measurement (e.g. "the door is 2.1 meters tall") to calibrate.`;
        } else {
          const dim = parsedArgs.dimension === 'width' ? 'width' : 'height';
          const s = calibrateSceneScale(sceneId, String(parsedArgs.referenceLabel ?? ''), dim as 'height' | 'width', Number(parsedArgs.knownMeters));
          execResult = { ...(s as unknown as Record<string, unknown>) };
          execMessage = `Scale calibrated: 1 m = ${s.scale.toFixed(3)} units (±${s.uncertaintyPct}%), from ${s.referenceLabel} ${s.dimension} = ${s.knownMeters} m.`;
        }
      } catch (e) {
        execStatus = 'execution_failed';
        execMessage = e instanceof Error ? e.message.slice(0, 200) : 'Measurement failed';
      }
    }
    const action = recordAction({
      sessionId: session.id,
      actionType: name,
      targetEntityId: validation.targetId,
      arguments: parsedArgs,
      status: execStatus,
      executionResult: execResult,
      executed: false,
    });
    dispatched.push({
      action: name as DispatchedAction['action'],
      status: execStatus,
      targetId: validation.targetId,
      executed: false,
      message: execMessage ?? ('message' in validation ? validation.message : undefined),
      actionId: action.id,
      camera: 'camera' in validation ? validation.camera : undefined,
      stops: 'stops' in validation ? validation.stops : undefined,
      positions: 'positions' in validation ? validation.positions : undefined,
      entityIds: 'entityIds' in validation ? validation.entityIds : undefined,
      evidence: 'evidence' in validation ? validation.evidence : undefined,
      result: execResult ?? undefined,
    });
    // Follow-up context ("it", "there") resolves to the last selected entity.
    if (validation.status === 'success' && validation.targetId) {
      updateLastEntity(session.id, validation.targetId);
    }
  }

  // Second pass: model explains the ACTUAL validation outcomes (never claims success on failure).
  // Evidence frames are attached as images so attribute questions (color, state,
  // contents) are answered from real pixels, not priors.
  let response = result.content?.trim() ?? '';
  if (dispatched.length > 0) {
    const report = dispatched
      .map((d) => `- ${d.action}: status=${d.status} target=${d.targetId ?? 'none'}${d.message ? ` — ${d.message}` : ''}`)
      .join('\n');
    const frameNums = [
      ...new Set(
        dispatched.flatMap((d) => {
          const ev = d.evidence as { frames?: number[] } | undefined;
          return Array.isArray(ev?.frames) ? ev.frames : [];
        }),
      ),
    ].slice(0, 3);
    const imageParts: ChatContentPart[] = [];
    for (const f of frameNums) {
      try {
        const p = join(STORAGE_DIR, 'assets', sceneId, 'frames', `${String(f).padStart(4, '0')}.jpg`);
        imageParts.push({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${readFileSync(p).toString('base64')}` },
        });
      } catch {
        // Missing frame file: answer from text evidence only, never fail the query.
      }
    }
    const follow = await chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `User request: ${message}\nTool execution results (ground truth, explain these exactly):\n${report}\n` +
                `Attached evidence frames show the relevant objects (frame numbers match the evidence above). ` +
                `Use them for visual attributes (color, state, contents); cite frame numbers. ` +
                `Write the user-facing reply (2-4 sentences, evidence-cited, honest about failures).`,
            },
            ...imageParts,
          ],
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
