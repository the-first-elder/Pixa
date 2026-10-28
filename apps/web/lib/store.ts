/**
 * File-backed scene/job store. Server-only.
 * Mirrors services/reconstruction/worker/store.py EXACTLY — same directory
 * (STORAGE_DIR), same filenames, same record shapes — so the Next.js API and
 * the Python worker operate on the same jobs. Atomic writes via tmp+rename.
 */
import 'server-only';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { STORAGE_DIR } from './config';

export const JOB_STATES = [
  'uploaded',
  'queued',
  'extracting_frames',
  'estimating_camera_poses',
  'reconstructing',
  'compressing',
  'building_scene_index',
  'ready',
  'failed',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobTransition {
  status: JobState;
  at: string;
}

export interface ProcessingJob {
  id: string;
  sceneId: string;
  jobType: string;
  status: JobState;
  progress: number | null;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  diagnostics: unknown;
  transitions: JobTransition[];
  backendHandle?: unknown;
  waitingForTrainer?: boolean;
  waitingSince?: string;
  ownerId?: string | null;
}

export interface Scene {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  sourceVideo: Record<string, unknown> | null;
  visualAssetId: string | null;
  manifestId: string | null;
  sceneGraphVersion: number;
  visibility: 'private' | 'public';
  processingError: string | null;
  ownerId?: string | null;
}

function dir(): string {
  mkdirSync(STORAGE_DIR, { recursive: true });
  return STORAGE_DIR;
}

function load<T>(name: string): Record<string, T> {
  const path = join(dir(), name);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, T>;
  } catch {
    return {};
  }
}

function save<T>(name: string, data: Record<string, T>): void {
  const path = join(dir(), name);
  const tmp = join(tmpdir(), `wl-${Date.now()}-${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export function createScene(name: string, ownerId?: string | null): Scene {
  const scenes = load<Scene>('scenes.json');
  const scene: Scene = {
    id: newId('scene'),
    name,
    status: 'created',
    createdAt: now(),
    sourceVideo: null,
    visualAssetId: null,
    manifestId: null,
    sceneGraphVersion: 0,
    visibility: 'private',
    processingError: null,
    ownerId: ownerId ?? null,
  };
  scenes[scene.id] = scene;
  save('scenes.json', scenes);
  return scene;
}

export function getScene(id: string): Scene | null {
  return load<Scene>('scenes.json')[id] ?? null;
}

export function updateScene(id: string, patch: Partial<Scene>): Scene {
  const scenes = load<Scene>('scenes.json');
  const scene = scenes[id];
  if (!scene) throw new Error(`Scene not found: ${id}`);
  const updated = { ...scene, ...patch };
  scenes[id] = updated;
  save('scenes.json', scenes);
  return updated;
}

export function createJob(sceneId: string, jobType: string, ownerId?: string | null): ProcessingJob {
  const jobs = load<ProcessingJob>('jobs.json');
  const job: ProcessingJob = {
    id: newId('job'),
    sceneId,
    jobType,
    status: 'queued',
    progress: 0,
    startedAt: now(),
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    diagnostics: null,
    transitions: [{ status: 'queued', at: now() }],
    ownerId: ownerId ?? null,
  };
  jobs[job.id] = job;
  save('jobs.json', jobs);
  return job;
}

export function getJob(id: string): ProcessingJob | null {
  return load<ProcessingJob>('jobs.json')[id] ?? null;
}

/** Jobs currently waiting for the single trainer slot. Bounds the queue. */
export function waitingTrainerCount(): number {
  return Object.values(load<ProcessingJob>('jobs.json')).filter(
    (j) => j.waitingForTrainer === true && j.status !== 'ready' && j.status !== 'failed',
  ).length;
}

/** Latest job for a scene (for status display). Null when none exists. */
export function latestJobForScene(sceneId: string): ProcessingJob | null {
  const jobs = Object.values(load<ProcessingJob>('jobs.json'))
    .filter((j) => j.sceneId === sceneId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return jobs[0] ?? null;
}

export interface StoredAsset {
  assetPath: string;
  format: string;
  posesPath?: string | null;
  posesFormat?: string | null;
}

/** Latest READY reconstruction job carrying a verified asset. Null otherwise. */
export function readyAssetForScene(
  sceneId: string,
): (StoredAsset & { jobId: string }) | null {
  const jobs = Object.values(load<ProcessingJob>('jobs.json'))
    .filter(
      (j) =>
        j.sceneId === sceneId &&
        j.jobType === 'reconstruction' &&
        j.status === 'ready' &&
        typeof (j as ProcessingJob & { asset?: unknown }).asset === 'object' &&
        (j as ProcessingJob & { asset?: StoredAsset }).asset !== null,
    )
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const job = jobs[0] as (ProcessingJob & { asset: StoredAsset }) | undefined;
  if (!job) return null;
  return { ...job.asset, jobId: job.id };
}

// ---------------------------------------------------------------------------
// Conversation sessions + scene actions (PRD §§ 22, 24 — what the AI
// requested vs. what actually executed).
// ---------------------------------------------------------------------------

export interface HistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationSession {
  id: string;
  sceneId: string;
  createdAt: string;
  lastActiveAt: string;
  history: HistoryItem[];
  lastEntityId: string | null;
}

export interface SceneAction {
  id: string;
  sessionId: string;
  actionType: string;
  targetEntityId: string | null;
  arguments: Record<string, unknown>;
  status: string;
  executionResult: Record<string, unknown> | null;
  executed: boolean;
  createdAt: string;
}

export interface SceneScale {
  sceneId: string;
  scale: number; // reconstruction units per meter
  referenceLabel: string;
  dimension: 'height' | 'width';
  knownMeters: number;
  measuredUnits: number;
  uncertaintyPct: number;
  method: string;
  createdAt: string;
}

export function getScale(sceneId: string): SceneScale | null {
  return load<SceneScale>('scales.json')[sceneId] ?? null;
}

export function setScale(scale: Omit<SceneScale, 'createdAt'>): SceneScale {
  const scales = load<SceneScale>('scales.json');
  const full: SceneScale = { ...scale, createdAt: now() };
  scales[scale.sceneId] = full;
  save('scales.json', scales);
  return full;
}

export function deleteScale(sceneId: string): void {
  const scales = load<SceneScale>('scales.json');
  delete scales[sceneId];
  save('scales.json', scales);
}

export function getOrCreateSession(sceneId: string, sessionId?: string): ConversationSession {
  const sessions = load<ConversationSession>('sessions.json');
  if (sessionId && sessions[sessionId] && sessions[sessionId].sceneId === sceneId) {
    return sessions[sessionId];
  }
  const session: ConversationSession = {
    id: newId('session'),
    sceneId,
    createdAt: now(),
    lastActiveAt: now(),
    history: [],
    lastEntityId: null,
  };
  sessions[session.id] = session;
  save('sessions.json', sessions);
  return session;
}

export function appendHistory(sessionId: string, items: HistoryItem[]): void {
  const sessions = load<ConversationSession>('sessions.json');
  const session = sessions[sessionId];
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  session.history = [...session.history, ...items].slice(-40);
  session.lastActiveAt = now();
  sessions[sessionId] = session;
  save('sessions.json', sessions);
}

export function updateLastEntity(sessionId: string, entityId: string | null): void {
  const sessions = load<ConversationSession>('sessions.json');
  const session = sessions[sessionId];
  if (!session) return;
  session.lastEntityId = entityId;
  session.lastActiveAt = now();
  sessions[sessionId] = session;
  save('sessions.json', sessions);
}

export function recordAction(action: Omit<SceneAction, 'id' | 'createdAt'>): SceneAction {
  const actions = load<SceneAction>('actions.json');
  const full: SceneAction = { ...action, id: newId('action'), createdAt: now() };
  actions[full.id] = full;
  save('actions.json', actions);
  return full;
}

export function confirmAction(
  id: string,
  patch: { executed: boolean; status: string; executionResult: Record<string, unknown> },
): SceneAction | null {
  const actions = load<SceneAction>('actions.json');
  const action = actions[id];
  if (!action) return null;
  const updated = { ...action, ...patch };
  actions[id] = updated;
  save('actions.json', actions);
  return updated;
}

export function actionsForSession(sessionId: string): SceneAction[] {
  return Object.values(load<SceneAction>('actions.json'))
    .filter((a) => a.sessionId === sessionId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}
