/**
 * Tool contract for the NL → scene-action loop (PRD §§ 11, 24).
 * Spark REQUESTS; this module VALIDATES against the scene index; the
 * renderer EXECUTES and confirms. Model output is never trusted as an
 * executable command.
 */
import type { ToolDefinition } from '@worldlens/model-adapters';
import {
  findByLabel,
  getSceneIndex,
  relatedEntities,
  type SceneIndex,
} from './scene-index';

export const TOOL_DEFS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'navigateToLocation',
      description:
        'Move the camera to a known location or supported viewpoint in the active scene. ' +
        'Use only locations/viewpoints present in the provided scene summary.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'Name or label of the destination (e.g. "entrance").' },
        },
        required: ['location'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'focusOnObject',
      description: 'Move/rotate the camera to focus on one identified object.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Object label (e.g. "table").' },
          id: { type: 'string', description: 'Stable entity id when known.' },
        },
        required: ['label'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'highlightObjects',
      description: 'Highlight identified objects matching a label query.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Object label (e.g. "chair").' },
        },
        required: ['label'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'showRoute',
      description:
        'Display a route between two known destinations, ONLY if a valid route ' +
        'can be established from the scene graph.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspectLocation',
      description: 'Return evidence-backed information about a region or object.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Region or object label.' },
        },
        required: ['target'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compareLocations',
      description: 'Show two supported locations side by side / in sequence.',
      parameters: {
        type: 'object',
        properties: {
          first: { type: 'string' },
          second: { type: 'string' },
        },
        required: ['first', 'second'],
        additionalProperties: false,
      },
    },
  },
];

export type ValidationOutcome =
  | { status: 'success'; targetId: string | null; message?: string; camera?: CameraCommand; entityIds?: string[]; positions?: [number, number, number][]; evidence?: unknown }
  | { status: 'not_found' | 'invalid_args' | 'unsupported'; targetId: null; message: string };

export interface CameraCommand {
  type: 'tween';
  position: [number, number, number];
  target: [number, number, number];
  durationMs: number;
}

/**
 * Validate one tool call against the live scene index.
 * Returns structured results the model must explain as-is.
 */
export function validateToolCall(
  sceneId: string,
  tool: string,
  rawArgs: string,
): ValidationOutcome {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return { status: 'invalid_args', targetId: null, message: 'Arguments are not valid JSON.' };
  }
  const index: SceneIndex = getSceneIndex(sceneId);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  switch (tool) {
    case 'navigateToLocation': {
      const q = str(args.location);
      if (!q) return { status: 'invalid_args', targetId: null, message: 'Missing "location".' };
      const vp = index.viewpoints.find((v) => v.label.toLowerCase().includes(q.toLowerCase()));
      const ent = index.entities.find(
        (e) => (e.type === 'region' || e.type === 'landmark' || e.type === 'doorway') &&
          e.label.toLowerCase().includes(q.toLowerCase()),
      );
      if (vp?.position && vp?.target) {
        return {
          status: 'success', targetId: vp.id,
          camera: { type: 'tween', position: vp.position, target: vp.target, durationMs: 1600 },
        };
      }
      if (ent) {
        return {
          status: 'not_found', targetId: null,
          message: `"${ent.label}" is identified but has no supported viewpoint yet — ` +
            `navigation needs a registered camera position (Stage 3/4).`,
        };
      }
      return {
        status: 'not_found', targetId: null,
        message: `"${q}" is not identified in this scene. ` +
          (index.status === 'pending'
            ? 'The scene has no indexed entities yet.'
            : 'Available: ' + (index.entities.map((e) => e.label).join(', ') || 'none') + '.'),
      };
    }
    case 'focusOnObject':
    case 'highlightObjects': {
      const q = str(args.label);
      if (!q) return { status: 'invalid_args', targetId: null, message: 'Missing "label".' };
      const matches = findByLabel(index, q);
      if (matches.length === 0) {
        return {
          status: 'not_found', targetId: null,
          message: `No "${q}" identified in this scene.` +
            (index.status === 'pending' ? ' The scene has no indexed entities yet.' : ''),
        };
      }
      const registered = matches.filter((m) => m.position !== null);
      if (registered.length === 0) {        return {
          status: 'success', targetId: matches[0].id,
          entityIds: matches.map((m) => m.id),
          message: `${matches.length} match(es) found but none has a registered 3D position — ` +
            'showing evidence thumbnails only (no invented locations).',
          evidence: { frames: [...new Set(matches.flatMap((m) => m.evidence.frames))] },
        };
      }
      return {
        status: 'success',
        targetId: registered[0].id,
        entityIds: registered.map((m) => m.id),
        positions: registered.map((m) => m.position as [number, number, number]),
      };
    }
    case 'showRoute': {
      return {
        status: 'not_found', targetId: null,
        message: 'No validated route exists between those destinations in this scene. ' +
          (index.status === 'pending'
            ? 'Route planning needs the scene graph (Stage 4).'
            : 'No connecting route entity links them.'),
      };
    }
    case 'inspectLocation': {
      const q = str(args.target);
      if (!q) return { status: 'invalid_args', targetId: null, message: 'Missing "target".' };
      const matches = findByLabel(index, q);
      if (matches.length === 0) {
        return {
          status: 'not_found', targetId: null,
          message: `"${q}" is not identified in this scene. I cannot describe what was not captured or indexed.`,
        };
      }
      const ent = matches[0];
      return {
        status: 'success', targetId: ent.id,
        evidence: { frames: ent.evidence.frames, registered: ent.position !== null },
        message: `"${ent.label}" (${ent.type}) is observed in frames ${ent.evidence.frames.join(', ') || 'none recorded'}.` +
          (ent.position ? '' : ' Its 3D position is not registered.'),
      };
    }
    case 'compareLocations': {
      const a = findByLabel(index, str(args.first));
      const b = findByLabel(index, str(args.second));
      if (a.length === 0 || b.length === 0) {
        return {
          status: 'not_found', targetId: null,
          message: 'One or both locations are not identified in this scene.',
        };
      }
      return { status: 'success', targetId: a[0].id, entityIds: [a[0].id, b[0].id] };
    }
    default:
      return { status: 'unsupported', targetId: null, message: `Unknown tool: ${tool}` };
  }
}

/** Related-entity lookup for follow-up context ("what is beside it"). */
export function describeRelated(sceneId: string, entityId: string): string {
  const index = getSceneIndex(sceneId);
  const rel = relatedEntities(index, entityId);
  if (rel.length === 0) return 'No related entities are recorded for it.';
  return 'Related: ' + rel.map((e) => `${e.label} (${e.type})`).join(', ') + '.';
}
