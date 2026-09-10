# A05 - fresh baseline comparison

Status: `DONE`

This is the coordinator's review of the retained A03/A04 run. The raw image and ZIP
artifacts remain local because they embed third-party source artwork. Their SHA-256
values, current page state, browser font inventories, and project records are retained
in this run's manifest and JSON metadata.

## Inputs

- Run manifest: `manifest.json`
- Per fixture: `a04-exports/<sample>/editor.png`, `export.png`, `rendered.png`,
  `project.zip`, `project/project.json`, `page-snapshot.json`, and `browser-fonts.json`
- Historical comparison prompts: `../../output-quality-investigation.md`

The retained run used app/worker/corpus heads `4aa4a9f` / `7d70b64` / `ed9b191`.
All six pages completed with no active, failed, or paused jobs. The browser capture
loaded 38 faces per fixture, including Comic Neue. This establishes a current pipeline
baseline; it does not establish that the visual defects have been fixed.

## Issue Matrix

| Fixture | Historical defect | Fresh baseline result | Classification |
| --- | --- | --- | --- |
| `sample177` | Independent illustration labels collapse into shared captions. | Four OCR regions remain for a page that requires six local illustration-label owners plus headings; the lower labels still share a caption line. | Remaining |
| `sample222` | A huge region/plate replaces cover composition. | One OCR region spans nearly the page. `rendered.png` and `export.png` retain the broad white plate and horizontal paragraph over the cover. | Remaining |
| `sample61` | Text bridges distinct dark containers. | Browser and worker outputs retain crowded cross-container text and differ in typesetting. | Remaining |
| `sample99` | A solid plate removes central art; style diverges. | Both outputs cover the central art with a large white plate. Worker and browser sizing/placement substantially diverge. | Remaining |
| `sample93` | A pale plate crosses composition boundaries. | The large pale plate remains. Seven hidden translation elements are present but excluded from active-output counts. | Remaining |
| `sample83` | Page-dominating masks lose left/right ownership. | A cyan plate covers most of the page. Worker and browser typography differs, while both retain the ownership failure. | Remaining |
| All fixtures | Source rotation and style are replaced by defaults. | Exported elements have no non-null rotation. Output continues to use default black Comic Neue rather than local source style. | Remaining |

No reported defect is `fixed` or `not reproduced` in this baseline. The review does
not infer exact root causes from pixels alone: the verified pipeline facts are artifact
presence/hashes, completed jobs, current serialized fields, element visibility, and
browser font inventories. Plate coverage, ownership loss, collisions, and renderer
divergence are reviewed visual findings.

## Scheduling Result

The next dependency-satisfied work is A06: label owners, containers, and fragments
against the exact six source images. Subsequent implementation remains bounded by the
existing M1-M8 dependencies; this report authorizes no direct algorithm change.
