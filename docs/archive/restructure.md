Inspect API keys dynamically won't work, we need to add a way to manually map the models to the provider (just like we do in hermes and other tools) think of a way to do that.

My idea is restructure the [api_keys.json](file;file:///home/sagnik/Projects/docker-composes/manga-library/secrets/api_keys.json) to have have something like

model config.json/yaml that can be used to give this info.
{
  providerNames: [list of all providers],
  defaults: {
    defaultProvider: name,
    defaultTL: model,
    defaultQALLM: model,
    defaultQAVLM: model,
    defaultOCR: model
    // just name could be enough if they are defined in providerDetails.providerName.defaultTLModel, etc
  },
  providerDetails: {
    providerName: {
      key: "",
      models: {
        tl: [list of TL models we may use],
        qaLLM: [list of QA LLM models we may use],
        qaVLM: [list of QA VLM models we may use],
        ocr: [list of OCR models we may use]
      },
      "rateLimits": value,
      "defaultTLModel": model from the models list which is preferred over others (this can be set to null if no default is preferred),
      // If VLM's are not served like neuromatic doesn't we can put null there so it
      // won't be picked up and appear as a valid selector for VLM tasks
      "defaultQALLMModel": model from the models list which is preferred over others (this can be set to null if no default is preferred),
      "defaultQAVLMModel": model from the models list which is preferred over others (this can be set to null if no default is preferred),
      "defaultOCRModel": model from the models list which is preferred over others (this can be set to null if no default is preferred),
      "freeTier": true if provider has free tier, false otherwise, if false don't do cost calculation,
      costs: {
        tl: {
          calculated costs go here
        },
        qaLLM: {
          calculated costs go here
        },
        qaVLM: {
          calculated costs go here
        },
        ocr: {
          calculated costs go here
        },
      },
      "priority": number (lower is higher priority)
    }
  }
}

also make sure we add a fallback where if a provider or model is missing we fall back, and if the default ones are missing we throw errors

If the models get deprecated or the provider is removed then fall back to the default one for which ever chapter or series was using them, everytime we start up make sure to sync the models and providers, also since we have the const thigy update it here as well, we will replace the api_keys.json with secrets/llm_config.json

Also validate the inheritance chain

P0 -> User chapter over rides
P1 -> Inherited values from series (these can be user overrides or the defaults set in series)
P2 -> Users series over rides
P3 -> Inherited values from global (these can be user overrides or the defaults set in System Settings)
P4 -> Users globals over rides
P5 -> global provider and models get inilized as System Settings

If any of these fail we downgrade to the next one, for instance if P0 fails we go to P1, if P1 fails we go to P2, and so on, and if all of them fail we throw an error.

Also support adding generic OPEN API compatible endpoinyts like neuromatic and stuff using this so that we don't need to modilfy the client everytime.

---

CF:

curl \
  <https://api.cloudflare.com/client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/run/@cf/moonshotai/kimi-k2.7-code> \
  -H "Authorization: Bearer {API_TOKEN}" \
  -d '{"messages":[{"role":"system","content":"You are a friendly assistant that helps write stories"},{"role":"user","content":"Write a short story about a llama that goes on a journey to find an orange cloud "}]}'

Neuromatic:

openclaw config set --batch-json '[{"path":"models.providers.neurometric.baseUrl","value":"https://api.neurometric.ai/v1"},{"path":"models.providers.neurometric.apiKey","value":"redacted},{"path":"models.providers.neurometric.api","value":"openai-completions"},{"path":"models.providers.neurometric.models","value":[{"id":"clawpack","name":"ClawPack"}]},{"path":"agents.defaults.models.neurometric/clawpack","value":{"alias":"ClawPack"}}]' --strict-json

curl -X 'POST' \
  '<https://api.neurometric.ai/v1/chat/completions>' \
  -H 'accept: application/json' \
  -H 'Authorization: Bearer [ENCRYPTION_KEY]' \
  -H 'Content-Type: application/json' \
  -d '{
  "messages": [
    {
      "role": "system",
      "content": "You are a friendly assistant that helps write stories"
    },
    {
      "role": "user",
      "content": "Write a short story about a llama that goes on a journey to find an orange cloud"
    }
  ],
  "max_tokens": 2048,
  "stream": true,
  "reasoning_mode": "full",
  "tools": [],
  "frequency_penalty": 0,
  "presence_penalty": 0,
  "temperature": 1,
  "top_p": 1,
  "top_k": 0,
  "logit_bias": {},
  "stop": null,
  "n": 1,
  "user": "user-12345"
}
'
Nvidia:

stream=false
if [ "$stream" = true ]; then
    accept_header='Accept: text/event-stream'
else
    accept_header='Accept: application/json'
fi

cat > payload.json <<JSON
{"messages":[{"role":"user","content":""}],"model":"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning","max_tokens":65536,"reasoning_budget":16384,"stream":false,"temperature":0.6,"top_p":0.95}
JSON

curl <https://integrate.api.nvidia.com/v1/chat/completions> \
  -H "Authorization: Bearer $NVIDIA_API_KEY" \
  -H "Content-Type: application/json" \
  -H "$accept_header" \
  -d @payload.json

Google AI STudio:

# !/bin/bash

set -e -E

GEMINI_API_KEY="$GEMINI_API_KEY"

cat << EOF > request.json
{
    "model": "models/gemini-3.6-flash",
    "input": "",
    "tools": [
        {
            "type": "google_search"
        }
    ],
    "generation_config": {
        "max_output_tokens": 65536,
        "thinking_level": "medium"
    }
}
EOF

curl \
-X POST \
-H "Content-Type: application/json" \
"<https://generativelanguage.googleapis.com/v1beta/interactions?key=${GEMINI_API_KEY}>" -d '@request.json'
