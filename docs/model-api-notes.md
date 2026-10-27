# Meta Model API — verified access notes

> Verified live 2026-10-27 via `GET /v1/models` (HTTP 200).
> Key is stored ONLY in `.env` (gitignored). Never commit keys, never call from frontend.

## Platform

- **Meta Model API**, docs: https://dev.meta.ai/docs (NOT `api.llama.com`)
- Base URL: `https://api.meta.ai/v1`
- Auth: `Authorization: Bearer $META_API_KEY` (env `MODEL_API_KEY` in Meta docs)
- One key unlocks all hosted models. No per-model grants.

## Verified model IDs (`GET /v1/models`)

`muse-wonder-1.0`, `muse-spark-1.3`, `muse-spark-1.3-contributor`,
`muse-spark-1.2`, `muse-spark-1.2-contributor`, `muse-spark-1.1`,
`muse-voice-transcribe-1.0`, `muse-image-1.0`, `sam-3.1`

## Capability map (WorldLens use → model → endpoint)

| Use | Model | Endpoint | Notes |
|---|---|---|---|
| Reasoning, scene interpretation, tool-calling | `muse-spark-1.3` (Standard) | `POST /v1/responses` (recommended) or `POST /v1/chat/completions` | 1M ctx. Tool-calling + structured output supported. `tool_choice` must be `"auto"` only. Prefer 1.2 for audio input (1.3 audio "may be degraded"). |
| Segmentation / detection / tracking | `sam-3.1` | `POST /v1/responses` only (`stream:true` for video) | ONE noun phrase per request. Returns special-token text (`<0f>0<\|box;…\|><\|mask;…\|>`); parse with `@meta-sam/parser`. Empty output = zero matches (valid). Geometry only — no labels. Video: MP4/MOV H.264/H.265/MPEG-4. |
| Speech → text | `muse-voice-transcribe-1.0` | `POST /v1/asr/transcribe?sessionId=` (multipart: `request` JSON + `audio` WAV) or realtime `wss://api.meta.ai/v1/asr/realtime?sessionId=` | WAV mono 16-bit PCM 16/24 kHz ONLY; ≤32 MB, ≤10 min. Turn-level timestamps + session speaker labels only (no word timestamps, no confidence). Realtime WS auth goes in first JSON frame, NOT header. **No TTS on this platform** → use browser speech synthesis. |
| Concept imagery (optional, never evidence) | `muse-image-1.0` | `POST /v1/responses` (conversational) or `POST /v1/images/generations` / `/v1/images/edits` | Only `image_generation` tool allowed on Responses endpoint. |

## Limits that shape our code

- Images: inline `image_url` ≤50 MB; Files API ≤1 GiB; ≤50 images/request.
- Spark video: `video/mp4` via `input_file`/`file_id` or `input_video.video_url`.
- Files: `POST /v1/files` (`purpose:user_data`); team storage 100 GiB, no expiry by default — set `expires_after` or delete. Uploaded capture frames sent to Meta must be pruned.
- Rate limits per team: Spark/Wonder/SAM 3,000 RPM / 4,000,000 TPM; Contributor Spark 150 RPM; Image 150 RPM; Voice 256 concurrent streams. Handle 429 + `Retry-After`.
- SAM billing: $2.50/1k images; $0.20/1k video frames, min 50 frames/request.
- Spark Standard: $1.25/M in, $4.25/M out. Contributor: $0.10/M in, $0.20/M out — **but content may be used to train future models**. Use Standard for private indoor captures.
- Image: $0.01/image. Voice: $0.18/audio-hour.

## Data governance (applies to PRD §26)

- Standard mode: content NOT used to train Meta models. Contributor mode: may be used.
- Files persist until deleted against shared 100 GiB quota → capture consent + deletion plan required.
- Proxy all calls server-side; one key per app; never frontend.

## PRD corrections adopted

1. Endpoints are `https://api.meta.ai/v1`, not Llama API.
2. SAM takes one concept per request; tracking is 2D frame-following, NOT 3D registration — detected-vs-registered distinction is mandatory.
3. No Meta TTS exists → Stage 6 spoken output = browser TTS.
4. Voice caps (WAV-only, 32 MB/10 min) constrain push-to-talk chunking design.
5. Meta API handles representative frames/clips, not full reconstruction — COLMAP/GS worker stays separate.
