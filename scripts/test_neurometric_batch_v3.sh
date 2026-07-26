#!/usr/bin/env bash

set -euo pipefail

NEUROMETRIC_API_KEY="${NEUROMETRIC_API_KEY:-${1:-}}"

if [ -z "${NEUROMETRIC_API_KEY}" ]; then
  echo "Error: NEUROMETRIC_API_KEY environment variable or argument required."
  echo "Usage: NEUROMETRIC_API_KEY=your_key $0"
  echo "   or: $0 your_key"
  exit 1
fi

curl -i -X POST https://api.neurometric.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${NEUROMETRIC_API_KEY}" \
  -d '{
  "model": "clawpack",
  "messages": [
    {
      "role": "system",
      "content": "You are an expert manga translator.\nTranslate the list of manga text regions into natural English.\nThese regions appear in reading order. Maintain context, tone, emotion, and relationships between speakers.\nEnsure consistent character names across the chapter. Maintain a consistent tone and emotion, matching the context of previous dialogue.\nInject necessary context naturally into the translation when handling ambiguous Japanese pronouns or subjects.\n\nRegion type handling:\n- \"speech\": Translate as natural dialogue.\n- \"narration\": Translate as third-person narrative prose.\n- \"sfx\": Transliterate the sound effect AND provide an English equivalent in parentheses (e.g. \"DOKAA (WHAM)\").\n- \"caption\": Translate as editorial/scene-setting text.\n- \"sign\": Translate literally, noting it'\''s environmental text.\n\nIf multiple regions share the same conversationGroup, treat them as a continuous dialogue exchange and ensure coherent flow.\n\nNEVER include romanized text, pinyin, romaji, or pronunciation guides. Return ONLY the target-language translation.\nBAD: \"Yào chūfā le o (About to depart!)\"\nGOOD: \"About to depart!\"\nBAD: \"ERUFU (ELF!)\"\nGOOD: \"ELF!\"\n\nReturn ONLY valid JSON format conforming to the requested schema. No conversational prefix, suffix, or markdown formatting."
    },
    {
      "role": "user",
      "content": "These text regions appear in reading order.\nEach region has a \"regionType\" field indicating its category (speech/narration/sfx/caption/sign).\nRegions with the same \"conversationGroup\" are part of the same dialogue exchange.\nTranslate each region from Japanese to natural English according to its type and maintain conversational coherence within groups.\n\nPreserve:\n- tone\n- emotional state\n- relationships\n- ongoing conversation\n\nRegion type handling:\n- \"speech\": Translate as natural dialogue.\n- \"narration\": Translate as third-person narrative prose.\n- \"sfx\": Transliterate the sound effect AND provide a English equivalent in parentheses (e.g. \"DOKAA (WHAM)\").\n- \"caption\": Translate as editorial/scene-setting text.\n- \"sign\": Translate literally, noting it'\''s environmental text.\n\nIf multiple regions share the same conversationGroup, treat them as a continuous dialogue exchange and ensure coherent flow.\n\nNEVER include romanized text, pinyin, romaji, or pronunciation guides. Return ONLY the target-language translation.\nBAD: \"Yào chūfā le o (About to depart!)\"\nGOOD: \"About to depart!\"\nBAD: \"ERUFU (ELF!)\"\nGOOD: \"ELF!\"\n\nIf a region has \"previousTranslation\" and \"qaFeedback\" fields, it means the previous translation attempt failed QA (e.g. text overflow, poor phrasing, or formatting issues). Adjust your translation accordingly based on the feedback (for example, shortening the text to fit if it overflowed).\n\nYou MUST return a JSON object containing a \"translations\" key with an array of objects.\nEach object in the array MUST have the following keys:\n- \"id\" (the original string ID)\n- \"translation\" (your English translation)\n- \"translationNotes\" (brief explanation of translation decisions or register choices)\n- \"emotion\" (detected speaker emotion, e.g. \"earnest\", \"angry\", \"playful\")\n- \"tone\" (detected tone, e.g. \"formal\", \"sarcastic\", \"casual\")\n- \"translationScore\" (a self-evaluation score from 0.0 to 1.0 representing translation quality/confidence)\n\nExample structure:\n{\n  \"translations\": [\n    {\n      \"id\": \"some-id-1\",\n      \"translation\": \"Translated text here\",\n      \"translationNotes\": \"Preserved informal/teasing tone\",\n      \"emotion\": \"playful\",\n      \"tone\": \"casual\",\n      \"translationScore\": 0.95\n    }\n  ]\n}\n\nReturn ONLY valid JSON format conforming to the requested schema. No conversational prefix, suffix, or markdown formatting.\n\nInput:\n[\n  {\n    \"id\": \"93b46505-541e-47c9-b44d-f7e2563a477e\",\n    \"panel\": 1,\n    \"bubble\": 2,\n    \"speaker\": null,\n    \"regionType\": \"sfx\",\n    \"conversationGroup\": null,\n    \"text\": \"さす\"\n  },\n  {\n    \"id\": \"1fc84410-d20a-4453-b5a0-1ee061a914fb\",\n    \"panel\": 1,\n    \"bubble\": 3,\n    \"speaker\": null,\n    \"regionType\": \"sign\",\n    \"conversationGroup\": null,\n    \"text\": \"さ苏\"\n  },\n  {\n    \"id\": \"c24cd5a8-112a-4a8e-a7a1-4334c32a5b8e\",\n    \"panel\": 1,\n    \"bubble\": 1,\n    \"speaker\": null,\n    \"regionType\": \"speech\",\n    \"conversationGroup\": null,\n    \"text\": \"一緒に浴びましょうよー洗ってあげますからぁ\"\n  }\n]\n"
    }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "structured_output",
      "schema": {
        "type": "object",
        "properties": {
          "translations": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": { "type": "string" },
                "translation": { "type": "string" },
                "translationNotes": { "type": "string" },
                "emotion": { "type": "string" },
                "tone": { "type": "string" },
                "translationScore": { "type": "number", "minimum": 0.0, "maximum": 1.0 }
              },
              "required": ["id", "translation"]
            }
          }
        },
        "required": ["translations"]
      },
      "strict": true
    }
  }
}'
