#!/usr/bin/env python3
"""
Migrate old JPEG thumbnails to WebP format using multiple parallel workers.
Requirements:
    pip install psycopg2-binary minio Pillow tqdm

Usage:
    It's recommended to run this inside the manga-backend container to easily access internal services:
    docker exec -it manga-backend bash
    apt-get update && apt-get install -y python3-pip
    pip3 install psycopg2-binary minio Pillow tqdm --break-system-packages
    python3 scripts/migrate_thumbnails.py
"""

import os
import io
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
import psycopg2
from psycopg2.extras import DictCursor
from minio import Minio
from PIL import Image
from tqdm import tqdm

# Configuration (Change as needed)
DB_HOST = os.getenv("DB_HOST", "db")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "manga_library")
DB_USER = os.getenv("DB_USER", "postgres")
# Try to read password from file if it exists (like in container)
db_pass_file = "/run/secrets/db_password"
if os.path.exists(db_pass_file):
    with open(db_pass_file, "r") as f:
        DB_PASS = f.read().strip()
else:
    DB_PASS = os.getenv("DB_PASS", "postgres")

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "minio:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
minio_pass_file = "/run/secrets/minio_password"
if os.path.exists(minio_pass_file):
    with open(minio_pass_file, "r") as f:
        MINIO_SECRET_KEY = f.read().strip()
else:
    MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "minioadmin")

MINIO_BUCKET = os.getenv("MINIO_BUCKET", "manga-library")

PARALLEL_JOBS = int(os.getenv("PARALLEL_JOBS", "4"))
THUMBNAIL_MAX_DIMENSION = 512

def process_image(image_record):
    db_conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASS
    )
    db_conn.autocommit = True
    cursor = db_conn.cursor()
    
    minio_client = Minio(
        MINIO_ENDPOINT,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        secure=False
    )
    
    try:
        image_id = image_record["id"]
        storage_path = image_record["storage_path"]
        old_thumb_path = image_record["thumbnail_storage_path"]

        # Only process if we haven't generated a webp thumbnail yet
        if old_thumb_path and old_thumb_path.endswith(".webp"):
            return True, image_id, "Already webp"

        # 1. Download original image
        response = minio_client.get_object(MINIO_BUCKET, storage_path)
        original_bytes = response.read()
        response.close()
        response.release_conn()
        
        # 2. Process with Pillow
        img = Image.open(io.BytesIO(original_bytes))
        # Ensure we're in RGB mode before saving as WebP
        if img.mode not in ('RGB', 'RGBA'):
            img = img.convert('RGBA')
            
        img.thumbnail((THUMBNAIL_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION), Image.Resampling.BICUBIC)
        
        # 3. Save to webp
        webp_io = io.BytesIO()
        img.save(webp_io, format="WEBP", quality=80)
        webp_bytes = webp_io.getvalue()
        
        # 4. Upload new thumbnail
        uuid_str = str(uuid.uuid4())
        new_thumb_path = f"thumbnails/{uuid_str}.webp"
        
        minio_client.put_object(
            MINIO_BUCKET,
            new_thumb_path,
            io.BytesIO(webp_bytes),
            length=len(webp_bytes),
            content_type="image/webp"
        )
        
        # 5. Delete old thumbnail if it existed
        if old_thumb_path:
            try:
                minio_client.remove_object(MINIO_BUCKET, old_thumb_path)
            except Exception:
                pass # ignore deletion errors (e.g. file not found)

        # 6. Update DB
        cursor.execute(
            "UPDATE images SET thumbnail_storage_path = %s WHERE id = %s",
            (new_thumb_path, image_id)
        )
        
        return True, image_id, None
    except Exception as e:
        return False, image_record["id"], str(e)
    finally:
        cursor.close()
        db_conn.close()

def main():
    print("Starting thumbnail migration...")
    print(f"Connecting to Postgres at {DB_HOST}:{DB_PORT}/{DB_NAME}...")
    print(f"Connecting to MinIO at {MINIO_ENDPOINT} bucket {MINIO_BUCKET}...")
    
    # Get all images
    db_conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASS
    )
    cursor = db_conn.cursor(cursor_factory=DictCursor)
    
    # Fetch all images that need thumbnails (either missing or not webp)
    cursor.execute("""
        SELECT id, storage_path, thumbnail_storage_path 
        FROM images 
        WHERE storage_path IS NOT NULL 
          AND (thumbnail_storage_path IS NULL OR thumbnail_storage_path NOT LIKE '%%.webp')
    """)
    images = cursor.fetchall()
    
    cursor.close()
    db_conn.close()
    
    print(f"Found {len(images)} images that need WebP thumbnails.")
    
    success_count = 0
    error_count = 0
    skip_count = 0
    
    if not images:
        print("Nothing to migrate!")
        return

    with ThreadPoolExecutor(max_workers=PARALLEL_JOBS) as executor:
        futures = {executor.submit(process_image, img): img for img in images}
        
        for future in tqdm(as_completed(futures), total=len(images), desc="Migrating thumbnails"):
            success, img_id, error = future.result()
            if success:
                if error == "Already webp":
                    skip_count += 1
                else:
                    success_count += 1
            else:
                error_count += 1
                print(f"\nError processing image {img_id}: {error}")
                
    print(f"\nMigration complete!")
    print(f"Successfully processed: {success_count}")
    print(f"Skipped (already WebP): {skip_count}")
    print(f"Errors: {error_count}")

if __name__ == "__main__":
    main()
