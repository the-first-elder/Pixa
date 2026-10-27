"""Associate image-space detections with reconstruction geometry (Stage 3).

Techniques (implement what works): camera-pose-aware projection, feature
matching, geometric correspondence, point-cloud association, multi-view
triangulation, manual correction. Unregistered objects keep position=None
with their evidence thumbnails — never fabricated coordinates.
"""
STAGE = 3


def register(_detections, _geometry):
    raise NotImplementedError("Stage 3: spatial registration")
