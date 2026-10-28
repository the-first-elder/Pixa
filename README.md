# Pixa

AI-powered spatial computing: record a physical space on an ordinary phone,
get a reconstructed 3D environment in the browser, and explore it through
natural language — with every answer grounded in scene evidence.

Staged build spec: [`STAGED_PRD.md`](STAGED_PRD.md)

## Layout

```
apps/web/                 Next.js + TypeScript + Tailwind + Three.js + Spark viewer
services/reconstruction/  Python worker: ingest → frames → poses → 3DGS → manifest
services/scene-index/     Python: detections → registration → graph → coverage
packages/shared-types/    TS types shared by web + worker contracts
packages/scene-schema/    Scene manifest + graph schema (versioned)
packages/model-adapters/  Meta Model API clients (spark/sam/voice/image)
fixtures/demo-scene/      Fixture videos (local only, gitignored)
docs/                     Vermified API notes, strategy, protocol, architecture
```

## Quickstart

```bash
cp .env.example .env        # add META_API_KEY (never commit .env)
npm install
npm run dev                 # apps/web on http://localhost:3000

cd services/reconstruction
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m worker probe <video.mp4>
```

## Standing rules

1. Real 3D from real footage — never fake reconstruction.
2. AI actions must visibly execute in the scene.
3. Detection ≠ registration: no 3D position without provenance.
4. Observed / established / inferred / unknown — never invent unseen spaces.
5. Secrets server-side only. Standard (non-contributor) models for private captures.
