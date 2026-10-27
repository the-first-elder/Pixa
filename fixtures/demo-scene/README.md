# Fixture videos (gitignored — record locally)

| File | Purpose |
|---|---|
| `fixture-A-good.mp4` | Complete capture per `../docs/capture-protocol.md` → Stage 1 reconstruction + all demo tests |
| `fixture-B-incomplete.mp4` | Deliberately incomplete capture → Stage 7 capture-director + uncertainty tests |

Record on a phone (1080p landscape), then run:

```bash
cd ../../services/reconstruction
python -m worker probe fixture-A-good.mp4
```
