"""Upload the E rotation test pages to the F stack once (stdlib only). Run on chrome-box:
  python3 -I upload_e.py <dir> <base_url> <password>
"""
import io, json, os, sys, urllib.request, uuid

DONE = os.path.expanduser("~/.manga-f-e-rotation-uploaded")
SERIES = {
    "ja": {"title": "E rotation test (ja) 2026-10-08", "originalLanguage": "ja", "sourceLanguage": "ja",
           "targetLanguage": "en", "readingDirection": "rightToLeft", "ocrProvider": "local",
           "ocrModel": "PP-OCRv6", "tlProvider": "openrouter", "tlModel": "z-ai/glm-5.3-flash", "qaMode": "auto"},
    "ko": {"title": "E rotation test (ko) 2026-10-08", "originalLanguage": "ko", "sourceLanguage": "ko",
           "targetLanguage": "en", "readingDirection": "leftToRight", "ocrProvider": "local",
           "ocrModel": "PP-OCRv5", "tlProvider": "openrouter", "tlModel": "z-ai/glm-5.3-flash", "qaMode": "auto"},
}

def request(method, url, token=None, body=None, ctype="application/json"):
    headers = {"Content-Type": ctype} if body is not None else {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if ctype == "application/json" and body is not None else body
    with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=headers), timeout=600) as r:
        raw = r.read()
    return json.loads(raw) if raw else None

def multipart(fields, name, data, ftype):
    b = uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields.items():
        out.write(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    out.write(f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: {ftype}\r\n\r\n'.encode())
    out.write(data)
    out.write(f"\r\n--{b}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={b}"

def main():
    root, base, password = sys.argv[1], sys.argv[2].rstrip("/"), sys.argv[3]
    if os.path.exists(DONE):
        sys.exit(f"already uploaded ({DONE}); re-test with Redo OCR, never a second upload")
    token = request("POST", f"{base}/api/auth/login", body={"email": "f-test@manga-f.invalid", "password": password})["token"]
    open(DONE, "w").close()
    manifest = []
    for lang, fields in SERIES.items():
        series = request("POST", f"{base}/api/series", token, fields)
        chapter = request("POST", f"{base}/api/series/{series['id']}/chapters", token,
                          {"chapterNumber": 1, "title": "E rotation test pages (corpus survey 2026-10-08)",
                           "tlProvider": fields["tlProvider"], "tlModel": fields["tlModel"], "qaMode": "auto",
                           "ocrProvider": "local", "ocrModel": fields["ocrModel"]})
        for name in sorted(os.listdir(os.path.join(root, lang))):
            page = int(name.split("-", 1)[0])
            ftype = "image/png" if name.endswith(".png") else "image/jpeg"
            with open(os.path.join(root, lang, name), "rb") as fh:
                body, ctype = multipart({"chapterId": chapter["id"], "pageNumber": str(page)}, name, fh.read(), ftype)
            res = request("POST", f"{base}/api/images", token, body, ctype)
            manifest.append({"series": fields["title"], "chapterId": chapter["id"], "page": page, "file": name,
                             "response": {k: res.get(k) for k in ("id", "pageId", "status", "duplicate") if isinstance(res, dict)}})
            print(lang, page, name, manifest[-1]["response"])
    json.dump(manifest, open(os.path.join(root, "manifest.json"), "w"), indent=1)

if __name__ == "__main__":
    main()
