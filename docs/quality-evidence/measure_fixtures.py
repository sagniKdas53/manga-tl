"""Local, read-only fixture audit; run using the repository root .venv.

Writes evidence beside this script; never modifies corpus. Geometric coverage is
not a measure of artwork damage. Saved exports are historical, not fresh OCR runs.
"""

import hashlib
import json
import subprocess
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
SAMPLES = (177, 222, 61, 99, 93, 83)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rgb(path):
    with Image.open(path) as im:
        rgba = im.convert('RGBA')
        return Image.alpha_composite(Image.new('RGBA', rgba.size, 'white'), rgba).convert('RGB')


def polygon(element):
    p = element.get('maskPolygon')
    return json.loads(p) if isinstance(p, str) else p


def area(points):
    return abs(sum(a[0] * b[1] - b[0] * a[1]
                   for a, b in zip(points, points[1:] + points[:1]))) / 2


def inspect_sample(number):
    base = ROOT / f'corpus/samples/ja/sample{number}'
    project = json.loads((base / 'project/project.json').read_text())
    meta = json.loads((base / 'meta.json').read_text())
    w, h = (project['dimensions'][key] for key in ('width', 'height'))
    total = w * h
    source_path = base / meta['source']['file']
    source = rgb(source_path)
    data = {'sample': number, 'dimensions': [w, h], 'exported_at': project['exportedAt'],
            'artifact_hashes': {}, 'identity': {}, 'layers': [], 'ocr': [], 'visible_translation': []}
    for path in (source_path, base / 'project/project.json', base / 'project/original.png',
                 base / 'torii/original.png', base / 'ref-torii.png', base / 'render.png', base / 'export.png'):
        if path.exists():
            data['artifact_hashes'][str(path.relative_to(ROOT))] = digest(path)
    for path in (base / 'project/original.png', base / 'torii/original.png'):
        other = rgb(path)
        same_size = other.size == source.size
        same_pixels = same_size and source.tobytes() == other.tobytes()
        # Secondary diagnostic only, explicitly downsampled; not a source-match certificate.
        a = np.asarray(ImageOps.contain(source, (512, 512)), dtype=np.float32)
        b = np.asarray(ImageOps.contain(other, (512, 512)), dtype=np.float32)
        data['identity'][str(path.relative_to(base))] = {
            'dimensions': list(other.size), 'same_pixels_rgb_on_white': same_pixels,
            'mae_rgb_at_max_512': float(np.abs(a - b).mean()) if a.shape == b.shape else None}
    union = Image.new('L', (w, h))
    draw_union = ImageDraw.Draw(union)
    for layer in project['layers']:
        ld = {'id': layer['id'], 'type': layer['type'], 'visible': layer.get('visible', True),
              'element_count': len(layer['elements']), 'elements': []}
        for e in layer['elements']:
            points = polygon(e)
            ed = {'id': e['id'], 'region_id': e.get('regionId'), 'visible': e.get('visible', True),
                  'bbox': [e['x'], e['y'], e['maxWidth'], e['maxHeight']],
                  'bbox_page_pct': e['maxWidth'] * e['maxHeight'] / total * 100,
                  'polygon_page_pct': area(points) / total * 100 if points else None,
                  'polygon_vertices': len(points) if points else 0,
                  'font': e.get('font'), 'weight': e.get('fontWeight'), 'size': e.get('size'),
                  'rotation': e.get('rotation'), 'text_color': e.get('textColor'),
                  'background': e.get('backgroundColor'), 'empty_text': not (e.get('text') or '').strip(),
                  'bbox_outside_page': e['x'] < 0 or e['y'] < 0 or e['x'] + e['maxWidth'] > w or e['y'] + e['maxHeight'] > h}
            ld['elements'].append(ed)
            if layer['type'] == 'ocr':
                data['ocr'].append(ed)
            elif layer['type'] == 'translation' and ld['visible'] and ed['visible']:
                data['visible_translation'].append(ed)
                if points:
                    draw_union.polygon([tuple(p) for p in points], fill=255)
        data['layers'].append(ld)
    visible = data['visible_translation']
    data['summary'] = {
        'ocr_count': len(data['ocr']), 'visible_translation_count': len(visible),
        'max_ocr_bbox_page_pct': max((e['bbox_page_pct'] for e in data['ocr']), default=0),
        'max_visible_polygon_page_pct': max((e['polygon_page_pct'] or 0 for e in visible), default=0),
        'visible_polygon_union_page_pct_raster': float(np.count_nonzero(np.asarray(union))) / total * 100,
        'visible_outside_page_bboxes': sum(e['bbox_outside_page'] for e in visible),
        'visible_empty_text': sum(e['empty_text'] for e in visible),
        'visible_font_counts': dict(Counter(e['font'] for e in visible)),
        'visible_rotation_counts': dict(Counter(str(e['rotation']) for e in visible))}
    # Side-by-side analysis sheet: aspect preserved, labels outside images.
    paths = [source_path, base / 'render.png', base / 'export.png', base / 'ref-torii.png']
    labels = ['Source', 'Saved worker render', 'Saved canvas export', 'Torii baseline']
    cell_w, cell_h = 620, 880
    sheet = Image.new('RGB', (cell_w * 4, cell_h), '#ddd')
    d = ImageDraw.Draw(sheet)
    for i, (path, label) in enumerate(zip(paths, labels)):
        im = ImageOps.contain(rgb(path), (cell_w - 12, cell_h - 40))
        d.text((i * cell_w + 10, 10), f'sample{number}: {label}', fill='black')
        sheet.paste(im, (i * cell_w + (cell_w - im.width) // 2, 34))
    sheet.save(OUT / f'sample{number}-comparison.webp', quality=85)
    return data


def main():
    report = {'measurement_version': 1,
              'notes': ['Historical artifacts only; no fresh OCR or translation run.',
                        'Polygon area uses shoelace; union rasterizes visible translation polygons with Pillow at native resolution.',
                        'Coverage does not quantify artwork damage or glyph recall.',
                        'Source identity compares RGB composited on white; original hashes are retained.'],
              'revisions': {name: subprocess.check_output(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True).strip()
                            for name, path in [('app', ROOT), ('worker', ROOT / 'worker'), ('corpus', ROOT / 'corpus')]},
              'samples': [inspect_sample(n) for n in SAMPLES]}
    (OUT / 'fixture-metrics.json').write_text(json.dumps(report, indent=2) + '\n')
    for sample in report['samples']:
        print(sample['sample'], json.dumps(sample['summary']))
        print('identity', json.dumps(sample['identity']))


if __name__ == '__main__':
    main()
