# Capture protocol — record Fixture A + Fixture B

You need ONE real indoor environment with: an entrance, a central area, a table
or other recognizable object, several additional objects, ≥2 useful viewpoints.
Small room, good lighting, uncluttered enough to reconstruct reliably.

## Fixture A — the good capture (30–120 s, 1080p, ≤3 min for KIRI compat)

1. Phone landscape, 1080p30. Clean the lens.
2. Start at the entrance. Pause 2 s.
3. Walk SLOWLY around the room perimeter. Pan SLOWLY — fast turning kills tracking.
4. Keep every surface visible in MANY overlapping frames; never whip-pan.
5. Walk up to the table/main object, orbit it slowly, then step back.
6. Capture each doorway/transition by walking through it slowly, looking both ways.
7. Cover all four corners; tilt up/down to include floor + ceiling edges.
8. End where you started (loop closure helps pose estimation).
9. Avoid: mirrors/windows head-on, featureless white walls filling the frame,
   moving people/pets, flickering screens.

Save as `fixtures/demo-scene/fixture-A-good.mp4` (gitignored — keep local).

## Fixture B — deliberately incomplete (for capture-director + uncertainty tests)

Record the SAME room but deliberately: skip the area behind the table, never
enter/show one corner, and leave one doorway unrecorded. Save as
`fixtures/demo-scene/fixture-B-incomplete.mp4`.

Expected system behavior (Stage 7 tests): coverage gap reported for the missing
areas; questions about the unseen corner/doorway return explicit "unknown".

## Validation

Run the worker's probe before uploading anything:

```bash
cd services/reconstruction
python -m worker probe ../../fixtures/demo-scene/fixture-A-good.mp4
```

It reports duration/resolution/fps, estimated frame counts for both pipelines,
and overlap warnings. Fix capture issues at record time, not in code.
