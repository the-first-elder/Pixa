# Pixa — Staged Build PRD

Version: 1.0
Status: Build specification for staged implementation
Target: Meta Global AI Developer Hackathon, November 2026
Primary platform: Web application (Next.js + TypeScript + Three.js + Gaussian Splatting viewer)
Product category: AI-powered spatial computing and interactive 3D environments

**Source PRD:** The full product specification is reproduced in staged form below. Nothing from the source PRD is omitted; features, acceptance criteria, architecture, data model, APIs, UI requirements, security, reliability, performance, evaluation metrics, risks, MVP definition, and demo scenario are all mapped to stages.

**How to use this document:** Build stages strictly in order (0 → 8). A stage must pass its exit gate before the next stage begins. Every stage lists Goals, Preconditions, Tasks, Deliverables, Acceptance Criteria, and an Exit Gate. Verification commands/behaviors are included so an autonomous agent can self-check.

---

## Table of Contents

1. [Global Build Context](#stage-0-global-build-context)
2. [Stage 0 — Project Scaffolding & API Access Verification](#stage-0-project-scaffolding--api-access-verification)
3. [Stage 1 — Prove the 3D Pipeline (Reconstruction)](#stage-1-prove-the-3d-pipeline-reconstruction)
4. [Stage 2 — Video Capture & Upload (Web App)](#stage-2-video-capture--upload-web-app)
5. [Stage 3 — Scene Index & Spatial Understanding](#stage-3-scene-index--spatial-understanding)
6. [Stage 4 — Structured Scene Graph](#stage-4-structured-scene-graph)
7. [Stage 5 — Natural-Language Scene Actions](#stage-5-natural-language-scene-actions)
8. [Stage 6 — Voice & Conversational Interaction](#stage-6-voice--conversational-interaction)
9. [Stage 7 — Evidence Grounding, Capture Director & Uncertainty](#stage-7-evidence-grounding-capture-director--uncertainty)
10. [Stage 8 — P1 Features: Measurement, Personalization, Sharing, Coverage Map](#stage-8-p1-features)
11. [Reference: Cross-Stage Specifications](#reference-cross-stage-specifications)
    - 11.1 Technical Architecture
    - 11.2 Model Integration Plan
    - 11.3 3D Subsystem Detail
    - 11.4 Data Model
    - 11.5 API Design
    - 11.6 End-to-End Request Processing
    - 11.7 UI Requirements
    - 11.8 Visual Style
    - 11.9 Security, Privacy & Data Governance
    - 11.10 Reliability & Failure Handling
    - 11.11 Performance Requirements
    - 11.12 Evaluation Metrics & Test Suite
    - 11.13 Project Structure
    - 11.14 Technical Risks & Mitigations
12. [Stage 9 — Polish, Demo & Definition of Done](#stage-9-polish-demo--definition-of-done)
13. [MVP Definition](#mvp-definition)
14. [Demonstration Scenario](#demonstration-scenario)
15. [Product Vision, Principles & Non-Goals (Standing Context)](#product-vision-principles--non-goals)

---

## Stage 0 — Global Build Context

**Read before any stage. These rules apply to all stages and must never be violated.**

### 0.1 Core Product Principles (standing constraints)

1. **Real 3D, not simulated.** The environment must be generated from actual captured footage. A manually designed scene may be used only for interface development, never as the demo scene or as evidence.
2. **AI actions must affect the scene.** navigate → camera moves; highlight → object highlights; route → route displays. The assistant must never merely describe what it *would* do.
3. **Separate visual appearance from spatial truth.** Maintain separate representations for: (a) the visually reconstructed environment, (b) objects/locations identified within it, (c) geometry/spatial relationships actually established, (d) confidence and provenance of observations.
4. **Do not invent unseen environments.** AI-generated imagery may be used for optional visualization but must never silently become evidence of what the physical environment contains. A null position is preferable to a fabricated coordinate.
5. **Progressive capability.** A scene stays useful when advanced capabilities are unavailable. Expose only capabilities supported by available data:
   - Visual-only scene → camera navigation
   - + object labels → object highlighting
   - + spatial graph → location-to-location navigation
   - + validated metric geometry → measurement-dependent features

### 0.2 Feature priorities used throughout

- **P0 — Essential:** required for hackathon demonstration.
- **P1 — High value:** implement if core pipeline works reliably.
- **P2 — Future capability:** product-vision-important, not needed for first demo.

### 0.3 Non-goals (never build these in the hackathon)

Not a universal digital-twin platform, marketplace, unrestricted game engine, professional surveying/inspection/accessibility tool, or multi-tenant enterprise platform. No guaranteed architectural measurements from arbitrary phone video, no real-time photorealistic reconstruction while recording, no reconstruction of complete rooms from a single photo, no autonomous control of physical machinery.

### 0.4 Standing security rule

Meta API credentials and storage credentials remain server-side. Never embed private API keys in frontend JavaScript. Model names/versions/endpoints/capabilities live in configuration, accessed through model adapters.

---

## Stage 0 — Project Scaffolding & API Access Verification

Priority: P0 · Estimated size: small · Blocks: everything

### Goals

A running monorepo, verified access to all required Meta models, and demo capture fixtures in hand — before any expensive engineering begins.

### Preconditions

None.

### Tasks

1. **Initialize monorepo** matching §11.13 (Project Structure): `apps/web` (Next.js, TypeScript, React, Tailwind), `services/reconstruction` (Python), `services/scene-index`, `packages/shared-types`, `packages/scene-schema`, `packages/model-adapters`, `fixtures/demo-scene`, `docs/`.
2. **Verify Meta model API access immediately** (§20.6). For each of Muse Spark, SAM 3.1, Muse Voice Transcribe, Muse Image:
   - Confirm project access, current API endpoint and authentication, supported model identifiers.
   - Document input limits, supported image/video/audio formats, tool-calling support, rate limits, output schemas, pricing/hackathon usage limits, terms governing use and storage of uploaded data.
   - Write findings to `docs/model-api-notes.md`.
3. **Build the model-adapter layer skeleton** in `packages/model-adapters/`: one thin adapter per model (spark, sam, voice-transcribe, image), each with typed inputs/outputs and a stubbed fallback mode. Endpoints/IDs/config come from config, never hard-coded in call sites.
4. **Record demo fixtures** (select an indoor environment that has: an entrance, a central area, a table or other recognizable object, several additional objects, ≥2 useful viewpoints; small enough to reconstruct reliably within time and budget):
   - Fixture A: a good recording (~30–120 s, one connected indoor space, deliberate overlapping views, slow panning).
   - Fixture B: a deliberately incomplete recording (occluded region or missing area) — required for Stage 7 capture-director and uncertainty tests.
5. **Write the capture protocol** for fixture recording: overlapping views, slow turning, doorway transitions captured, avoid mirrors/windows confusion, cover corners. Store in `docs/capture-protocol.md`.
6. **Configure processing-job state machine** constants (job states from §8.4 Stage 1: `uploaded, queued, extracting_frames, estimating_camera_poses, reconstructing, compressing, building_scene_index, ready, failed`) in `packages/shared-types`.
7. **Database & storage bootstrap:** PostgreSQL (persistent metadata) + object storage (videos, frames, reconstruction assets, manifests, scene graph records, processing logs). Store connection details in server-side env only.

### Deliverables

- Monorepo skeleton that builds/runs (`apps/web` renders a placeholder page).
- `docs/model-api-notes.md` with verified access results.
- Adapter package compiling with stubs.
- Two recorded fixture videos in `fixtures/demo-scene/`.
- `docs/capture-protocol.md`.

### Acceptance Criteria

- `npm run dev` in `apps/web` starts the app without errors.
- A test call to each Meta model succeeds (or its unavailability is documented with a fallback plan and the adapter surfaces the failure cleanly).
- Both fixtures exist and meet the capture protocol.

### Exit Gate

All of the above verified. **Do not proceed while Meta model access is unverified — this is Risk 6.**

---

## Stage 1 — Prove the 3D Pipeline (Reconstruction)

Priority: P0 · Feature 3 of the PRD · Blocks: everything downstream

### Goals

Establish that a phone recording can become a usable, browser-rendered 3D scene. This phase must be resolved before implementing advanced AI features — if it fails, fix it, do not build around it.

### Preconditions

Stage 0 complete; Fixture A available; a GPU-capable reconstruction environment identified.

### Tasks

1. **Assemble the pipeline stack** (recommended; validate by testing with a real phone video before locking in — different tools have different requirements, output formats, performance, deployment constraints):
   - FFmpeg (video processing)
   - COLMAP (camera-pose estimation / structure-from-motion)
   - Nerfstudio Gaussian-splatting workflow, or a compatible compatible 3D Gaussian Splatting implementation
   - GPU-backed worker infrastructure (do not assume the dev laptop is sufficient — Risk 1)
   - A Gaussian-splat browser viewer
2. **Implement the reconstruction pipeline, Stage 2 — Extract frames:** FFmpeg extraction at a configurable rate; initial sampling strategy considers video duration, camera movement, and the reconstruction engine's recommendations. Do NOT pick one frame every several seconds without checking view overlap (PRD §8.4 warning).
3. **Implement Stage 3 — Estimate camera poses:** COLMAP SfM over overlapping images. If the recording lacks sufficient visual overlap or stable visual features, detect and report the failure — never silently continue.
4. **Implement Stage 4 — Reconstruct the scene:** pass processed images + camera info to the Gaussian-splatting pipeline; worker produces the trained scene representation.
5. **Implement Stage 6 — Compress and publish:** convert to a browser-delivery format where supported; store asset in object storage; **generate a scene manifest** containing:
   - Scene identifier
   - Asset location
   - Reconstruction metadata
   - Coordinate-system information
   - Available navigation positions
   - Scene-index status
   - Processing diagnostics
6. **Implement Stage 5 — Validate the result:** reconstruction completed, output non-empty, asset loadable, renderer displays it, sufficient visual coverage for the demo, camera transforms available or establishable for the viewer.
7. **Implement Stage 7 — Load into the browser:** frontend retrieves manifest, loads the visual representation; user can rotate, zoom, and move between supported viewpoints.
8. **Preserve reconstruction diagnostics** as data (see §11.11 of PRD / Feature 2): whether camera poses were estimated, how many frames were registered, whether substantial portions of the recording were rejected, whether camera coverage is concentrated in one area, whether the reconstruction has large gaps or unstable regions. Store in the processing job record — Stage 7 consumes this.
9. **Implement job state machine** with every transition recorded (states listed in Stage 0 Task 6).
10. **Command-line / worker entry points** implementing the full path:
    `Phone video → frame extraction → camera-pose estimation → 3D Gaussian Splatting reconstruction → compressed scene asset → browser renderer`

### Key design constraint from the PRD (§8.5): viewing versus walking

The MVP supports reliable movement between reconstructed viewpoints, NOT unrestricted game-like walking:
- Orbit and look controls
- A set of supported camera positions
- Camera transitions between selected viewpoints
- Navigation through identified room locations
- Precomputed camera paths
- (Later: mesh-based collision representation and advanced free navigation)

Remember: Gaussian Splatting does NOT guarantee a watertight mesh, real-world dimensions, collision detection, reliable free walking, complete visibility of occluded surfaces, or physically accurate objects (§8.3). These limitations must shape navigation and measurement design.

### Deliverables

- `services/reconstruction/` with `ingest.py`, `extract_frames.py`, `reconstruct.py`, `validate.py`, `export.py` (per §11.13).
- A browser-viewable Gaussian-splat asset from **Fixture A**.
- Scene manifest v1.
- Reconstruction diagnostics record for the fixture.
- Documented reproduction steps (input footage + processing steps).

### Acceptance Criteria (PRD §8.6)

- [ ] **At least one real phone recording produces a usable 3D reconstruction.**
- [ ] The resulting scene can be loaded by the web application.
- [ ] The user can inspect the environment from multiple viewpoints.
- [ ] Navigation does not rely exclusively on a prerecorded video (user can move the camera).
- [ ] Reconstruction failure is surfaced clearly (deliberately test failure with a degenerate/low-overlap video).
- [ ] The team can reproduce the demonstration from documented input footage and processing steps.

### Exit Gate

**A real recorded environment is visible and navigable in the browser.** If this phase fails, resolve before Stage 2+.

---

## Stage 2 — Video Capture & Upload (Web App)

Priority: P0 · Feature 1 of the PRD

### Goals

Users upload an ordinary phone video; the app prepares it for analysis and reconstruction with clear status feedback.

### Preconditions

Stage 1 reconstruction pipeline exists; object storage + PostgreSQL ready.

### Tasks

1. **Capture page** with upload/record controls, capture instructions (link §11.7.2), video preview, processing status, capture-quality warnings area, supplemental-recording workflow area.
2. **User flow** (implement exactly, PRD §6.2):
   1. User opens capture page →
   2. selects or records a video →
   3. app validates file →
   4. app extracts representative frames for initial inspection →
   5. app displays preview →
   6. creator submits →
   7. system creates a scene-processing job →
   8. user sees processing progress.
3. **Supported inputs (MVP):** MP4; MOV subject to browser/backend support; common smartphone resolutions; short indoor recordings. Recommended target: ~30–120 s, one connected indoor space; enforce max duration and upload size via configuration. Do not assume duration alone determines sufficiency.
4. **Frontend preprocessing (browser-side, PRD §6.4):**
   - Read video metadata; display duration and resolution
   - Generate a preview
   - Extract low-resolution frames for preliminary analysis
   - Generate a contact sheet
   - Detect obviously repeated frames
   - Identify major scene transitions where possible
   - Compute a checksum for upload integrity
   - **Preserve the original video** — do not reduce the recording to a few AI-analysis frames; photogrammetry/neural reconstruction needs substantial consecutive-view overlap.
5. **Implement the two frame-selection pipelines as separate logic (PRD §6.5):**
   - **Pipeline A — AI analysis frames:** representative frames covering different viewpoints, room areas, major objects, doors/transitions, potentially obscured regions; suitable for visual inspection, object detection, scene metadata.
   - **Pipeline B — reconstruction frames:** preserve visual overlap and camera-movement info; the reconstruction engine performs its own sampling and quality checks.
   - Pipelines may share extracted frames but must not share an overly aggressive filtering policy. Removing too many frames damages reconstruction quality.
6. **API endpoints** (from §11.5): `POST /api/scenes`, `POST /api/scenes/:sceneId/upload` (use a **signed upload URL** for larger files rather than routing video through a serverless function), `POST /api/scenes/:sceneId/process`, `GET /api/jobs/:jobId`.
7. **Progress reporting:** progress values must come from actual job stages or measured progress — never a fabricated timer (§23.4).
8. **Persistence:** SourceVideo, ProcessingJob, Scene records per data model (§11.4).

### Deliverables

- Capture page UI, upload + processing APIs, processing status UI, ffmpeg/worker handoff.

### Acceptance Criteria (PRD §6.6)

- [ ] Users can upload a valid video.
- [ ] Invalid formats and oversized uploads produce clear errors.
- [ ] Processing jobs survive page refreshes.
- [ ] The user can see whether processing is queued, running, failed, or complete.
- [ ] The original recording is not silently discarded before reconstruction completes.

### Exit Gate

End-to-end: fixture video uploaded → processing job runs the Stage 1 pipeline → scene goes `ready` → manifest retrievable. Status visible on a refreshed page.

---

## Stage 3 — Scene Index & Spatial Understanding

Priority: P0 · Feature 4 of the PRD

### Goals

A realistic 3D image is not enough — the AI needs a structured representation: identified objects, visual evidence, and supported spatial relationships.

### Preconditions

Frames from Pipeline A; reconstruction metadata + camera poses from Stage 1; SAM 3.1 and Muse Spark adapters from Stage 0 (now implemented for real).

### Tasks

1. **Scene-index service** (`services/scene-index/`): object records, region records, spatial relationships, camera viewpoints, evidence references, coverage metadata, navigation targets.
2. **SAM 3.1 integration (detection & segmentation)** per PRD §9.2/§20.2:
   - Role: identify and segment relevant visible objects. Example requests: find doors; identify chairs; segment tables; track an object across frames; identify windows; locate category matches.
   - Workflow: select representative frames → submit frames + prompts → retrieve supported detections/masks/tracking → associate with original frame & timestamp → associate repeated detections across frames where possible → store in the scene index → link each result to its visual evidence.
   - **Critical limitation:** SAM 3.1 provides NO complete 3D scene graph. A mask says where an object appears in an image — it does not establish precise 3D coordinates. Combine detections with camera info and reconstructed geometry before assigning spatial positions; if reliable projection is unavailable, the object remains a *visually identified object with uncertain spatial placement*.
   - Image-space results must never be treated as automatically-registered 3D geometry.
3. **Muse Spark integration (scene interpreter)** per PRD §9.3/§20.1:
   - Role: analyze representative frames; produce structured descriptions; identify likely room functions; interpret visibly clear relationships; describe navigation targets; explain supporting evidence; determine which tools to call (tool execution built in Stage 5).
   - Use a fixed output schema. Validate all model-generated JSON. Require evidence references for observations. **Reject references to nonexistent frame identifiers.** Separate direct observations from inferred room descriptions. Never treat model-generated coordinates as authoritative geometry.
   - Confidence values must come from the actual detection/inference process — never fabricated numbers attached to model prose.
4. **Spatial registration** (`registration.py`, PRD §9.4):
   - Candidate techniques: camera-pose-aware projection, image feature matching, geometric correspondence, point-cloud association, multi-view triangulation, manual correction in the scene editor. (MVP does not need all; select what works.)
   - Mandatory distinction between detected and registered; store e.g.:
     ```json
     {
       "id": "object_42",
       "label": "chair",
       "visual_detection": { "status": "detected", "source_frames": [18, 21] },
       "spatial_registration": { "status": "approximate", "position": null }
     }
     ```
   - When registered, add position + **coordinate provenance**.
5. **Scene-graph construction** (PRD §10.6 — the graph itself is deepened in Stage 4; build creation pipeline here):
   1. Extract/analyze video frames →
   2. Identify visible objects and potential regions →
   3. Obtain camera poses and reconstruction metadata →
   4. Associate observations across frames →
   5. Create entities →
   6. Establish supported relationships →
   7. Validate relationships against geometric information where available →
   8. Store the graph →
   9. Make it available to the AI tool layer.
6. **Fallback behavior:** if segmentation fails, the scene remains explorable; indicate semantic indexing is incomplete rather than failing the whole reconstruction (§20.2).
7. **Evidence-retrieval endpoint:** `GET /api/scenes/:sceneId/entities/:entityId/evidence` returning supporting frames, registration status, relevant metadata (§23.7).

### Deliverables

- Scene-index service, SAM 3.1 + Muse Spark integrations, registration module, entity persistence (SceneEntity records), evidence endpoint.

### Acceptance Criteria (PRD §9.5 + §10.8 partial)

- [ ] The system identifies objects in the uploaded recording.
- [ ] Objects have stable identifiers within the scene index.
- [ ] Detections retain their source-frame references.
- [ ] The application distinguishes image-space detection from 3D registration.
- [ ] The AI can answer basic questions about the scene using the indexed evidence.
- [ ] The system can retrieve objects and regions by label.
- [ ] Unknown or unverified relationships are not treated as confirmed facts.

### Exit Gate

The application can retrieve objects and locations from structured scene data for Fixture A (e.g., the table, a door, regions).

---

## Stage 4 — Structured Scene Graph

Priority: P0 for basic graph; P1 for advanced geometry · Feature 5 of the PRD

### Goals

The formal graph that lets Pixa move beyond generic image QA: known entities + relationships + provenance. This is NOT the Gaussian-splat representation — a separate data structure describing what the system *knows*.

### Preconditions

Stage 3 scene-index data.

### Tasks

1. **Entity types (MVP must support):** `environment, region, landmark, object, doorway, viewpoint, route` (extensible later).
2. **Relationship types (support at minimum):** `contains, connects_to, near, inside, visible_from, adjacent_to, occluded_by`.
   - Every relationship has a provenance/confidence status (e.g., `identified / inferred / verified / unknown`). Example: `contains` from a manually verified region assignment vs. `near` from approximate geometry.
3. **Graph schema** per §10.5 example record, extended in production with: versioning, coordinate systems, spatial-registration status, validated evidence references:
   ```json
   {
     "sceneId": "scene_001",
     "entities": [
       { "id": "region_main", "type": "region", "label": "Main Area",
         "status": "identified", "evidence": { "frames": [12, 13, 18] } },
       { "id": "object_table_01", "type": "object", "label": "Table",
         "status": "identified", "evidence": { "frames": [18, 19] } }
     ],
     "relationships": [
       { "source": "region_main", "target": "object_table_01",
         "type": "contains", "status": "inferred" }
     ]
   }
   ```
4. **Example-graph capability check:** the graph must be able to answer questions about known relationships and provide targets for navigation, mirroring the workspace example in §10.2:
   Environment → Entrance (connects to Main Area) → Main Area contains Table / Chair A / Chair B, connects to Corridor → Corridor contains Door B.
5. **Graph versioning:** scene record field `sceneGraphVersion` (§11.4).
6. **Manual correction (MVP-minimum per §10.7):** a simple scene-inspection panel with ability to correct labels. Roadmaped panel actions: rename a room/region, correct an object label, remove a false detection, confirm a doorway, adjust object location, mark a region as unknown.
7. **Route support:** create route entities between connected regions when connections + viewpoints support it (this powers Stage 5 `showRoute`).

### Deliverables

- Graph storage + schema package (`packages/scene-schema/`), graph module (`graph.py`), correction UI panel (basic), route/relationship data.

### Acceptance Criteria (PRD §10.8)

- [ ] Every navigable destination has a stable identifier.
- [ ] The system can retrieve objects and regions by label.
- [ ] Relationships are represented explicitly, NOT re-inferred from free-form text on every interaction.
- [ ] Unknown or unverified relationships are not treated as confirmed facts.

### Exit Gate

Querying the graph for Fixture A yields labeled regions, objects with evidence, at least one relationship, and ≥3 navigation-ready viewpoints/entities.

---

## Stage 5 — Natural-Language Scene Actions

Priority: P0 · Features 6 (Interactive Navigation) and part of 7 — the core of the product

### Goals

Control the reconstructed environment through natural language. This is central, not an optional chatbot.

### Preconditions

Stages 2–4; renderer with camera-control API (Stage 1); Muse Spark adapter.

### Tasks

1. **Implement the initial tool layer:**

   | Tool | Behavior | Example |
   |---|---|---|
   | `navigateToLocation` | Moves camera to a known location / supported viewpoint | “Take me to the entrance.” |
   | `focusOnObject` | Moves/rotates camera to focus on an identified object | “Show me the table.” |
   | `highlightObjects` | Highlights one or more identified objects | “Highlight every chair.” |
   | `showRoute` | Displays a route between two known destinations **if a valid route can be established** | “Show me the route from the entrance to the main area.” |
   | `inspectLocation` | Returns available scene evidence for a region or object | “What is beside the entrance?” |
   | `compareLocations` | Lets the user inspect two supported locations | “Show me the two corners of this workspace.” |

2. **Tool-calling architecture (PRD §11.3) — the language model must never manipulate the renderer directly:**
   1. User submits voice/text request →
   2. Converted to text if necessary →
   3. Muse Spark interprets the request →
   4. Model selects a supported tool →
   5. Backend **validates** the action and arguments →
   6. Tool resolves the target against the scene index →
   7. Application executes the action →
   8. Frontend reports success or failure →
   9. Assistant provides a concise explanation (based on actual execution results).
3. **Tool exposure to Muse Spark** (§20.1): provide the model with request + concise scene summary + retrieved scene entities + evidence references + tool definitions + recent conversation context. Model returns natural-language response, structured tool call, clarification request, or an explicit insufficiency statement.
4. **Security boundary:** Muse Spark never gets unrestricted access to DB, filesystem, or rendering internals; it requests predefined actions; the app validates and executes only supported operations (§20.1).
5. **Context resolution:** follow-up references (“show me the table” → “what is beside **it**?”) resolve to the previously selected entity; context is scoped to the active scene + session; never reuse object identifiers from another environment (§12.6).
6. **Evidence-fallback for highlighting:** if no registered 3D positions exist, show evidence thumbnails or available image-space detections. **Never invent spatial locations to make the feature appear to work** (§11.3).
7. **Action execution contract** — every action returns a structured result (§11.4):
   ```json
   { "action": "navigateToLocation", "status": "success",
     "targetId": "region_main", "executed": true }
   ```
   Failure:
   ```json
   { "action": "navigateToLocation", "status": "not_found",
     "targetId": null, "executed": false,
     "message": "The requested location is not identified in this scene." }
   ```
   The model explains the actual result from the execution layer.
8. **Navigation implementation (MVP, §11.5):** supported camera positions + transitions — initial viewpoint, entrance, main room, corridor, identified-object viewpoints. Manually configured for the first demonstration, then progressively generated from camera poses and scene geometry. Navigation uses the renderer's actual camera-control API; **not** a text message claiming the camera moved.
9. **Query pipeline:** `POST /api/scenes/:sceneId/query` per §23.6; persist SceneAction records (requested arguments + executionResult) to distinguish what the AI requested from what actually executed.
10. **Interaction-status UI (§25.4):** show when an action is being interpreted / executed / completed (e.g., “Finding the entrance…”, “Moving to the entrance…”, “Entrance found.”); failures explain why.

### Deliverables

- Six tools implemented + validated, assistant chat panel wired to query pipeline, camera navigation + highlight rendering in `components/scene-viewer`, SceneAction persistence, action-history UI (right panel).

### Acceptance Criteria (PRD §11.6)

- [ ] The user can navigate to at least three identifiable locations in the demonstration scene.
- [ ] The user can highlight identified objects.
- [ ] The user can ask a question that triggers a scene action.
- [ ] Tool execution is validated and reported.
- [ ] **The assistant never claims an action succeeded when the renderer did not execute it.**

### Exit Gate

A natural-language request causes a visible action in the reconstructed environment; a nonexistent target produces the structured `not_found` behavior end-to-end.

---

## Stage 6 — Voice & Conversational Interaction

Priority: P0 · Feature 7 of the PRD

### Goals

Users speak to the scene rather than learn menus; spoken requests trigger the same action pipeline as typed ones.

### Preconditions

Stage 5 working; Muse Voice Transcribe adapter.

### Tasks

1. **Input modes:** text input, **push-to-talk** voice input (prefer over always-on: easier to implement, debug, explain), visible transcripts, text responses, optional spoken responses.
2. **Muse Voice Transcribe integration** (§12.3/§20.3): role = convert speech to text. Confirm capabilities/API contract against current docs during Stage 0. Follow documented audio format, upload size limits, supported languages, response schema.
3. **Integration flow (implement exactly):**
   1. Browser requests microphone permission →
   2. User presses the microphone button →
   3. App captures audio →
   4. Audio submitted via supported transcription API →
   5. Transcript received →
   6. Transcript displayed **for correction** →
   7. Text enters the existing conversational tool-calling pipeline (same pipeline as typed input; the voice subsystem must NOT implement a separate/inconsistent set of scene actions).
4. **Spoken responses (secondary, §12.5/§20.3):** if a Meta speech-generation API is available, integrate via a dedicated speech-output adapter. Otherwise use browser speech synthesis where supported. Architecture must not assume transcription implies generation.
5. **Fallback (§20.3):** if transcription fails or is unavailable, allow the user to type the same instruction manually; degrade gracefully.

### Deliverables

- Push-to-talk control, transcription flow, transcript display + correction, typed fallback, optional TTS adapter.

### Acceptance Criteria (PRD §12.7)

- [ ] Voice input can trigger the same actions as text input.
- [ ] The transcript is visible.
- [ ] Users can correct transcription errors.
- [ ] Follow-up requests can refer to a previously selected object.
- [ ] Voice functionality degrades gracefully if a speech service is unavailable.

### Exit Gate

**A spoken request successfully navigates or highlights an object** (PRD Phase 4 exit criterion).

---

## Stage 7 — Evidence Grounding, Capture Director & Uncertainty

Priority: P0 · Features 2 (AI Capture Director) and 8 (Evidence-Grounded Answers); the trust layer

### Goals

Make capture better through AI guidance, and make every answer traceable to evidence with an operating distinction between observed / established / inferred / unknown.

---

### Part A — AI Capture Director (Feature 2)

**P0 for basic implementation; P1 for advanced guidance.** One of the strongest differentiation opportunities (PRD §7).

Most users cannot capture reconstructable footage: they turn too quickly, lack overlap, skip objects, miss room corners, record through windows/mirrors confusingly, skip transitions between connected areas, leave environments occluded. Pixa must help *produce* footage that reconstructs well.

#### Tasks

1. **MVP is post-capture analysis (not real-time; live capture is explicitly out of scope for the hackathon, §7.4).**
2. **Step 1 — Sample frames:** extract a sequence across the recording using Pipeline A.
3. **Step 2 — Inspect the video:** use SAM 3.1 to identify/track relevant categories across frames (doors, furniture, equipment, room openings, major obstacles, repeated architectural features); use Muse Spark to interpret representative images and summarize the visible environment. **Guidance must be supported by frame analysis, reconstruction diagnostics, or explicit uncertainty in the observed scene — NOT issued merely because an LLM imagines coverage is missing.**
4. **Step 3 — Evaluate reconstruction diagnostics:** read what the Stage 1 worker stored: whether poses were estimated, frames registered count, rejected portions, one-area camera concentration, reconstruction gaps/instability. Use actual diagnostics wherever available. (Object detection alone does not establish that the scene is geometrically reconstructable.)
5. **Step 4 — Produce a structured capture report:**
   - Identified coverage gaps
   - Relevant timestamps
   - Suggested additional viewpoints
   - Evidence for each recommendation
   - Confidence of each recommendation
6. **Step 5 — Supplemental footage loop:** creator records missing views; system processes supplemental footage; incorporates into reconstruction **if the engine supports merging**. If the pipeline cannot safely merge, offer a **documented rebuild/recapture workflow** rather than pretending footage was merged (§7.3 Step 5).
7. Example guidance produced by the system: “Move more slowly while turning,” “The left side of the room is poorly represented,” “Walk closer to the doorway and capture the transition,” “Record the area behind the table from another angle,” “Not enough overlapping views of this section.”

#### Acceptance Criteria (PRD §7.5)

- [ ] The system identifies at least one meaningful capture-quality issue in **Fixture B** (deliberately incomplete recording).
- [ ] Every recommendation references an actual observation or reconstruction diagnostic.
- [ ] The user can provide supplemental footage (or a documented rebuild workflow).
- [ ] The system never claims coverage gaps are resolved unless evidence supports that claim.

---

### Part B — Evidence-Grounded Spatial Answers (Feature 8)

**Problem:** a multimodal LLM may produce plausible descriptions unsupported by the recording (e.g., “behind the closed door is probably another room” — an inference, not evidence).

#### Tasks

1. **Four claim categories, each answer routed to one:**
   - **Observed** — directly supported by captured imagery (“A table is visible in frame 18”).
   - **Geometrically established** — supported by a validated spatial representation, with accuracy/coordinate calibration supporting the stated precision (“estimated distance ≈ 2.4 m”).
   - **Inferred** — reasonable interpretation; the inferential nature must be made clear (“This area may be intended as a workspace”).
   - **Unknown** — evidence does not establish the answer (“The space behind the closed door was not captured, so I cannot determine what is there”).
2. **Evidence record** — claims traceable to sources:
   ```json
   {
     "claim": "A chair is visible beside the table.",
     "claimType": "observed",
     "evidence": { "frameIds": [18, 19], "objectIds": ["chair_02", "table_01"] },
     "spatialConfidence": "unverified"
   }
   ```
   (Deliberately distinguishes visual evidence from validated geometry.)
3. **Answer-generation process (§13.4):** receive question → determine relevant entities/spatial facts → retrieve evidence → determine whether the question needs visual, geometric, or inferential evidence → check availability → generate from evidence → include a limitation when incomplete.
4. **Measurements rule (§13.5):** with calibrated geometry → estimated measurement + known uncertainty. Visual-only reconstruction → “I can show you the doorway, but this reconstruction does not have sufficiently reliable scale information to give you an accurate width.”
5. **Coverage & uncertainty map UI — basic P1 level included here (Feature 16 / PRD §16):**
   - Coverage panel categories: `Well observed / Partially observed / Occluded / Not captured / Reconstruction quality uncertain`.
   - Derived ONLY from actual processing diagnostics, view coverage, visibility analysis, or validated manual annotations — never a general-purpose model's prose.
   - User can view warnings, inspect(frames) supporting an observation, identify incomplete regions, request additional capture, understand why a question can't be answered.
   - **Distinguish an unobserved region from a region observed but not reliably reconstructable.**
   - Acceptance: display at least one real coverage/uncertainty indicator linked to supporting evidence or diagnostics.

---

### Part B Acceptance Criteria (PRD §13.6)

- [ ] The system does not fabricate measurements.
- [ ] Questions about unseen regions produce explicit uncertainty.
- [ ] The assistant distinguishes observation from inference.
- [ ] Answers can reference identified scene entities.
- [ ] The application never presents an LLM confidence score as a validated geometric accuracy metric.

### Exit Gate

The system identifies at least one real capture issue (Fixture B) AND avoids making unsupported claims about an unseen region (deliberate uncaptured-region question returns “unknown” with the limitation stated) — PRD Phase 5 exit criterion.

---

## Stage 8 — P1 Features

Priority: P1 for all unless noted · Build only when the Stage 1–7 core loop works reliably.

### 8A — Spatial Measurement and Geometry (Feature 9, P1)

Objective: approximate dimensions, clearances, spatial relationships (“How far apart are these two points?” “Is this passage wide enough for a wheelchair?” “Could a table of this size fit here?” “Approximate distance between these objects?”).

Requirements:
1. A usable geometric representation
2. A consistent coordinate system
3. Reliable correspondence between selected objects and geometry
4. A method for establishing real-world scale
5. A mechanism for reporting measurement uncertainty

**Metric scale rule (§14.3):** SfM geometry often has unknown absolute scale — never assume an arbitrary reconstructed unit equals one metre. Establish scale via a reliable reference measurement or suitable sensor-based method. If scale is unavailable, report relative distances in reconstruction units (where meaningful) but NEVER label them real-world measurements.

**Navigation geometry (§14.4, later version):** simplified traversable-space representation via mesh reconstruction, floor-plane estimation, occupancy mapping, point-cloud processing, manually corrected floor regions, or semantic floor/obstacle segmentation — supports path planning and collision checks. **A Gaussian-splat render alone must not be treated as a reliable collision mesh.**

Acceptance: demonstrate only if sufficiently reliable geometry exists; never claim validated accessibility/safety measurements from visual appearance alone (§14.5).

### 8B — Personalised Exploration (Feature 15, P1)

Objective: goal-driven guided tours instead of requiring users to know what to ask. Example: “I need somewhere quiet to work with enough room for a desk.”

Process: extract goals → map goals to supported scene attributes → retrieve relevant objects/regions → determine which attributes are observable → generate exploration plan → clarify important missing requirements → navigate through selected locations → explain evidence and uncertainty per recommendation.

**Limitation (§15.3):** a silent phone video cannot establish noise levels; visual indicators ≠ verified claims (“must not claim the space is quiet unless acoustic evidence exists”); apparent floor space ≠ guaranteed furniture fit.

Acceptance (§15.4):
- [ ] Users describe a goal in natural language.
- [ ] System generates an ordered exploration plan referencing actual scene entities.
- [ ] Unsupported requirements explicitly identified.
- [ ] System navigates between at least two locations in the plan.

### 8C — Scene Coverage & Uncertainty Map — full version (Feature 16, P1)

Completed in Stage 7 Part B at basic level. Full version: complete panel interactions, coverage-derived warnings throughout the UI.

### 8D — Shareable Interactive Environments (Feature 18, P1)

Objective: share via link; recipients explore in a browser without installing 3D software.

Functionality: unique scene URLs; public/private scene settings; scene loading states; shareable starting viewpoints; optional starting camera position; optional introductory instructions; basic access controls.

Future applications (document the platform extensibility, don't hard-code any vertical into the scene model): remote facility inspection, virtual cultural exhibits, product showrooms, workspace documentation, training environments, remote spatial collaboration.

### 8E — Virtual Furnishing & Layout Simulation (Feature 17, **P2** — build last)

Objective: experiment with changes (“Show me what this room might look like with a desk beside the window.”).

Approach — explicit visualization layer, never a modification of the captured environment: simple 3D-object catalogue, placement interface, approximate floor-plane geometry, object scaling/rotation, collision and clearance checks where reliable geometry exists, optional image generation for concepts.

**Muse Image role (§17.3):** concept imagery / visual edits only, subject to current API modes. Not the authoritative geometry engine. A generated image does NOT establish that furniture fits the room.

**Required distinction:** interface must distinguish (a) original captured environment, (b) added virtual objects, (c) AI-generated concept imagery. Original reconstruction stays available for comparison. Generated images labelled as generated; never replace the reconstruction as evidence.

Acceptance: users can add at least one virtual object, move it, remove it — without changing the original captured asset.

### Stage 8 Exit Gate

Implemented P1 items each meet their acceptance criteria; P2 item optionally delivered.

---

## Reference: Cross-Stage Specifications

These specifications constrain every build stage above. Where stage tasks conflict, stage tasks win; these are the standing architecture.

### 11.1 Technical Architecture (PRD §19)

Six subsystems:

| Subsystem | Responsibilities | Stack |
|---|---|---|
| **A. Web client** | Uploading video, processing status, 3D rendering, voice/text input, AI responses, scene navigation, evidence/uncertainty display | Next.js, TypeScript, React, Tailwind CSS, Three.js, compatible Gaussian-splat renderer |
| **B. Application backend** | Auth, scene metadata, upload coordination, processing jobs, AI orchestration, scene queries, tool validation, access control, audit logs | Node.js, TypeScript, Next.js route handlers or dedicated API service, PostgreSQL (persistent metadata), object storage |
| **C. AI orchestration layer** | Calling Meta models, validating structured responses, retrieving scene evidence, managing tool calls, NL → executable actions, enforcing grounding/uncertainty rules | Node/TS packages (`packages/model-adapters`, `lib/`) |
| **D. Reconstruction worker** | Video processing, frame extraction, camera-pose estimation, 3D reconstruction, asset validation/compression, diagnostics | Python, FFmpeg, COLMAP, Nerfstudio or tested GS pipeline, GPU-backed worker |
| **E. Scene-index service** | Object/region records, relationships, viewpoints, evidence references, coverage metadata, navigation targets | Python/TS services in `services/scene-index/` |
| **F. Storage** | Original video, extracted frames, reconstruction assets, scene manifests, scene-graph records, processing logs | Object storage + PostgreSQL |

### 11.2 Model Integration Plan (PRD §20)

One model → one clearly defined task. Never add a model just to count AI components. Small number of coordinated models.

**Muse Spark — reasoning and tool selection.**
- In: user message, scene summary, retrieved entities, evidence refs, tool definitions, recent context.
- Out: NL response / structured tool call / clarification request / explicit insufficiency statement.
- Security boundary: never DB/FS/render access; request-only; app validates.
- Fall back: direct scene controls keep working; show an explicit “AI interpretation unavailable” message (if the model is down, don't take the scene viewer down with it).

**SAM 3.1 — visual detection & segmentation.**
- In: representative frames, category prompts, optional visual prompts, tracking requests.
- Out: detections, masks, tracking ids, frame refs (per API support).
- Downstream: scene-index converts to candidate object records; attempts association with reconstruction; image-space ≠ 3D.
- Fallback: scene still explorable; declare semantic indexing incomplete rather than failing reconstruction.

**Muse Voice Transcribe — speech input.**
- In: recorded audio. Out: transcript (+ metadata if available).
- Transcript enters the same conversational pipeline; voice subsystem defines no separate scene actions.
- Fallback: typed input.

**Muse Image — optional visualization only.**
- Never a core dependency of the reconstruction pipeline. Concept furniture placement, illustrative annotations, before/after visuals, visual explanations. Generated = labelled as generated; never evidence.

**Meta open-weight models:** useful for experimentation/offline inference/special support tasks, but the prototype must not depend on running several large models locally unless demonstrably beneficial. Priority = deliver the core experience reliably.

**API verification checklist (before implementation, §20.6):** access to required models; current endpoint + auth; model identifiers; input limits; formats; tool-calling; rate limits; output schemas; pricing/usage; data use/storage terms. Model config in configuration (not scattered in code); adapters so API changes don't force rewrites.

### 11.3 The 3D Subsystem in Detail (PRD §21)

Most demanding component — treat as a real engineering pipeline, not an AI API call.

- **Visual representation:** Gaussian-splat asset; compressed format compatible with the chosen viewer; frontend must not assume all GS implementations share formats/metadata.
- **Camera representation:** reconstruction estimates camera poses; manifest preserves coordinate-system information needed to use poses safely.
- **Spatial representation:** separate records — regions, objects, landmarks, viewpoints, relationships, navigation targets, evidence refs. This is what lets the AI find meaningful destinations.
- **Optional geometry representation:** mesh/point cloud for approximate collision surfaces, floor-plane estimation, distances, routes, registration. Validate before use in measurements or collision checks.
- **Browser rendering:** camera controls, smooth transitions, object highlighting where supported, labels, navigation markers, loading/error states. Prioritize desktop; test mobile separately (large assets → significant GPU-memory/bandwidth on mobile).
- **Performance strategy:** compress assets; avoid loading every auxiliary file at once; show a loading indicator; handle GPU/WebGL failures; limit initial scene size; progressive loading where supported; keep AI requests out of render frames; never reload the full scene after each tool call.

### 11.4 Data Model (PRD §22)

```
Scene              id, ownerId, name, status, createdAt, sourceVideoId,
                   visualAssetId, manifestId, sceneGraphVersion, visibility,
                   processingError
SourceVideo        id, sceneId, storageKey, duration, width, height,
                   contentType, checksum, uploadedAt
ProcessingJob      id, sceneId, jobType, status, progress, startedAt,
                   completedAt, errorCode, errorMessage
                   (+ reconstruction diagnostics fields for Stage 7)
SceneEntity        id, sceneId, type, label, description, visualStatus,
                   spatialRegistrationStatus, position, evidenceReferences,
                   createdAt, updatedAt
                   (position nullable until a defensible spatial location exists)
SceneRelationship  id, sceneId, sourceEntityId, targetEntityId,
                   relationshipType, status, evidenceReferences
SceneAsset         id, sceneId, assetType, storageKey, format, sizeBytes,
                   coordinateSystem, createdAt
ConversationSession id, sceneId, userId (if applicable), createdAt, lastActiveAt
SceneAction        id, sessionId, actionType, targetEntityId, arguments,
                   status, executionResult, createdAt
                   (distinguishes what the AI requested from what actually executed)
```

### 11.5 API Design (PRD §23) — application API, NOT Meta endpoints

| Endpoint | Behavior |
|---|---|
| `POST /api/scenes` | Create scene record; body `{ "name": "Workspace Capture" }` → `{ "sceneId": ..., "status": "created" }` |
| `POST /api/scenes/:sceneId/upload` | Accept video or initiate direct-to-object-storage upload; signed upload URL for larger files |
| `POST /api/scenes/:sceneId/process` | Create reconstruction job → `{ "jobId": ..., "status": "queued" }` |
| `GET /api/jobs/:jobId` | `{ "jobId": ..., "status": "reconstructing", "progress": 60 }`; progress from actual stages, never a fabricated timer |
| `GET /api/scenes/:sceneId` | Scene manifest + supported capabilities |
| `POST /api/scenes/:sceneId/query` | `{ "message": ..., "sessionId": ... }` → response + executed actions, e.g. `{ "response": "I found two registered chairs in this scene.", "actions": [ { "type": "highlightObjects", "status": "completed", "entityIds": [...] } ] }` (counts come from the actual scene index, never illustrative) |
| `GET /api/scenes/:sceneId/entities/:entityId/evidence` | Supporting frames, registration status, metadata |

### 11.6 End-to-End Request Processing (PRD §24)

Reference trace for: “Take me to the entrance and show me everything near the door.”

1. **Receive input** (voice → Muse Voice Transcribe → text).
2. **Resolve the scene** and conversation session.
3. **Retrieve relevant entities** (entrance, doors, nearby registered objects, supported viewpoints) via scene-index service.
4. **Interpret the request** with Muse Spark (request + scene data + tools).
5. **Validate the action:** does the entrance exist in this scene? Is a supported viewpoint available? Are the nearby objects registered? Can the action be executed?
6. **Execute navigation** (frontend moves camera to the supported entrance viewpoint).
7. **Highlight relevant objects** — only those with valid spatial info; visible-but-unregistered objects presented separately as unregistered observations.
8. **Generate the explanation** from actual execution results + evidence.
9. **Record the result** (SceneAction) — enables error investigation and prevents the conversational layer claiming success on failure.

### 11.7 UI Requirements (PRD §25)

Feel: **a spatial tool, not a chatbot dashboard.**

- **Main scene workspace:**
  - Center: interactive 3D environment
  - Left panel: scene explorer (regions, landmarks, objects)
  - Right panel: conversational assistant + action history
  - Bottom controls: navigation, recentering, supported scene tools
  - Status area: reconstruction status, coverage info, uncertainty indicators
  - Priority on the environment itself; conversation supports the scene, does not dominate it
- **Capture page:** upload/record controls, capture instructions, preview, processing status, capture-quality warnings, supplemental-recording workflow
- **Scene loading sequence:** load manifest → verify visual asset → init renderer → show initial viewpoint → load metadata → enable supported controls → enable AI interaction when dependencies ready
- **Interaction status:** interpreted / executing / completed states shown (§11.6 examples); failures explain why

### 11.8 Visual Style (PRD §25.5)

Premium spatial-computing product: dark restrained interface; large uninterrupted 3D viewport; minimal control chrome; subtle animated transitions; clear object-selection states; legible labels and evidence panels. **No unnecessary gradients, floating cards, or decorative AI graphics.** The environment is the visual center of attention.

### 11.9 Security, Privacy & Data Governance (PRD §26)

Physical environments can contain sensitive information — account for it from the beginning:
- Upload permissions: only authorized users upload/manage private scenes
- Scene access: public sharing explicit; private scenes never public merely because a reconstruction asset has a URL
- Asset delivery: signed URLs or equivalent for private assets
- AI requests: send only the necessary data (an object query must not transmit every frame when a few frames + scene-index records suffice)
- Secrets: Meta + storage credentials server-side only; never in frontend JS
- Deletion: eventual support for deleting source videos, extracted frames, reconstruction assets, scene metadata, conversation records
- Sensitive environments: discourage uploading private spaces without permission; do not market as a secure system for industrial/government facilities

### 11.10 Reliability & Failure Handling (PRD §27)

Each stage fails independently:
- Reconstruction failure (pose estimation/reconstruction): preserve error details; let user retry
- Scene-index failure after successful reconstruction: user can still explore the visual scene
- Model failure (Muse Spark down): scene viewer keeps working
- Voice failure: manual text entry available
- Asset-loading failure: actionable error message
- Invalid tool calls: backend rejects invalid args/missing targets/unsupported actions. **A language model's output is never trusted as an executable command without validation.**

### 11.11 Performance Requirements (PRD §28)

Development targets, not guarantees (actual results depend on asset size, browser, network, GPU, model latency):

| Operation | Target |
|---|---|
| Open application | Usable without a long blank screen |
| Upload progress | Continuous feedback |
| Processing status | Update after meaningful job-state changes |
| Load a completed scene | Under ~10 s on the target demo machine after manifest available |
| Process a text instruction | Response within several seconds (model latency-dependent) |
| Execute a camera action | Visibly executes without reloading the scene |
| Recover from model failure | Manual scene navigation stays available |

### 11.12 Evaluation Metrics & Test Suite (PRD §29)

- **Reconstruction:** % test recordings usable; processing time; % input frames registered; asset size; loading time; # major failures
- **Spatial understanding:** detection quality on a small manually reviewed test set; entity-label correctness; object-to-scene registration correctness; navigation-destination accuracy; # unsupported spatial claims
- **Interaction:** % supported NL requests executed correctly; % successful camera navigations; highlight correctness; tool-call failure rate; % completed actions reported accurately
- **Grounding:** % factual answers evidence-supported; # fabricated measurements; # incorrect claims about unseen regions; uncertainty-reporting accuracy
- **UX:** time from opening scene to first successful interaction; instructions per task; user success on predefined exploration tasks

**Hackathon test suite (run repeatedly after any prompt/scene-index/navigation change):**
1. Navigate to the entrance
2. Find all registered chairs
3. Identify the object beside a known landmark
4. Show the route between two known viewpoints
5. Estimate a measurement **only if** valid scale information exists
6. Explain what is visible in a selected region
7. Identify a deliberately uncaptured or occluded region
8. Answer a question about an unseen area correctly by acknowledging uncertainty

### 11.13 Suggested Project Structure (PRD §31)

```
pixa/
├── apps/web/
│   ├── app/pages: page.tsx, capture/, scenes/, api/
│   ├── components: scene-viewer/, assistant/, capture/, scene-explorer/
│   ├── lib: scene-actions/, api/, validation/
│   └── package.json
├── services/
│   ├── reconstruction/: ingest.py, extract_frames.py, reconstruct.py,
│   │                    validate.py, export.py
│   └── scene-index/:   detections.py, registration.py, graph.py, coverage.py
├── packages/: shared-types/, scene-schema/, model-adapters/
├── fixtures/demo-scene/
├── docs/: architecture.md, demo-script.md
└── README.md
```

May be simplified if a single Next.js app + one reconstruction worker suffice.

### 11.14 Technical Risks & Mitigations (PRD §34) — standing playbook

| # | Risk | Mitigation |
|---|---|---|
| 1 | Reconstruction too slow | Test a short recording early; proven pipeline; async reconstruction on suitable hardware; don't assume the dev laptop suffices |
| 2 | Poor reconstruction quality | Controlled indoor environment; capture protocol; preserve image overlap; inspect the reconstruction before building the rest of the demo around it |
| 3 | Scene looks realistic but can't support navigation | Predefined viewpoints/camera paths first; unrestricted navigation only once a suitable geometric representation exists |
| 4 | Objects can't be mapped into 3D | Separate detection from registration; visual evidence stays available even when 3D placement is uncertain |
| 5 | AI invents spatial information | Retrieve evidence from scene index; require explicit tool execution; validate model output; enforce observed/inferred/unknown |
| 6 | Meta model API access insufficient | Verify access immediately (Stage 0); model-adapter layer; reconstruction independent of model provider |
| 7 | Project too broad | One real environment; a few supported actions; tightly integrated end-to-end workflow |
| 8 | Looks like an ordinary virtual tour | Language controls the environment; structured spatial evidence retrieved; system identifies limitations in its own understanding |

---

## Stage 9 — Polish, Demo & Definition of Done

Priority: P0 (demo-critical polish)

### Tasks

1. **Polish tasks (PRD Phase 6):**
   - Improve the scene-loading experience
   - Add clear processing states
   - Fix navigation edge cases
   - Test the complete workflow from upload to exploration
   - Prepare a short demonstration recording
   - Document the architecture (`docs/architecture.md`)
   - Prepare repository + deployment instructions
2. **Write and rehearse the demo script** (`docs/demo-script.md`) per §14 below.
3. **Run the Stage 11.12 test suite** and record results.

### Stage 9 Exit Gate = Definition of Done (PRD §35)

A reviewer can:
1. Open the application
2. Upload or load a real captured environment
3. See the reconstructed scene in a browser
4. Move around the scene using supported controls
5. Ask a natural-language question
6. Observe the AI execute a relevant scene action
7. Inspect the object or region supporting the answer
8. See an appropriate uncertainty response when evidence is missing

Final application demonstrates the complete pipeline — **not disconnected AI features.**

---

## MVP Definition (PRD §32)

**Must have**
1. Upload a real phone video
2. Process through an actual 3D reconstruction pipeline
3. Load the reconstructed environment in the browser
4. Display a structured scene index
5. Use Meta models for scene understanding and/or conversational control
6. Accept natural-language instructions
7. Execute real camera-navigation actions
8. Highlight at least one correctly identified object
9. Show AI responses grounded in scene data
10. Acknowledge when information is unavailable

**Should have:** voice input; multiple navigation destinations; a capture-quality report; a visible evidence panel; a simple coverage indicator; a shareable scene link.

**Could have:** advanced measurement tools; full mesh-based navigation; live capture guidance; virtual furniture placement; spoken AI responses; multiple environment categories.

> The project is NOT complete merely because the web interface looks polished. The reconstruction and interaction loop must work.

---

## Demonstration Scenario (PRD §33)

Approximately two minutes; tells a clear technical story.

**Scene setup:** a real indoor environment with an entrance, a central area, a table or other recognizable object, several additional objects, ≥2 useful viewpoints — small enough to reconstruct reliably within time and budget.

**Sequence:**
1. **Capture** — show the original phone video; upload it; briefly show processing stages
2. **Reconstruct** — show the resulting 3D environment; move the camera to prove the user is not watching the original video
3. **Explore through language** — “Take me to the entrance.” → camera navigates
4. **Object understanding** — “Show me all the chairs.” → system highlights registered chairs
5. **Spatial context** — “What is beside the table?” → assistant retrieves relevant entities with an evidence-supported answer
6. **Uncertainty** — ask about a deliberately uncaptured area → system explains the recording provides insufficient evidence
7. **Capture intelligence** — show a capture-quality warning or supplemental-capture workflow; explain how the system helps creators improve the environment

**Closing message:** not “the product generates 3D models” — it connects physical capture, spatial understanding, and AI-driven interaction in one workflow.

---

## Product Vision, Principles & Non-Goals (Standing Context)

### Problem

People increasingly need to understand physical spaces without being physically present — inspecting buildings before visiting, workshops, remote museum visits, retail showrooms, facility equipment layouts. Today's options fall short: photographs show isolated viewpoints; videos are passive; 360° tours limit interaction/spatial understanding; 3D tools need special equipment/expertise/manual scene creation; general AI assistants answer about images but never provide a persistent navigable 3D representation. The gap: between *showing* someone what a place looks like and helping them *understand and interact* with it.

### Solution

Pixa turns a phone video into an explorable digital environment. After upload, the user gets a reconstructed 3D scene in a browser, then issues instructions like: “Take me to the kitchen.” · “Show me all the doors.” · “What is beside the entrance?” · “Highlight every fire extinguisher.” · “Show me the route between these two locations.” · “Find a quiet corner where I could put a desk.” · “Can a wheelchair get through this doorway?”

The system interprets, identifies relevant spatial information, executes actions in the scene; provides measurements/routes/relationships where the reconstruction supports them; and **communicates limitation rather than inventing an answer** when information is missing or unreliable.

### Fundamental distinction

Not a property-listing platform, not a 3D modeling app, not a chatbot with a 3D background — **a spatial interaction system**: transforming physical environments into digital spaces AI can help people explore, understand, and interact with. Property tours, showrooms, museums, offices, industrial facilities, and education are all applications of the same underlying technology.

### Thesis

If people can capture a physical environment with a phone and subsequently interact with a reconstructed version through natural language, they can understand and investigate physical spaces more easily than with photographs or passive video. The prototype must demonstrate this with a real reconstructed environment, a real AI interaction loop, and visible actions in the 3D scene.

### Vision

Make physical environments understandable and interactive through AI. No specialized 3D software, advanced modeling skills, or pre-existing digital twin: the user records, Pixa handles reconstruction workflow, spatial organization, and the intelligent exploration interface.

### Primary objective

Build a working end-to-end demonstration of: **Phone video → capture analysis → 3D reconstruction → scene understanding → spatial representation → AI interpretation → executable scene actions.** Every component must contribute to the final experience: a beautiful reconstruction without meaningful interaction is insufficient; a capable assistant that only discusses without controlling the scene is insufficient; the product brings the two together.

### Secondary objectives

1. Capture accessible to non-technical users
2. Meta AI models used for meaningful perception, reasoning, interaction
3. Realistic browser-accessible 3D experience
4. AI answers grounded in identifiable scene evidence
5. Uncertainty and incomplete coverage made visible
6. Support for multiple environment types
7. Architecture extensible to new reconstruction methods and AI models

### Initial users

- **Environment creator (primary):** documents a location (workspace, museum exhibit, facility, showroom, research capture). Needs: ordinary-phone recording, clear capture instructions, sufficiency feedback, no complicated 3D software, shareable interactive scene, correction of obvious label mistakes.
- **Explorer (secondary):** visits someone else's scene via phone/tablet/desktop browser. Needs: quick understanding, mastered-light navigation, natural-language questions, finding objects/areas, spatial relationships, evidence-backed answers, and knowing when something cannot be determined from the capture.

### Core use cases

- **A. Remote exploration:** “Show me the route from the entrance to the main room.” → identify locations, determine whether a supported route exists, animate the camera along it.
- **B. Object discovery:** “Show me all the fire extinguishers.” → identify known instances, highlight, navigate between; never claim the list is exhaustive unless scene coverage supports it.
- **C. Spatial investigation:** “Is there enough room for a dining table here?” → with accurate metric reconstruction, estimate usable floor space and compare to a specified table size; without reliable scale, qualitative assessment only — never a guess presented as verified measurement.
- **D. Guided exploration:** “Show me the entrance, the main room, and the available workspace.” → ordered exploration sequence through those areas.
- **E. Capture correction:** insufficient coverage → targeted request (“Please record the area to the right of the entrance…”); creator submits more footage; capture quality directly improves the environment.

### Long-term direction (documented, not built now)

Interactive remote environments; AI-guided facility inspection; spatial education; remote product exploration; digital documentation of physical locations; assisted navigation & accessibility research; spatial training; visual planning/layout simulation; robotics & embodied AI research. Applications of the shared foundation — physical observations → environments software understands and people explore — not separate immediate products.
