"""SAM 3.1 detections -> candidate object records (Stage 3).

Input: representative frames + prompts. Output: records with
{label, source_frames, visual_status} and NO 3D position.
"""
STAGE = 3


def detect(_frames, _prompts):
    raise NotImplementedError("Stage 3: SAM 3.1 detection pipeline")
