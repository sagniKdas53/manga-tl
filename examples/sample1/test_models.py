import requests
import json
import os
from dotenv import load_dotenv

load_dotenv('../../.env')

key = os.environ.get('OPENROUTER_API_KEY')
res = requests.get('https://openrouter.ai/api/v1/models', headers={'Authorization': f'Bearer {key}'})
models = [m['id'] for m in res.json().get('data', []) if 'gemini' in m['id']]
print("Available Gemini models on OpenRouter:")
for m in models:
    print(m)
