# Scene-index service

Role (PRD §§ 9–10): object/region records, spatial relationships, camera
viewpoints, evidence references, coverage metadata, navigation targets.

## Modules (Stage 3)

| Module | Role |
|---|---|
| `detections.py` | SAM 3.1 detections → candidate object records (image-space, evidence-linked) |
| `registration.py` | Associate detections with reconstruction geometry → positions + provenance (or `null`) |
| `graph.py` | Entities + relationships + provenance → versioned scene graph |
| `coverage.py` | View coverage + reconstruction diagnostics → coverage/uncertainty map |

## Iron rule

Detection ≠ registration. A mask says where an object appears in an image; it
never becomes a 3D coordinate without geometric correspondence. `position: null`
is preferable to a fabricated coordinate.
