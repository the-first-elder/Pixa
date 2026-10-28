/**
 * Tool contract for the NL → scene-action loop (PRD §§ 11, 24).
 * Spark REQUESTS; this module VALIDATES against the scene index; the
 * renderer EXECUTES and confirms. Model output is never trusted as an
 * executable command.
 */
import type { ToolDefinition } from '@pixa/model-adapters';
import {
  findByLabel,
  evidenceViewpoint,
  getSceneIndex,
  relatedEntities,
  type SceneIndex,
} from './scene-index';
import { measureLabel } from './scale';

export const TOOL_DEFS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'measureObject',
      description:
        'Measure an indexed object (or "__room" for the room-contents extent) along a dimension. ' +
        'Returns meters ONLY if the scene is scale-calibrated; otherwise reconstruction units with an uncalibrated warning. ' +
        'Use for "how tall/wide/big", "what size", and as input to fit questions.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Object label, or "__room" for room-contents extent.' },
          dimension: { type: 'string', description: '"height" or "width" (default "height").' },
        },
        required: ['label'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calibrateScale',
      description:
        'Calibrate reconstruction units to meters from a user-provided reference measurement, e.g. the user says the door is 2.1 meters tall. ' +
        'Call ONLY with an explicit user-stated real-world size — never guess one. This is the only path to meter answers.',
      parameters: {
        type: 'object',
        properties: {
          referenceLabel: { type: 'string', description: 'Indexed object label, e.g. "door".' },
          dimension: { type: 'string', description: '"height" or "width".' },
          knownMeters: { type: 'number', description: 'User-stated real-world size in meters.' },
        },
        required: ['referenceLabel', 'dimension', 'knownMeters'],
        additionalProperties: false,
      },
    },
  },  {
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
  | { status: 'success'; targetId: string | null; message?: string; camera?: CameraCommand; stops?: CameraCommand[]; entityIds?: string[]; positions?: [number, number, number][]; evidence?: unknown }
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
      if (registered.length === 0) {
        // No 3D position — but fly to where it was SEEN (evidence frame pose).
        // This turns unregistered detections into navigable answers.
        const frames = [...new Set(matches.flatMap((m) => m.evidence.frames))];
        const view = evidenceViewpoint(sceneId, frames);
        if (view) {
          return {
            status: 'success', targetId: matches[0].id,
            entityIds: matches.map((m) => m.id),
            camera: { type: 'tween', position: view.position, target: view.target, durationMs: 1600 },
            evidence: { frames: frames.slice(0, 6) },
            message: `${matches.length} match(es) found but no registered 3D position — ` +
              'flying to the viewpoint where it was seen (frame evidence attached); its exact spot is not fixed.',
          };
        }
        return {
          status: 'success', targetId: matches[0].id,
          entityIds: matches.map((m) => m.id),
          message: `${matches.length} match(es) found but none has a registered 3D position — ` +
            'showing evidence thumbnails only (no invented locations).',
          evidence: { frames },
        };
      }
      // Registered: markers at true positions. focusOnObject additionally gets
      // a size-framed close-up (measured extents -> distance), so "show me the
      // TV" lands on a focused view instead of a wide shot.
      let focusCamera: CameraCommand | undefined;
      if (tool === 'focusOnObject') {
        try {
          const h = measureLabel(sceneId, registered[0].label, 'height');
          const w = measureLabel(sceneId, registered[0].label, 'width');
          const size = Math.max(h.units, w.units);
          if (size > 1e-6) {
            const p = registered[0].position as [number, number, number];
            const distance = Math.min(4, Math.max(0.35, (size / 2 / Math.tan(36 * Math.PI / 180)) * 1.7));
            const dir: [number, number, number] = [0.55, 0.38, 0.55];
            const len = Math.hypot(dir[0], dir[1], dir[2]);
            focusCamera = {
              type: 'tween',
              position: [
                p[0] + (dir[0] / len) * distance,
                p[1] + (dir[1] / len) * distance,
                p[2] + (dir[2] / len) * distance,
              ],
              target: p,
              durationMs: 1600,
            };
          }
        } catch {
          // Measurement failed: markers still highlight; no close-up. Never fail the query.
        }
      }
      return {
        status: 'success',
        targetId: registered[0].id,
        entityIds: registered.map((m) => m.id),
        positions: registered.map((m) => m.position as [number, number, number]),
        ...(focusCamera ? { camera: focusCamera } : {}),
        evidence: { frames: [...new Set(registered.flatMap((m) => m.evidence.frames))].slice(0, 6) },
      };
    }
    case 'showRoute': {
      // Multi-stop cinematic move: resolve both ends to camera-framed stops
      // (viewpoints first, else registered entity positions with an offset
      // framing), then return the ordered stop list. No valid ends = no route.
      const resolveStop = (q: string): { id: string; camera: CameraCommand } | null => {
        const vp = index.viewpoints.find((v) => v.label.toLowerCase().includes(q.toLowerCase()));
        if (vp?.position && vp?.target) {
          return { id: vp.id, camera: { type: 'tween', position: vp.position, target: vp.target, durationMs: 2200 } };
        }
        const ent = findByLabel(index, q).find((e) => e.position !== null);
        if (ent?.position) {
          const p = ent.position;
          return {
            id: ent.id,
            camera: {
              type: 'tween',
              position: [p[0] + 0.8, p[1] + 0.5, p[2] + 0.8],
              target: p,
              durationMs: 2200,
            },
          };
        }
        return null;
      };
      const from = resolveStop(str(args.from));
      const to = resolveStop(str(args.to));
      if (!from || !to) {
        const missing = !from ? str(args.from) : str(args.to);
        return {
          status: 'not_found', targetId: null,
          message: `"${missing}" is not a known destination in this scene. ` +
            (index.status === 'pending'
              ? 'Route planning needs the scene graph (Stage 4).'
              : `Known destinations: ${index.viewpoints.map((v) => v.label).join(', ') || 'none'}.`),
        };
      }
      return {
        status: 'success', targetId: to.id,
        stops: [from.camera, to.camera],
        message: `Route from ${str(args.from)} to ${str(args.to)}: 2 stops.`,
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
    case 'measureObject': {
      const q = str(args.label);
      if (!q) return { status: 'invalid_args', targetId: null, message: 'Missing "label".' };
      const dim = str(args.dimension) || 'height';
      if (dim !== 'height' && dim !== 'width') {
        return { status: 'invalid_args', targetId: null, message: 'dimension must be "height" or "width".' };
      }
      if (q === '__room') {
        return { status: 'success', targetId: 'room', message: 'Room-contents extent measurement.' };
      }
      const matches = findByLabel(index, q);
      if (matches.length === 0) {
        return { status: 'not_found', targetId: null, message: `No "${q}" identified in this scene.` };
      }
      return { status: 'success', targetId: matches[0].id, message: `Measuring ${matches[0].label}.` };
    }
    case 'calibrateScale': {
      const q = str(args.referenceLabel);
      const dim = str(args.dimension);
      const meters = Number(args.knownMeters);
      if (!q) return { status: 'invalid_args', targetId: null, message: 'Missing "referenceLabel".' };
      if (dim !== 'height' && dim !== 'width') {
        return { status: 'invalid_args', targetId: null, message: 'dimension must be "height" or "width".' };
      }
      if (!Number.isFinite(meters) || meters <= 0 || meters > 100) {
        return { status: 'invalid_args', targetId: null, message: 'knownMeters must be a positive real-world size.' };
      }
      const matches = findByLabel(index, q);
      if (matches.length === 0) {
        return { status: 'not_found', targetId: null, message: `No "${q}" identified — cannot calibrate from it.` };
      }
      return { status: 'success', targetId: matches[0].id, message: `Calibrating from ${matches[0].label}.` };
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
