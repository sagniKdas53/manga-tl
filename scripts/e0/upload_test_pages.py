"""Upload the E rotation test pages to the F stack once (stdlib only). Run on chrome-box:
  python3 -I upload_test_pages.py <dir> <base_url> <password>

<dir> holds ja/ and ko/ folders of NN-<sample>.<ext> files. Before a new batch, change DONE and the
SERIES titles. Progress goes to <dir>/manifest.json; the 2026-10-08 batch predates this format.
"""
import io, json, os, sys, urllib.parse, urllib.request, uuid

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
    host = urllib.parse.urlparse(base).hostname or ""
    if base.startswith("http://") and host not in ("localhost", "127.0.0.1", "::1"):
        sys.exit(f"refusing to send the password over plain HTTP to {host}; use https or run this on the host")
    if os.path.exists(DONE):
        sys.exit(f"already uploaded ({DONE}); re-test with Redo OCR, never a second upload")
    # Progress is saved after every page, so a run that stops half way resumes where it stopped.
    # A page whose upload was sent but never confirmed is not retried: if it landed, a second
    # upload would clone its regions instead of running OCR. Check the stack, then fix the
    # manifest by hand.
    state_path = os.path.join(root, "manifest.json")
    state = json.load(open(state_path)) if os.path.exists(state_path) else {"chapters": {}, "pages": {}}
    unconfirmed = [name for name, page in state["pages"].items() if page.get("state") == "sent"]
    if unconfirmed:
        sys.exit(f"uploads sent but not confirmed: {unconfirmed}; check the stack and edit {state_path}")

    def save():
        with open(state_path, "w") as fh:
            json.dump(state, fh, indent=1)

    token = request("POST", f"{base}/api/auth/login", body={"email": "f-test@manga-f.invalid", "password": password})["token"]
    for lang, fields in SERIES.items():
        chapter_id = state["chapters"].get(lang)
        if not chapter_id:
            series = request("POST", f"{base}/api/series", token, fields)
            chapter_id = request("POST", f"{base}/api/series/{series['id']}/chapters", token,
                                 {"chapterNumber": 1, "title": "E rotation test pages (corpus survey 2026-10-08)",
                                  "tlProvider": fields["tlProvider"], "tlModel": fields["tlModel"], "qaMode": "auto",
                                  "ocrProvider": "local", "ocrModel": fields["ocrModel"]})["id"]
            state["chapters"][lang] = chapter_id
            save()
        for name in sorted(os.listdir(os.path.join(root, lang))):
            key = f"{lang}/{name}"
            if state["pages"].get(key, {}).get("state") == "uploaded":
                continue
            page = int(name.split("-", 1)[0])
            ftype = "image/png" if name.endswith(".png") else "image/jpeg"
            with open(os.path.join(root, lang, name), "rb") as fh:
                body, ctype = multipart({"chapterId": chapter_id, "pageNumber": str(page)}, name, fh.read(), ftype)
            state["pages"][key] = {"series": fields["title"], "chapterId": chapter_id, "page": page, "state": "sent"}
            save()
            res = request("POST", f"{base}/api/images", token, body, ctype)
            state["pages"][key].update(state="uploaded", pageId=(res or {}).get("pageId"), status=(res or {}).get("status"))
            save()
            print(lang, page, name, state["pages"][key])
    open(DONE, "w").close()


if __name__ == "__main__":
    main()
