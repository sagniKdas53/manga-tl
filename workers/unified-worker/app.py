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
print("[Unified Worker] Initializing EasyOCR Reader (ja, en)...", flush=True)
reader = easyocr.Reader(['ja', 'en'], gpu=False)

# Initialize MangaOCR reader with Japanese support (for text inside CJK bubbles)
manga_ocr_reader = None
try:
    from manga_ocr import MangaOcr
    print("[Unified Worker] Initializing MangaOCR Reader...", flush=True)
    manga_ocr_reader = MangaOcr()
except Exception as e:
    print(f"[Unified Worker] Failed to initialize MangaOCR: {e}. Falling back to EasyOCR recognition.", flush=True)

# Clients
redis_client = redis.Redis(
    host=REDIS_HOST,
    port=REDIS_PORT,
    socket_timeout=15,
    socket_connect_timeout=5,
    socket_keepalive=True,
    retry_on_timeout=True
)
minio_client = Minio(
    MINIO_ENDPOINT,
    access_key=MINIO_ACCESS_KEY,
    secret_key=MINIO_SECRET_KEY,
    secure=False
)

# --- PANEL DETECTION HELPER FUNCTIONS ---
def detect_panels(image_bytes):
    # Decode image
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return []

    h, w, _ = img.shape
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Threshold to find white gutters/spaces between panels
    _, thresh = cv2.threshold(gray, 240, 255, cv2.THRESH_BINARY_INV)

    # Perform morphology to close small gaps in lines
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)

    # Find contours
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    panels = []
    min_area = (w * h) * 0.02  # Must be at least 2% of the image

    for c in contours:
        x, y, width, height = cv2.boundingRect(c)
        area = width * height
        if area >= min_area and width < w * 0.98 and height < h * 0.98:
            panels.append({
                'x': x,
                'y': y,
                'width': width,
                'height': height
            })

    # If no panels were detected, default to a single panel containing the whole image
    if not panels:
        panels.append({
            'x': 0,
            'y': 0,
            'width': w,
            'height': h
        })

    # Sort panels for reading order (RTL: right-to-left, top-to-bottom)
    panels.sort(key=lambda p: p['y'])
    rows = []
    for p in panels:
        added = False
        for row in rows:
            # Check if this panel y overlaps with the row's typical y
            avg_y = sum(item['y'] for item in row) / len(row)
            avg_h = sum(item['height'] for item in row) / len(row)
            # Overlap threshold: 25% of height
            if abs(p['y'] - avg_y) < avg_h * 0.25:
                row.append(p)
                added = True
                break
        if not added:
            rows.append([p])

    # Sort each row right-to-left (for RTL) and flatten
    final_panels = []
    reading_order = 1
    for r_idx, row in enumerate(rows):
        row.sort(key=lambda p: p['x'], reverse=True) # Rightmost panel first in RTL
        for c_idx, p in enumerate(row):
            p['gridRow'] = r_idx
            p['gridCol'] = c_idx
            p['readingOrder'] = reading_order
            reading_order += 1
            final_panels.append(p)

    return final_panels

# --- OCR HELPER FUNCTIONS ---
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
    rx, ry, rw, rh = r['x'], r['y'], r['width'], r['height']
    px, py, pw, ph = p['bboxX'], p['bboxY'], p['bboxW'], p['bboxH']
    
    overlap_x = max(0, min(rx + rw, px + pw) - max(rx, px))
    overlap_y = max(0, min(ry + rh, py + ph) - max(ry, py))
    return overlap_x * overlap_y

def bubble_compare(a, b):
    # RTL comparator
    y_diff = a['y'] - b['y']
    if abs(y_diff) > 100:
        return 1 if y_diff > 0 else -1
    
    x_diff = b['x'] - a['x']
    return 1 if x_diff > 0 else -1


# --- JOB PROCESSORS ---

def process_panel_detection(job_data):
    image_id = job_data['imageId']
    print(f"[Panel Detection] Processing image: {image_id}", flush=True)

    try:
        backend_url = CALLBACK_URL.replace('/jobs/callback', f'/images/{image_id}')
        res = requests.get(backend_url)
        if res.status_code != 200:
            print(f"[Panel Detection] Failed to get image info: {res.status_code}", flush=True)
            return
        image_info = res.json()
        storage_path = image_info['storagePath']
    except Exception as e:
        print(f"[Panel Detection] Error fetching image details: {e}", flush=True)
        return

    try:
        response = minio_client.get_object('manga-library', storage_path)
        img_bytes = response.read()
    except Exception as e:
        print(f"[Panel Detection] Error downloading from MinIO: {e}", flush=True)
        return

    panels = detect_panels(img_bytes)
    print(f"[Panel Detection] Detected {len(panels)} panels for image {image_id}", flush=True)

    callback_payload = {
        'imageId': image_id,
        'panels': panels
    }
    try:
        res = requests.post(f"{CALLBACK_URL}/panel", json=callback_payload)
        print(f"[Panel Detection] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        print(f"[Panel Detection] Failed to post callback to backend: {e}", flush=True)


def process_ocr(job_data):
    image_id = job_data['imageId']
    print(f"[OCR] Processing image: {image_id}", flush=True)

    try:
        backend_url = CALLBACK_URL.replace('/jobs/callback', f'/images/{image_id}')
        res = requests.get(backend_url)
        if res.status_code != 200:
            print(f"[OCR] Failed to get image info: {res.status_code}", flush=True)
            return
        image_info = res.json()
        storage_path = image_info['storagePath']
        panels = image_info.get('panels', [])
    except Exception as e:
        print(f"[OCR] Error fetching image details: {e}", flush=True)
        return

    try:
        response = minio_client.get_object('manga-library', storage_path)
        img_bytes = response.read()
    except Exception as e:
        print(f"[OCR] Error downloading from MinIO: {e}", flush=True)
        return

    try:
        results = reader.readtext(img_bytes)
    except Exception as e:
        print(f"[OCR] Error during OCR: {e}", flush=True)
        return

    # Decode image using OpenCV for cropping if MangaOCR is active
    img = None
    if manga_ocr_reader is not None:
        try:
            nparr = np.frombuffer(img_bytes, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        except Exception as e:
            print(f"[OCR] Error decoding image for MangaOCR: {e}", flush=True)

    regions = []
    for bbox, text, confidence in results:
        xs = [pt[0] for pt in bbox]
        ys = [pt[1] for pt in bbox]
        x, y = int(min(xs)), int(min(ys))
        width, height = int(max(xs) - x), int(max(ys) - y)

        lang = detect_language(text)

        # Run MangaOCR on bubbles with CJK (Japanese/Chinese) characters
        if lang in ('ja', 'zh-TW') and manga_ocr_reader is not None and img is not None:
            try:
                img_h, img_w = img.shape[:2]
                x1, y1 = max(0, x), max(0, y)
                x2, y2 = min(img_w, x + width), min(img_h, y + height)

                if (x2 - x1) > 0 and (y2 - y1) > 0:
                    crop = img[y1:y2, x1:x2]
                    from PIL import Image
                    crop_rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
                    pil_img = Image.fromarray(crop_rgb)
                    manga_text = manga_ocr_reader(pil_img)
                    if manga_text and len(manga_text.strip()) > 0:
                        print(f"[OCR] Overwriting EasyOCR text '{text}' with MangaOCR '{manga_text}'", flush=True)
                        text = manga_text
            except Exception as e:
                print(f"[OCR] MangaOCR failed on region ({x},{y},{width},{height}): {e}", flush=True)

        regions.append({
            'text': text,
            'detectedLanguage': lang,
            'confidence': float(confidence),
            'rotation': 0.0,
            'x': x,
            'y': y,
            'width': width,
            'height': height,
            'panelId': None,
            'bubbleReadingOrder': 0
        })

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

    ordered_regions = []
    sorted_panel_indices = sorted(panel_regions_map.keys(), key=lambda idx: panels[idx]['readingOrder'])
    
    for panel_idx in sorted_panel_indices:
        panel_bubbles = panel_regions_map[panel_idx]
        panel_bubbles.sort(key=cmp_to_key(bubble_compare))
        
        for b_order, r in enumerate(panel_bubbles, start=1):
            r['bubbleReadingOrder'] = b_order
            ordered_regions.append(r)
            
    unmapped_regions.sort(key=cmp_to_key(bubble_compare))
    for b_order, r in enumerate(unmapped_regions, start=1):
        r['bubbleReadingOrder'] = b_order
        ordered_regions.append(r)

    print(f"[OCR] Completed OCR. Found {len(ordered_regions)} text regions", flush=True)

    callback_payload = {
        'imageId': image_id,
        'regions': ordered_regions
    }
    try:
        res = requests.post(f"{CALLBACK_URL}/ocr", json=callback_payload)
        print(f"[OCR] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        print(f"[OCR] Failed to post callback to backend: {e}", flush=True)


def process_stub(job_data, job_type):
    image_id = job_data['imageId']
    print(f"[Stub - {job_type}] Processing image: {image_id}", flush=True)

    # Mimic work
    time.sleep(0.5)

    callback_payload = {
        'imageId': image_id
    }
    try:
        res = requests.post(f"{CALLBACK_URL}/{job_type}", json=callback_payload)
        print(f"[Stub - {job_type}] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        print(f"[Stub - {job_type}] Failed to post callback: {e}", flush=True)


# --- MAIN RUNNER ---
def main():
    queues = [
        'queue:panel-detection',
        'queue:ocr',
        'queue:layout',
        'queue:translation',
        'queue:render'
    ]
    print(f"[Unified Worker] Listening to Redis queues: {queues}...", flush=True)
    while True:
        try:
            # blpop takes multiple queues and blocks
            job_tuple = redis_client.blpop(queues, timeout=5)
            if job_tuple:
                queue_bytes, job_json = job_tuple
                queue_name = queue_bytes.decode('utf-8')
                job_data = json.loads(job_json)

                if queue_name == 'queue:panel-detection':
                    process_panel_detection(job_data)
                elif queue_name == 'queue:ocr':
                    process_ocr(job_data)
                elif queue_name == 'queue:layout':
                    process_stub(job_data, 'layout')
                elif queue_name == 'queue:translation':
                    process_stub(job_data, 'translation')
                elif queue_name == 'queue:render':
                    process_stub(job_data, 'render')
        except Exception as e:
            print(f"[Unified Worker] Error in main loop: {e}", flush=True)
            time.sleep(1)

if __name__ == '__main__':
    main()
