# Model Upgrades

## The core problem with your current model

`juithealien/manga109-segmentation-bubble` is YOLO11n-seg, **single-class** ("speech bubble" only), fine-tuned on MS92/MangaSegmentation + Manga109, abandoned mid-2025. Notably, `huyvux3005/manga109-segmentation-bubble` (also in your list) is a **byte-for-byte duplicate** of this same model — same metrics, same README, same everything — so that's not an upgrade, just a re-upload.

The single-class design is actually your real limitation, not the YOLO11 backbone: with only "speech bubble" as a class, your pipeline has no way to distinguish balloon-contained dialogue (safe to fully re-render inside the bubble shape) from free-standing text like SFX/narration (which needs different treatment — you generally don't want to blank-and-refill a sound effect the way you would a bubble).

## Recommended replacement: `ShadowB/Manga109-panel-balloon-text-yolov26-segmentation`

This is the best fit in your list, and it's not close:

| | Your current model | ShadowB YOLO26s |
|---|---|---|
| Backbone | YOLO11n-seg | YOLO26s-seg |
| Classes | 1 (bubble only) | 3: `frame`, `text`, `balloon` |
| Params | ~2.7M (nano) | 11.4M |
| Split methodology | not documented | book-level split (train/val/test by title, not by page — avoids the leakage that inflates page-level splits) |
| Box mAP50 / mAP50-95 | 99.1% / 96.7%* | 97.5% / 90.0% |
| Mask mAP50 / mAP50-95 | 99.1% / 94.7%* | 97.0% / 84.6% |
| Checkpoint date | unclear, repo abandoned | 2026-04-29, active project |
| License | Apache-2.0 | MIT (model), see license note below |

*Take the juithealien numbers with a grain of salt — no split methodology is disclosed, and single-class detection metrics are almost always inflated relative to a harder multi-class task like this.

Why the 3-class schema matters for you specifically: `balloon` gives you the region to typeset translated dialogue into (fits your text-fit/inpainting logic), `text` catches free-standing text (SFX, captions) that your pipeline should treat differently, and `frame` gives you panel boundaries for free — useful for reconstructing right-to-left, panel-by-panel reading order before you hand text to the translator for context.

It's also part of an actively maintained project (`CuratorML` on GitHub, per the model card), not a one-off training run.

### Drop-in swap

Your inference code barely changes — same Ultralytics API:

```python
from ultralytics import YOLO

model = YOLO("best.pt")  # swap weights file
results = model.predict(
    source="page.jpg",
    imgsz=1280,          # was 1600 for you; still fine for manga text
    conf=0.25,
    iou=0.7,
    retina_masks=True,   # important: higher-res masks for clean inpainting
)

class_names = {0: "frame", 1: "text", 2: "balloon"}
```

The only real change is your downstream logic needs to branch on `class_id`:

- `balloon` → your existing "detect region, inpaint, place translated text inside" path
- `text` → route to lighter-touch handling (position-anchored overlay, smaller/no-fill rendering) since it's usually SFX or narration boxes, not dialogue
- `frame` → optional, feed into reading-order sorting before your translation worker

One thing to flag: you'll need `ultralytics>=8.4.x` to load YOLO26 checkpoints (`Segment26` head didn't exist before that) — worth pinning in your Python worker's requirements.
