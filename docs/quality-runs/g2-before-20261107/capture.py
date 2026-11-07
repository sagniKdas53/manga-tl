"""Capture the "before" of G2 (#176/#177): scene and rendered page of every page on a stack.

  python3 -I capture.py <base_url> <email_file> <password_file> <out_dir> <manifest.json>

Reads page ids from the stack's database (docker exec ... psql), so run it on the stack's host.
Large files (scene JSON, rendered PNG) go to <out_dir>, outside the repo; the manifest
keeps their SHA-256 and the counts that G2 should change. Credentials come from files, never argv.
Nothing is uploaded and no model is called: this only reads pages.
"""
import hashlib, json, os, subprocess, sys, time, urllib.request, urllib.error

DB = ["docker", "exec", "manga-tl-test-db-1", "psql", "-U", "tladmin", "-d", "manga_library", "-At", "-F", "|", "-c"]


def sql(q):
    return [r.split("|") for r in subprocess.run(DB + [q], capture_output=True, text=True, check=True).stdout.strip().split("\n") if r]


def get(url, token, tries=1):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.status, r.read()


def main():
    base, email_f, pw_f, out, manifest_path = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
    body = json.dumps({"email": open(email_f).read().strip(), "password": open(pw_f).read()}).encode()
    token = json.load(urllib.request.urlopen(urllib.request.Request(base + "/api/auth/login", data=body, headers={"Content-Type": "application/json"})))["token"]
    for d in ("scenes", "rendered"):
        os.makedirs(os.path.join(out, d), exist_ok=True)
    rows = sql("select s.title, c.chapter_number, c.id, p.page_number, p.id, p.scene_revision from pages p "
               "join chapters c on c.id=p.chapter_id join series s on s.id=c.series_id order by s.title, c.chapter_number, p.page_number")
    pages = []
    for title, ch, cid, pn, pid, rev in rows:
        _, scene_raw = get(f"{base}/api/pages/{pid}/scene", token)
        scene = json.loads(scene_raw)
        status, png = get(f"{base}/api/pages/{pid}/rendered", token)
        open(os.path.join(out, "scenes", f"{pid}.json"), "wb").write(scene_raw)
        open(os.path.join(out, "rendered", f"{pid}.png"), "wb").write(png)
        texts = [o for o in scene["objects"] if o.get("kind") == "automatic_text"]
        st = [o.get("style", {}) for o in texts]
        pages.append({
            "series": title, "chapter": int(ch), "chapterId": cid, "page": int(pn), "pageId": pid, "sceneRevision": int(rev),
            "sceneSha256": hashlib.sha256(scene_raw).hexdigest(), "renderedSha256": hashlib.sha256(png).hexdigest(),
            "renderedBytes": len(png),
            "textObjects": len(texts),
            "visibleText": sum(1 for o in texts if o.get("visible", True)),
            "withMaskPolygon": sum(1 for s in st if "mask_polygon" in s),
            "ellipticalShape": sum(1 for s in st if s.get("shape") == "elliptical"),
            "rotated": sum(1 for o in texts if abs(o.get("transform", {}).get("rotation_degrees", 0)) > 3),
            "withContainer": sum(1 for o in texts if o.get("allowed_container_id")),
            "weights": sorted({s.get("weight") for s in st if s.get("weight") is not None}),
            "contractVersion": scene.get("contract_version"),
        })
        print(title, ch, pn, len(texts), flush=True)
    json.dump({"capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "pages": pages, "exports": "see README: asked for by hand, keyed exports/{chapterId}_{hash}.zip"}, open(manifest_path, "w"), indent=1)


if __name__ == "__main__":
    main()
