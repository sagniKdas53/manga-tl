# Torii comparison set — 2026-09-06

Captured to settle what Torii actually does, after a handoff document mis-framed the renderer
problems as worker-side text fitting. **Untracked on purpose** (~29MB, adult source material) — do
not `git add` this directory. It backs `docs/canvas_render_fixes_2026-09-06.md`.

This is the "Torii screenshots still to come" that `docs/mask_precision_2026-08-27.md` was waiting
on. That doc opened with the same complaint being made again today — *"our current masks are too
big… they even overlap each other"* — and could not close because there was nothing to compare
against. These files are the comparison.

## Files

| File | What it is |
| :--- | :--- |
| `source-original.png` | The untranslated page, 3541×2508. From our own layers export. |
| `ours-canvas-export.png` | **Our frontend canvas export.** Three flat plates, two carrying no text. Tiny type. This is the surface Sagnik judges output on. |
| `ours-pil-rendered.png` | **Our worker/PIL render of the same data.** One plate (it skips empty text), large type (it has no size cap). Strictly better than the canvas — the divergence is the point. |
| `torii-translated.png` | **Torii's output for the same page.** No flat plates. Dialogue set at 129px as a tall column of short lines over the art, pink fill + 14px white stroke. SFX left in the artwork with romanised text added beside them. |
| `torii-inpainted.jpg` | **Torii's inpainted base.** Proof it *does* erase — but tightly around the glyphs, with real texture-aware inpainting, and it never touches SFX. |
| `ours-project.json` | Our layer/element data for the page. Three translation elements; two have `"text": ""` with `isManuallyEdited: true`. |
| `torii-metadata.json` | Torii's project metadata — the text object model, below. |
| `compare.torii` | The whole Torii project (a zip: `images/N_{original,translated,inpainted}` + `metadata.json`), 6 pages. |
| `torii-editor-ui.png` | Frames from the screen recording showing Torii's Edit-mode text tools. Source video: `~/Videos/vokoscreenNG-2026-09-06_12-09-42.mkv`. |

## Torii's text object model

From `metadata.json` → `images[i].translated._textObjectsTemp[]`:

```json
{
  "x": 3122, "y": 1066, "width": 612, "height": 1435,
  "text": "Isn't\nyour\nasshole\na bit\ntoo\nsmelly,\nSensei?\nJust\nstay\nstill,\nokay?",
  "originalText": "先生のアナルちょっと臭すぎない?ちゃんとまってろ?さ",
  "textAlign": "center",
  "strokeColor": "#fefefe", "lineWidth": 14,
  "fillColor": "#fa366a",
  "font": "129px WildWords",
  "addFontBackground": false, "addFontBorder": false,
  "addBackgroundColor": "#ffffff",
  "rotation": 0, "angle": 0,
  "layout": "h", "textDir": "ltr"
}
```

Four things follow, and they drive the plan:

1. **The wrap and the size are stored data, not a live computation.** `text` carries literal `\n`;
   `font` carries the chosen size. The fitter ran once and the result became editable. Ours re-runs a
   fitter in both renderers on every draw, which is the only reason they can disagree.
2. **`originalText` sits beside it**, which is why Torii can afford to bake breaks into `text`. Our
   `text` is the translated string QA's `direct_fix` rewrites — so we cannot.
3. **The stroke is the mechanism, the background is the exception.** `addFontBackground` and
   `addFontBorder` are `false` on all 74 objects in this file. Readability over artwork comes from
   `strokeColor` + `lineWidth`, not a plate. `lineWidth` tracks size at roughly `fontSize / 9`
   (129→14, 78→12, 36→8, 10→4, 6→2).
4. **The editor exposes exactly this.** The Edit-mode panel has Font, B/I, alignment, text layout
   (h/v), a Font Size slider (Alt+Scroll), Line Spacing, Letter Spacing, and an Appearance row of
   three colours — **Text / Stroke / Box** — with Box carrying two checkboxes, **Fill** and
   **Border**. There is no "fit to area" toggle.

Torii also separates **Translate All** from **Inpaint All** as distinct actions, so inpainting is
opt-in rather than a consequence of translating.

## Measurements taken from these files

**Size cap.** Same page, same element. Our canvas caps the size search at
`min(floor(maxHeight/2), 72)` (`frontend/src/utils/fitText.ts:483`); the worker removed both terms
under D7 (`render.py:799`, `max_start_size = int(max_height)`). Torii sets the comparable object at
**129px**.

**Empty-text plates.** Two of our three translation elements carry `"text": ""` and still paint. The
worker skips them (`if not text: continue`); `Reader.tsx:3624` filters on `!element.visible` only.
`docs/render_quality_gap_2026-08-05.md:366` filed this under D8 and said the guard "should go in
today either way".

**Mask over-expansion.** `cover_balloon_polygon` (`worker/src/worker/handlers/ocr.py:287`) pads by
`COVER_FILL_PAD_FRACTION = 0.18` of the **shorter side** on all four sides, then rounds corners at
`r = 0.22 × short side`. Reproduced exactly against `ours-project.json`:

| element | OCR region | mask bbox | pad | corner radius |
| :--- | :--- | :--- | ---: | ---: |
| 1 | 1798×2445 | 2161×2508 — full page height | 324px | 475px |
| 2 | 408×657 | 481×785 | 73px | 106px |
| 3 | 903×1359 | 1072×1685 | 162px | 236px |

All three come back as **28-point** polygons. The 2px simplifier (`MASK_POLYGON_TOLERANCE_PX`) cannot
reduce them because Douglas–Peucker measures deviation from the retained chord, and a 106px arc
deviates ~31px from its own chord. That is why a rectangle reads as a blob and why reshape mode is
unusable by hand.

## Reproducing

```bash
# Torii text objects, one row per object
unzip -p compare.torii metadata.json | python3 -c "
import json,sys,re
d=json.load(sys.stdin)
for i,im in enumerate(d['images']):
    for o in im['translated'].get('_textObjectsTemp') or []:
        fs=float(re.match(r'([\d.]+)px',o['font']).group(1))
        print(i, o['width'],'x',o['height'], fs, len(o['text'].split('\n')), o['lineWidth'])
"

# our element boxes vs their mask polygons
python3 -c "
import json
d=json.load(open('ours-project.json'))
for L in d['layers']:
    for e in L['elements']:
        mp=e.get('maskPolygon')
        if not mp: continue
        pts=json.loads(mp); xs=[p[0] for p in pts]; ys=[p[1] for p in pts]
        print(e['maxWidth'],'x',e['maxHeight'], '->', max(xs)-min(xs),'x',max(ys)-min(ys), len(pts),'pts')
"
```

Font-dependent numbers must be taken **in the worker container**, not on the laptop —
`fonts-comic-neue` is installed by `worker/Dockerfile:17` and absent here, so `load_font` silently
falls back to DejaVu Sans (36% wider) and local measurements do not match production:

```bash
docker run --rm --entrypoint python -v "$PWD:/w" -w /w -e PYTHONPATH=/w/src \
  ghcr.io/sagnikdas53/manga-tl-worker:latest -c "..."
```
