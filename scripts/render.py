#!/usr/bin/env python3
"""
render.py — Renders translated text onto a manga page based on OCR bounding boxes.

Usage:
    python scripts/render.py \
      --image examples/sample18/original.jpeg \
      --ocr examples/sample18/ocr_results_paddleocr_v6_server.json \
      --tl examples/sample18/tl_output_openrouter_google_gemma-4-26b-a4b-it_free.json
"""
import os
import json
import argparse
from PIL import Image, ImageDraw, ImageFont

def get_font(size):
    # Try common fonts, fallback to default
    font_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "arial.ttf"
    ]
    for path in font_paths:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except:
                pass
    return ImageFont.load_default()

def wrap_text(text, font, max_width):
    if not text:
        return []
    words = text.split()
    lines = []
    current_line = []
    for word in words:
        test_line = " ".join([*current_line, word])
        try:
            w = font.getbbox(test_line)[2]
        except Exception:
            try:
                w = font.getsize(test_line)[0]
            except Exception:
                w = len(test_line) * (font.size * 0.6)
        
        if w <= max_width:
            current_line.append(word)
        else:
            if current_line:
                lines.append(" ".join(current_line))
                current_line = [word]
            else:
                lines.append(word)
                current_line = []
    if current_line:
        lines.append(" ".join(current_line))
    return lines

def fit_text_in_box(text, max_w, max_h):
    best_fs = 10
    best_lines = []
    for fs in range(10, 72, 2):
        font = get_font(fs)
        lines = wrap_text(text, font, max_w)
        line_height = fs * 1.2
        if len(lines) * line_height <= max_h:
            best_fs = fs
            best_lines = lines
        else:
            break
            
    if not best_lines:
        best_fs = 10
        font = get_font(best_fs)
        best_lines = wrap_text(text, font, max_w)
        
    return best_fs, best_lines

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True, help="Original image path")
    parser.add_argument("--ocr", required=True, help="OCR results JSON (provides bounding boxes)")
    parser.add_argument("--tl", required=True, help="Translation test output JSON (provides text)")
    parser.add_argument("--output", default="final_rendered_page.jpg", help="Output image path")
    args = parser.parse_args()

    img = Image.open(args.image).convert("RGB")
    draw = ImageDraw.Draw(img)

    with open(args.ocr, "r") as f:
        ocr_data = json.load(f)
    with open(args.tl, "r") as f:
        tl_data = json.load(f)

    tl_dict = {}
    
    # Try parsing as TL output first
    if "translations" in tl_data.get("result", {}):
        for t in tl_data["result"]["translations"]:
            tl_dict[t["id"]] = t["translation"]
            
    # Try parsing as QA output
    elif "results" in tl_data.get("result", {}):
        for t in tl_data["result"]["results"]:
            if t.get("qaStatus") == "reject_sfx":
                continue
            text = t.get("directFix", {}).get("correctedText") if t.get("directFix") else None
            if not text:
                # Find the original translation in input_regions if no direct fix provided
                for ir in tl_data.get("input_regions", []):
                    if ir.get("regionId") == t.get("regionId"):
                        text = ir.get("translatedText")
                        break
            if text:
                tl_dict[t["regionId"]] = text

    regions = ocr_data.get("regions", [])
    
    for i, r in enumerate(regions):
        # The test_translation.py scripts assigns sequential IDs based on index
        rid = f"ocr_{i:04d}"
        translation = tl_dict.get(rid, "")
        if not translation:
            continue

        x, y, w, h = r["bbox"]
        
        # Draw white background box (basic masking)
        draw.rectangle([x, y, x+w, y+h], fill="white", outline="black", width=2)
        
        padding = 10
        max_w = max(10, w - padding * 2)
        max_h = max(10, h - padding * 2)
        
        fs, lines = fit_text_in_box(translation, max_w, max_h)
        font = get_font(fs)
        
        line_height = fs * 1.2
        total_height = len(lines) * line_height
        start_y = y + (h - total_height) / 2
        
        for idx, line in enumerate(lines):
            try:
                line_w = font.getbbox(line)[2]
            except Exception:
                try:
                    line_w = font.getsize(line)[0]
                except Exception:
                    line_w = len(line) * (fs * 0.6)
                    
            line_x = x + (w - line_w) / 2
            line_y = start_y + idx * line_height
            draw.text((line_x, line_y), line, fill="black", font=font)
            
    img.save(args.output)
    print(f"Saved translated image to: {args.output}")

if __name__ == "__main__":
    main()
