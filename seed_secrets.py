import json
import os
import secrets
import getpass

def main():
    os.makedirs("secrets", exist_ok=True)

    print("--- Generating random secrets ---")
    db_password = secrets.token_urlsafe(16)
    with open("secrets/db_password.txt", "w") as f:
        f.write(db_password)
    print("[✔] Generated secrets/db_password.txt")

    minio_password = secrets.token_urlsafe(16)
    with open("secrets/minio_password.txt", "w") as f:
        f.write(minio_password)
    print("[✔] Generated secrets/minio_password.txt")

    jwt_secret = secrets.token_hex(32)
    with open("secrets/jwt_secret.txt", "w") as f:
        f.write(jwt_secret)
    print("[✔] Generated secrets/jwt_secret.txt")

    internal_token = secrets.token_urlsafe(32)
    with open("secrets/internal_api_token.txt", "w") as f:
        f.write(internal_token)
    print("[✔] Generated secrets/internal_api_token.txt")

    print("\n--- Configuring API Keys ---")
    api_keys = {}
    
    providers = {
        "OPENROUTER_API_KEY": "OpenRouter",
        "GEMINI_API_KEY": "Google Gemini",
        "NVIDIA_API_KEY": "Nvidia NIM",
        "OPENAI_API_KEY": "OpenAI",
        "ANTHROPIC_API_KEY": "Anthropic",
        "DEEPL_API_KEY": "DeepL"
    }

    print("Enter the API keys for the providers you want to use.")
    print("Leave blank and press Enter to skip a provider.")
    
    for env_var, name in providers.items():
        key = getpass.getpass(f"{name} API Key ({env_var}): ").strip()
        if key:
            api_keys[env_var] = key

    with open("secrets/api_keys.json", "w") as f:
        json.dump(api_keys, f, indent=4)
    print(f"\n[✔] Saved {len(api_keys)} API keys to secrets/api_keys.json")

    print("\nAll secrets have been successfully seeded in the 'secrets' directory!")

if __name__ == "__main__":
    main()
