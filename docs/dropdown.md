import requests
import base64
    
API_KEY = "YOUR_API_KEY"
API_URL = "https://api.toriitranslate.com/api/v2/upload"
image = open("path/to/image.png", "rb")

headers = {
    "Authorization": f"Bearer {API_KEY}",
}

data = {
    "target_lang": "en", 
    "translator": "gpt-5.6-luna", 
    "font": "wildwords", 
    "text_align": "auto", 
    "stroke_disabled": "false", 
    "min_font_size": "6", 
    "bubbles_only": "false", 
    "x-byok-openrouter": "YOUR_OPENROUTER_API_KEY"
}

response = requests.post(
    API_URL,
    headers = headers,
    data = data,
    files = { "file": ("image.png", image, "image/png") }
)

if (response.headers.get("success") == "true"):
    data = response.json()
    image_data = data["image"].split(",")[1]
    with open("translated_image.png", "wb") as f:
        f.write(base64.b64decode(image_data))
else:
    print(response.content)

---

Extracted form Open router:

{
  "role": "system",
  "content": [
    {
      "type": "text",
      "text": "\nYou are an expert translator specializing in visual media localization (literature, comics, and subtitles).\nYour task is to translate specific text segments from the source text to English.\n\n### Translation Guidelines:\n1. **Tone & Style:** Natural, native-sounding, and culturally adaptive. Capture the emotional nuance, ensuring it feels natural to a native speaker rather than a literal translation. \n2. **Context:** The input segments come from a single image/page. Use the surrounding segments to infer context, tone, and gender.\n3. **Accuracy:** Do NOT summarize. Do NOT omit text. Preserve names and proper nouns unless a localized equivalent is standard.\n4. **Formatting:**\n   - The input text may be fragmented (OCR). Translate the meaning of the segment as it appears.\n   - If a segment is a sound effect or onomatopoeia, provide the standard English equivalent.\n\n### Output Constraints:\n- You MUST return a JSON object of the format {\"translations\": [\"1. translation1\", \"2. translation2\", ...]}.\n- The value must be a list of strings corresponding 1-to-1 with the input segments.\n- Count Check: The output list MUST have exactly 5 items.\n"
    }
  ]
}

---

Translate each of the following 5 sentences into English:
1. ドキ
2. 先輩!変な目で見ちゃダメっすよ!
3. あくまでデッサンなんすからね!!
4. わわわわわわかってるよよよ
5. ドキ

---

Translate each of the following 4 sentences into English:
1. CASE: I
2. 3ーた百回え用しかいで「はいったので~A
3. あ、にーさん
4. おつの空いたよ~
