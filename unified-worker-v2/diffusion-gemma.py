import requests, base64

invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions"
stream = False

def read_b64(path):
  with open(path, "rb") as f:
    return base64.b64encode(f.read()).decode()

headers = {
  "Authorization": "Bearer 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",
  "Accept": "text/event-stream" if stream else "application/json"
}

payload = {
  "model": "google/diffusiongemma-26b-a4b-it",
  "messages": [{"role":"user","content": [
                    {
                        "type": "text",
                        "text": "What is in this image?"
                    },
                    {
                        "type": "image_url",
                        "image_url":
                            {
                                "url": "https://assets.ngc.nvidia.com/products/api-catalog/phi-3-5-vision/example1b.jpg"
                            }
                    }
                ]
            }],
  "max_tokens": 4096,
  "temperature": 1.00,
  "top_p": 0.95,
  "stream": stream,
  "chat_template_kwargs": {"enable_thinking":True},
}

response = requests.post(invoke_url, headers=headers, json=payload, stream=stream)
if stream:
    for line in response.iter_lines():
        if line:
            print(line.decode("utf-8"))
else:
    print(response.json())