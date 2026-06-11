import os
import json
import time
import redis
import requests
import cv2
import numpy as np
from minio import Minio

# Configurations
REDIS_HOST = os.environ.get('REDIS_HOST', 'localhost')
REDIS_PORT = int(os.environ.get('REDIS_PORT', 6379))
MINIO_ENDPOINT = os.environ.get('MINIO_ENDPOINT', 'localhost:9000')
MINIO_ACCESS_KEY = os.environ.get('MINIO_ACCESS_KEY', 'minioadmin')
MINIO_SECRET_KEY = os.environ.get('MINIO_SECRET_KEY', 'minioadmin')
CALLBACK_URL = os.environ.get('BACKEND_CALLBACK_URL', 'http://localhost:8080/api/internal/jobs/callback')

# Clients
redis_client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT)
minio_client = Minio(
    MINIO_ENDPOINT,
    access_key=MINIO_ACCESS_KEY,
    secret_key=MINIO_SECRET_KEY,
    secure=False
)

def detect_panels(image_bytes):
    # Decode image
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return []

    h, w, _ = img.shape
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Threshold to find white gutters/spaces between panels
    # In manga, gutters are typically white
    _, thresh = cv2.threshold(gray, 240, 255, cv2.THRESH_BINARY_INV)

    # Perform morphology to close small gaps in lines
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)

    # Find contours (panels are large black shapes in the inverted threshold image)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    panels = []
    min_area = (w * h) * 0.02  # Must be at least 2% of the image

    for i, c in enumerate(contours):
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
    # Group panels into rows based on y-coordinate overlaps
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

def process_job(job_data):
    image_id = job_data['imageId']
    print(f"[Panel Worker] Processing image: {image_id}", flush=True)

    # 1. Fetch metadata from backend (or we can assume storage path is in standard format)
    # We will invoke the internal endpoint: http://backend:8080/api/internal/images/{imageId}
    try:
        backend_url = CALLBACK_URL.replace('/jobs/callback', f'/images/{image_id}')
        res = requests.get(backend_url)
        if res.status_code != 200:
            print(f"[Panel Worker] Failed to get image info: {res.status_code}", flush=True)
            return
        image_info = res.json()
        storage_path = image_info['storagePath']
    except Exception as e:
        print(f"[Panel Worker] Error fetching image details: {e}", flush=True)
        return

    # 2. Get file from MinIO
    try:
        response = minio_client.get_object('manga-library', storage_path)
        img_bytes = response.read()
    except Exception as e:
        print(f"[Panel Worker] Error downloading from MinIO: {e}", flush=True)
        return

    # 3. Detect panels
    panels = detect_panels(img_bytes)
    print(f"[Panel Worker] Detected {len(panels)} panels for image {image_id}", flush=True)

    # 4. Callback to backend
    callback_payload = {
        'imageId': image_id,
        'panels': panels
    }
    try:
        res = requests.post(f"{CALLBACK_URL}/panel", json=callback_payload)
        print(f"[Panel Worker] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        print(f"[Panel Worker] Failed to post callback to backend: {e}", flush=True)

def main():
    print("[Panel Worker] Started. Listening to Redis queue 'queue:panel-detection'...", flush=True)
    while True:
        try:
            # BLPOP blocks until an item is available
            job_tuple = redis_client.blpop('queue:panel-detection', timeout=5)
            if job_tuple:
                job_json = job_tuple[1]
                job_data = json.loads(job_json)
                process_job(job_data)
        except Exception as e:
            print(f"[Panel Worker] Error in main loop: {e}", flush=True)
            time.sleep(1)

if __name__ == '__main__':
    main()
