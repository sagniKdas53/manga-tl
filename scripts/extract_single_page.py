#!/usr/bin/env python3
"""
extract_single_page.py — Extract OCR text regions and reference alignments for a single page
using PaddleOCR with memory efficiency and safe downscaling.
"""

import os
import sys
import json
from PIL import Image
import numpy as np
import paddle

paddle.set_flags({"FLAGS_use_mkldnn": False, "FLAGS_enable_pir_api": False})
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

from paddleocr import PaddleOCR

def process_page(sample_id, page_dir, lang, ocr_lang, out_base="scripts/corpus"):
    src_img_path = None
    for ext in ["jpg", "jpeg", "png", "webp"]:
        cand = os.path.join(page_dir, f"source.{ext}")
        if os.path.exists(cand):
            src_img_path = cand
            break
    if not src_img_path:
        print(f"Error: no source image for {sample_id} in {page_dir}")
        return False
        
    try:
        pil_img = Image.open(src_img_path).convert("RGB")
    except Exception as e:
        print(f"Error reading image {src_img_path}: {e}")
        return False
        
    orig_w, orig_h = pil_img.size
    
    # Safe downscale for OCR if image is extremely high res (>2000px)
    max_dim = max(orig_h, orig_w)
    if max_dim > 2000:
        scale = 2000.0 / max_dim
        scaled_w = int(orig_w * scale)
        scaled_h = int(orig_h * scale)
        pil_ocr = pil_img.resize((scaled_w, scaled_h), Image.Resampling.LANCZOS)
    else:
        pil_ocr = pil_img
        scale = 1.0
        
    img_bgr = np.array(pil_ocr)[:, :, ::-1]
    ocr_h, ocr_w = img_bgr.shape[:2]
    
    # Run OCR on source image with language-appropriate reader
    if lang == "ko" or ocr_lang == "korean":
        reader = PaddleOCR(
            text_detection_model_name="PP-OCRv5_mobile_det",
            text_recognition_model_name="korean_PP-OCRv5_mobile_rec",
            use_textline_orientation=False,
            use_doc_unwarping=False,
            use_doc_orientation_classify=False,
            enable_mkldnn=False,
        )
    else:
        reader = PaddleOCR(
            lang=ocr_lang,
            use_textline_orientation=False,
            use_doc_unwarping=False,
            use_doc_orientation_classify=False,
            enable_mkldnn=False,
        )
        
    res = list(reader.predict(img_bgr))
    lines = []
    if res and len(res) > 0:
        r0 = res[0]
        texts = r0.get("rec_texts", [])
        scores = r0.get("rec_scores", [])
        boxes = r0.get("rec_boxes", [])
        for txt, conf, b in zip(texts, scores, boxes):
            cleaned = txt.strip()
            if not cleaned:
                continue
            ymin = float(b[1]) / ocr_h
            xmin = float(b[0]) / ocr_w
            ymax = float(b[3]) / ocr_h
            xmax = float(b[2]) / ocr_w
            lines.append({
                "text": cleaned,
                "confidence": float(conf),
                "box": [ymin, xmin, ymax, xmax]
            })
            
    # Sort top-to-bottom, RTL
    lines.sort(key=lambda x: (x["box"][0], -x["box"][1]))
    
    regions = []
    for i, line in enumerate(lines):
        regions.append({
            "id": f"r{i+1}",
            "text": line["text"],
            "regionType": "speech",
            "readingOrder": i + 1,
            "box": line["box"],
            "confidence": line["confidence"]
        })
        
    # Check for reference render
    reference_map = {}
    ref_cand = None
    for f in os.listdir(page_dir):
        if f.startswith("ref-") or f in ["ref-human.png", "ref-human.jpg"]:
            ref_cand = os.path.join(page_dir, f)
            break
            
    if ref_cand:
        try:
            ref_pil = Image.open(ref_cand).convert("RGB")
            rw_orig, rh_orig = ref_pil.size
            max_rdim = max(rh_orig, rw_orig)
            if max_rdim > 2000:
                rscale = 2000.0 / max_rdim
                ref_pil = ref_pil.resize((int(rw_orig * rscale), int(rh_orig * rscale)), Image.Resampling.LANCZOS)
            ref_bgr = np.array(ref_pil)[:, :, ::-1]
            rh, rw = ref_bgr.shape[:2]
            
            en_reader = PaddleOCR(
                lang="en",
                use_textline_orientation=False,
                use_doc_unwarping=False,
                use_doc_orientation_classify=False,
                enable_mkldnn=False,
            )
            en_res = list(en_reader.predict(ref_bgr))
            en_lines = []
            if en_res and len(en_res) > 0:
                er0 = en_res[0]
                for txt, conf, b in zip(er0.get("rec_texts", []), er0.get("rec_scores", []), er0.get("rec_boxes", [])):
                    cy = (float(b[1]) + float(b[3])) / (2 * rh)
                    cx = (float(b[0]) + float(b[2])) / (2 * rw)
                    en_lines.append({
                        "text": txt.strip(),
                        "centroid": (cy, cx)
                    })
                    
            for r in regions:
                sc_y = (r["box"][0] + r["box"][2]) / 2
                sc_x = (r["box"][1] + r["box"][3]) / 2
                best_t = None
                best_d = 999
                for el in en_lines:
                    d = (el["centroid"][0] - sc_y)**2 + (el["centroid"][1] - sc_x)**2
                    if d < best_d and d < 0.08:
                        best_d = d
                        best_t = el["text"]
                if best_t:
                    reference_map[r["id"]] = best_t
        except Exception as e:
            print(f"Warning: reference OCR failed for {ref_cand}: {e}")
                    
    p_out = os.path.join(out_base, sample_id)
    os.makedirs(p_out, exist_ok=True)
    
    with open(os.path.join(p_out, "regions.json"), "w", encoding="utf-8") as f:
        json.dump(regions, f, indent=2, ensure_ascii=False)
        
    with open(os.path.join(p_out, "reference.json"), "w", encoding="utf-8") as f:
        json.dump({"reference_translations": reference_map}, f, indent=2, ensure_ascii=False)
        
    with open(os.path.join(p_out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({
            "sample_id": sample_id,
            "source_dir": page_dir,
            "source_file": src_img_path,
            "language": lang,
            "region_count": len(regions),
            "reference_count": len(reference_map)
        }, f, indent=2, ensure_ascii=False)
        
    print(f"Extracted {sample_id} ({lang.upper()}): {len(regions)} regions, {len(reference_map)} refs")
    return True

if __name__ == "__main__":
    if len(sys.argv) < 5:
        print("Usage: python extract_single_page.py <sample_id> <page_dir> <lang> <ocr_lang>")
        sys.exit(1)
    sample_id = sys.argv[1]
    page_dir = sys.argv[2]
    lang = sys.argv[3]
    ocr_lang = sys.argv[4]
    success = process_page(sample_id, page_dir, lang, ocr_lang)
    sys.exit(0 if success else 1)
