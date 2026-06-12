import os
import json
import time
import re
import redis
import requests
import numpy as np
import cv2
import easyocr
from minio import Minio
from functools import cmp_to_key

# Configurations
REDIS_HOST = os.environ.get('REDIS_HOST', 'localhost')
REDIS_PORT = int(os.environ.get('REDIS_PORT', 6379))
MINIO_ENDPOINT = os.environ.get('MINIO_ENDPOINT', 'localhost:9000')
MINIO_ACCESS_KEY = os.environ.get('MINIO_ACCESS_KEY', 'minioadmin')
MINIO_SECRET_KEY = os.environ.get('MINIO_SECRET_KEY', 'minioadmin')
CALLBACK_URL = os.environ.get('BACKEND_CALLBACK_URL', 'http://localhost:8080/api/internal/jobs/callback')

# Initialize EasyOCR reader with Japanese and English support
print("[OCR Worker] Initializing EasyOCR Reader (ja, en)...", flush=True)
reader = easyocr.Reader(['ja', 'en'], gpu=False)

# Clients
redis_client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT)
minio_client = Minio(
    MINIO_ENDPOINT,
    access_key=MINIO_ACCESS_KEY,
    secret_key=MINIO_SECRET_KEY,
    secure=False
)

def detect_language(text):
    # Regex ranges for CJK
    # Japanese Hiragana/Katakana
    if re.search(r'[\u3040-\u309F\u30A0-\u30FF]', text):
        return 'ja'
    # Chinese Hanzi (CJK Unified Ideographs)
    elif re.search(r'[\u4E00-\u9FFF]', text):
        return 'zh-TW'
    # Otherwise fallback to English
    return 'en'

def calculate_overlap_area(r, p):
    # r is ocr region dict, p is panel dict (from db)
    # panel keys: bboxX, bboxY, bboxW, bboxH
    rx, ry, rw, rh = r['x'], r['y'], r['width'], r['height']
    px, py, pw, ph = p['bboxX'], p['bboxY'], p['bboxW'], p['bboxH']
    
    overlap_x = max(0, min(rx + rw, px + pw) - max(rx, px))
    overlap_y = max(0, min(ry + rh, py + ph) - max(ry, py))
    return overlap_x * overlap_y

def bubble_compare(a, b):
    # RTL comparator
    # If vertical separation is significant, top comes first (smaller y)
    y_diff = a['y'] - b['y']
    # If bubbles are in different rows (vertical threshold of 100px)
    if abs(y_diff) > 100:
        return 1 if y_diff > 0 else -1
    
    # If they are vertically close, right comes first (larger x)
    x_diff = b['x'] - a['x']
    return 1 if x_diff > 0 else -1

def process_job(job_data):
    image_id = job_data['imageId']
    print(f"[OCR Worker] Processing image: {image_id}", flush=True)

    # 1. Fetch metadata & panels from backend
    try:
        backend_url = CALLBACK_URL.replace('/jobs/callback', f'/images/{image_id}')
        res = requests.get(backend_url)
        if res.status_code != 200:
            print(f"[OCR Worker] Failed to get image info: {res.status_code}", flush=True)
            return
        image_info = res.json()
        storage_path = image_info['storagePath']
        panels = image_info.get('panels', [])
    except Exception as e:
        print(f"[OCR Worker] Error fetching image details: {e}", flush=True)
        return

    # 2. Get file from MinIO
    try:
        response = minio_client.get_object('manga-library', storage_path)
        img_bytes = response.read()
    except Exception as e:
        print(f"[OCR Worker] Error downloading from MinIO: {e}", flush=True)
        return

    # 3. Run OCR
    try:
        results = reader.readtext(img_bytes)
    except Exception as e:
        print(f"[OCR Worker] Error during OCR: {e}", flush=True)
        return

    # Map EasyOCR results to custom schema
    regions = []
    for bbox, text, confidence in results:
        # bbox is a list of 4 coordinates: [[x1, y1], [x2, y2], [x3, y3], [x4, y4]]
        xs = [pt[0] for pt in bbox]
        ys = [pt[1] for pt in bbox]
        x, y = int(min(xs)), int(min(ys))
        width, height = int(max(xs) - x), int(max(ys) - y)

        regions.append({
            'text': text,
            'detectedLanguage': detect_language(text),
            'confidence': float(confidence),
            'rotation': 0.0,
            'x': x,
            'y': y,
            'width': width,
            'height': height,
            'panelId': None,
            'bubbleReadingOrder': 0
        })

    # Group OCR regions by panels using bounding box overlap
    panel_regions_map = {}
    unmapped_regions = []

    for r in regions:
        best_panel_idx = -1
        max_overlap = 0
        for idx, p in enumerate(panels):
            overlap = calculate_overlap_area(r, p)
            if overlap > max_overlap:
                max_overlap = overlap
                best_panel_idx = idx
        
        if best_panel_idx != -1:
            if best_panel_idx not in panel_regions_map:
                panel_regions_map[best_panel_idx] = []
            panel_regions_map[best_panel_idx].append(r)
        else:
            unmapped_regions.append(r)

    # Sort bubbles inside each panel and assign bubble reading order
    ordered_regions = []
    
    # Sort panel keys by panels' reading_order
    sorted_panel_indices = sorted(panel_regions_map.keys(), key=lambda idx: panels[idx]['readingOrder'])
    
    for panel_idx in sorted_panel_indices:
        panel_bubbles = panel_regions_map[panel_idx]
        # Sort panel bubbles RTL
        panel_bubbles.sort(key=cmp_to_key(bubble_compare))
        
        for b_order, r in enumerate(panel_bubbles, start=1):
            r['bubbleReadingOrder'] = b_order
            ordered_regions.append(r)
            
    # Append unmapped regions at the end
    unmapped_regions.sort(key=cmp_to_key(bubble_compare))
    for b_order, r in enumerate(unmapped_regions, start=1):
        r['bubbleReadingOrder'] = b_order
        ordered_regions.append(r)

    print(f"[OCR Worker] Completed OCR. Found {len(ordered_regions)} text regions", flush=True)

    # 4. Callback to backend
    callback_payload = {
        'imageId': image_id,
        'regions': ordered_regions
    }
    try:
        res = requests.post(f"{CALLBACK_URL}/ocr", json=callback_payload)
        print(f"[OCR Worker] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        print(f"[OCR Worker] Failed to post callback to backend: {e}", flush=True)

def main():
    print("[OCR Worker] Started. Listening to Redis queue 'queue:ocr'...", flush=True)
    while True:
        try:
            job_tuple = redis_client.blpop('queue:ocr', timeout=5)
            if job_tuple:
                job_json = job_tuple[1]
                job_data = json.loads(job_json)
                process_job(job_data)
        except Exception as e:
            print(f"[OCR Worker] Error in main loop: {e}", flush=True)
            time.sleep(1)

if __name__ == '__main__':
    main()
