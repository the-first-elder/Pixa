"""View coverage + reconstruction diagnostics -> coverage/uncertainty map (Stage 7).

Categories: well observed / partially observed / occluded / not captured /
reconstruction quality uncertain. Derived ONLY from processing diagnostics,
view coverage, visibility analysis, or validated manual annotations.
Never from a general-purpose model's prose.
"""
STAGE = 7


def coverage_map(_scene_index, _diagnostics):
    raise NotImplementedError("Stage 7: coverage/uncertainty map")
