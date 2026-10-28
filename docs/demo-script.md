# Demo script (2 minutes, verified 2026-10-28 on User scene 4)

Scene: http://localhost:3000/scenes/scene_5abb5015 (150-frame phone capture,
100% registered, 15 entities, 11 positioned, 4 regions).

## Beats

1. **Capture (15 s).** Show the phone video. Upload it on /capture with the
   Fast preset. Processing stages appear live (frames → poses → training).
2. **Reconstruct (15 s).** Open the finished scene. Orbit to prove it is real
   3D, not video. Toggle Splats|Mesh to show both representations.
3. **Explore through language (20 s).** "Take me to the overview." Camera flies.
   Press "Take the tour" for the full fly-through.
4. **Object understanding (20 s).** "Show me the sofa." Blue marker lands on
   the triangulated position; camera centers it.
5. **Detail question (20 s).** "What color is the bed?" Answered from evidence
   frames (dark grey-blue headboard, pink bedding), frame numbers cited.
6. **Uncertainty (20 s).** "What is behind the closed door?" Describes the open
   view from frames, then states UNKNOWN for the unseen space.
7. **Measurement (10 s, needs calibration).** "How tall is the bed?" answers in
   units and asks for one real reference; "the door is 2 meters tall"
   calibrates the scene to meters with uncertainty.

## Fallbacks if live services fail

- Meta API down: scene viewer, orbit/walk/tour keep working; chat shows the
  explicit unavailable message (verified 502 path).
- No fixture: tester scenes in fixtures/demo-scene + docs/capture-protocol.md.
