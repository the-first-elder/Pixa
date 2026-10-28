/**
 * Project status mapping (server-only). Maps internal job/recording states to
 * user-facing labels. No invented percentages — indeterminate stages say so.
 */
import 'server-only';

export type ProjectStatus =
  | 'ready-to-upload'
  | 'analyzing'
  | 'waiting'
  | 'reconstructing'
  | 'finalizing'
  | 'ready'
  | 'needs-attention'
  | 'failed'
  | 'cancelled';

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  'ready-to-upload': 'Ready to upload',
  analyzing: 'Analyzing video',
  waiting: 'Waiting for reconstruction',
  reconstructing: 'Reconstructing',
  finalizing: 'Finalizing scene',
  ready: 'Ready to explore',
  'needs-attention': 'Needs attention',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const FINALIZING = new Set(['compressing', 'building_scene_index']);
const ACTIVE = new Set([
  'uploaded',
  'queued',
  'extracting_frames',
  'estimating_camera_poses',
  'reconstructing',
]);

/** Map a job (or nothing) to a user-facing status. Never invents progress. */
export function jobToStatus(job: {
  status: string;
  errorCode?: string | null;
  waitingForTrainer?: boolean;
} | null): ProjectStatus {
  if (!job) return 'ready-to-upload';
  if (job.status === 'ready') return 'ready';
  if (job.status === 'failed') {
    return job.errorCode === 'CANCELLED' ? 'cancelled' : 'failed';
  }
  if (job.waitingForTrainer || job.status === 'queued') return 'waiting';
  if (FINALIZING.has(job.status)) return 'finalizing';
  if (ACTIVE.has(job.status)) return 'reconstructing';
  return 'needs-attention';
}

/** Recording-level status from segment states (honest partial success). */
export function segmentsToStatus(states: string[]): ProjectStatus {
  if (states.length === 0) return 'analyzing';
  if (states.every((s) => s === 'ready')) return 'ready';
  if (states.some((s) => ACTIVE.has(s) || FINALIZING.has(s))) {
    return states.some((s) => s === 'failed') ? 'needs-attention' : 'reconstructing';
  }
  if (states.some((s) => s === 'failed')) {
    return states.some((s) => s === 'ready') ? 'needs-attention' : 'failed';
  }
  if (states.some((s) => s === 'queued')) return 'waiting';
  return 'analyzing';
}
