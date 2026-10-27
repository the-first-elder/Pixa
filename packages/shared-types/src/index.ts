/**
 * @worldlens/shared-types — contracts shared by apps/web and services/*.
 * Source PRD: §§ 10, 11, 22, 23. These types are the law: worker output,
 * scene index, tool loop, and UI must all conform to them.
 */

// ---------------------------------------------------------------------------
// Processing jobs (PRD §8.4 — every transition is recorded)
// ---------------------------------------------------------------------------

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

export const JOB_TYPES = [
  'reconstruction',
  'scene_index',
  'capture_report',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface ReconstructionDiagnostics {
  cameraPosesEstimated: boolean | null;
  framesRegistered: number | null;
  framesRejected: number | null;
  coverageConcentratedInOneArea: boolean | null;
  largeGapsOrUnstableRegions: boolean | null;
  notes: string[];
}

export interface ProcessingJob {
  id: string;
  sceneId: string;
  jobType: JobType;
  status: JobState;
  /** 0-100 from measured stages/frame counts. NEVER a fabricated timer. Null when unknown. */
  progress: number | null;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  diagnostics?: ReconstructionDiagnostics | null;
}

// ---------------------------------------------------------------------------
// Scene index: entities + relationships (PRD §§ 9, 10, 22)
// ---------------------------------------------------------------------------

export const ENTITY_TYPES = [
  'environment',
  'region',
  'landmark',
  'object',
  'doorway',
  'viewpoint',
  'route',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const RELATIONSHIP_TYPES = [
  'contains',
  'connects_to',
  'near',
  'inside',
  'visible_from',
  'adjacent_to',
  'occluded_by',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** Provenance of a relationship or registration. Unknown ≠ false; it means unestablished. */
export const PROVENANCE_STATUS = [
  'identified',
  'inferred',
  'verified',
  'unknown',
] as const;
export type ProvenanceStatus = (typeof PROVENANCE_STATUS)[number];

export type VisualStatus = 'detected' | 'not_detected';
export type SpatialRegistrationStatus =
  | 'unregistered'
  | 'approximate'
  | 'registered';

export interface EvidenceReference {
  frameIds: number[];
  objectIds?: string[];
}

export interface SceneEntity {
  id: string;
  sceneId: string;
  type: EntityType;
  label: string;
  description: string | null;
  visualStatus: VisualStatus;
  spatialRegistrationStatus: SpatialRegistrationStatus;
  /** NULL until a defensible spatial location exists. Never fabricated. */
  position: [number, number, number] | null;
  /** How the position was established (e.g. "colmap-triangulation", "manual"). Null when unregistered. */
  coordinateProvenance: string | null;
  evidenceReferences: EvidenceReference;
  createdAt: string;
  updatedAt: string;
}

export interface SceneRelationship {
  id: string;
  sceneId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: RelationshipType;
  status: ProvenanceStatus;
  evidenceReferences: EvidenceReference | null;
}

// ---------------------------------------------------------------------------
// Evidence-grounded answers (PRD §13)
// ---------------------------------------------------------------------------

export const CLAIM_TYPES = [
  'observed',
  'geometrically_established',
  'inferred',
  'unknown',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export interface EvidenceRecord {
  claim: string;
  claimType: ClaimType;
  evidence: {
    frameIds: number[];
    objectIds?: string[];
  };
  /** Visual evidence ≠ validated geometry. Never a model-confidence score. */
  spatialConfidence: 'verified' | 'approximate' | 'unverified';
}

// ---------------------------------------------------------------------------
// Scene actions / tool loop (PRD §§ 11, 24)
// ---------------------------------------------------------------------------

export const TOOL_NAMES = [
  'navigateToLocation',
  'focusOnObject',
  'highlightObjects',
  'showRoute',
  'inspectLocation',
  'compareLocations',
  'measureObject',
  'calibrateScale',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const ACTION_STATUSES = [
  'success',
  'not_found',
  'invalid_args',
  'unsupported',
  'execution_failed',
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export interface ActionResult {
  action: ToolName;
  status: ActionStatus;
  targetId: string | null;
  executed: boolean;
  message?: string;
  entityIds?: string[];
}

/** Capabilities exposed = capabilities supported by available data (PRD §4.5). */
export interface SceneCapabilities {
  navigation: boolean;
  objectHighlight: boolean;
  routes: boolean;
  measurement: boolean;
  coverage: boolean;
}

// ---------------------------------------------------------------------------
// Application API shapes (PRD §23 — app API, NOT Meta endpoints)
// ---------------------------------------------------------------------------

export interface CreateSceneRequest {
  name: string;
}
export interface CreateSceneResponse {
  sceneId: string;
  status: 'created';
}

export interface StartProcessingResponse {
  jobId: string;
  status: 'queued';
}

export interface JobStatusResponse {
  jobId: string;
  status: JobState;
  progress: number | null;
}

export interface QueryRequest {
  message: string;
  sessionId: string;
}
export interface QueryAction {
  type: ToolName;
  status: ActionStatus;
  entityIds?: string[];
}
export interface QueryResponse {
  response: string;
  actions: QueryAction[];
  evidence?: EvidenceRecord[];
}
