import os
import json
import time
import redis
import requests

# Configurations
REDIS_HOST = os.environ.get('REDIS_HOST', 'localhost')
REDIS_PORT = int(os.environ.get('REDIS_PORT', 6379))
JOB_TYPE = os.environ.get('JOB_TYPE', 'layout')
CALLBACK_URL = os.environ.get('BACKEND_CALLBACK_URL', 'http://localhost:8080/api/internal/jobs/callback')

# Clients
redis_client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT)

def process_job(job_data):
    image_id = job_data['imageId']
    print(f"[Stub Worker - {JOB_TYPE}] Processing image: {image_id}", flush=True)

    # Mimic some work
    time.sleep(0.5)

    # Callback to backend
    callback_payload = {
        'imageId': image_id
    }
    try:
        res = requests.post(f"{CALLBACK_URL}/{JOB_TYPE}", json=callback_payload)
        print(f"[Stub Worker - {JOB_TYPE}] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        print(f"[Stub Worker - {JOB_TYPE}] Failed to post callback: {e}", flush=True)

def main():
    queue_name = f"queue:{JOB_TYPE}"
    print(f"[Stub Worker - {JOB_TYPE}] Started. Listening to Redis queue '{queue_name}'...", flush=True)
    while True:
        try:
            job_tuple = redis_client.blpop(queue_name, timeout=5)
            if job_tuple:
                job_json = job_tuple[1]
                job_data = json.loads(job_json)
                process_job(job_data)
        except Exception as e:
            print(f"[Stub Worker - {JOB_TYPE}] Error in main loop: {e}", flush=True)
            time.sleep(1)

if __name__ == '__main__':
    main()
