# Page Scene v1 contract

`page-scene-v1.schema.json` is the authoritative structural contract. It is **new-format only**: readers reject every other `contract_version`; no legacy project reader, geometry default, converter, or renderer fallback is permitted.

## Logical versus resolved scenes

A `logical` scene is the backend-derived immutable snapshot for one `page.revision`. It holds OCR fragments, independent owners, source-space cleanup assets, policy decisions and editable objects. It is the only scene representation that an editor or API write may accept.

A `resolved` scene is renderer output for one logical scene. It repeats the immutable logical snapshot and adds `resolved_layout`; it is not independently editable and must never be written back as source of truth. The resolver must preserve every logical object ID and return diagnostics rather than silently clipping, merging, or changing policy.

## Required semantics beyond JSON Schema

Consumers MUST enforce these cross-record invariants:

1. Each fragment belongs to exactly one owner. Every owner has exactly one policy. `confidence: 0` is valid.
2. An explicit non-null `user_override` is the effective action. Only effective `replace` authorizes an automatic text object or cleanup artifact. `preserve`, `review`, and `explain` create neither automatic cleanup nor automatic text. `explain` is note-only.
3. Every cleanup artifact names the source hash, known owner IDs, existing mask/patch assets, generator digest, source-space bounds, and its independent or joint active-set dependency. Cleanup geometry, restoration pixels, and text layout geometry are separate fields.
4. Automatic text is non-empty and linked to its owner and cleanup. A manual cleanup is `kind: manual_cleanup`; an empty automatic object is invalid. A manual text object may be empty while it is being authored.
5. Coordinates are finite source-pixel floats. `rotation_degrees`, writing mode, alignment, style, font ID, fill, stroke, weight and padding are explicit. `allowed_container_id` does not enlarge cleanup support.
6. A resolved layout contains no new editable objects. Its `logical_scene_sha256` is the digest of the logical projection defined below.

## Canonical digest rules

- A binary asset digest is lowercase SHA-256 over its exact bytes. `byte_length` is the byte count before transport encoding.
- A logical scene digest is lowercase SHA-256 over the RFC 8785 (JCS) UTF-8 serialization of the logical projection. For a resolved scene, make that projection by removing `resolved_layout` and setting `scene_kind` to `logical` before canonicalization.
- Do not serialize a scene digest inside the logical projection. A render job carries the resulting digest separately; a resolved scene repeats it only as `resolved_layout.logical_scene_sha256`.
- All JSON numbers MUST be finite. Producers MUST retain fractional source-pixel geometry and signed rotation; consumers MUST reject non-finite, missing, or out-of-range geometry rather than coercing it.
- Render input identity is the logical-scene digest plus referenced asset digests. A renderer result identifies the exact input digest, page revision, renderer build, browser build, effective font file digests, and lossless PNG digest.

## Render job and archive envelopes

The backend/worker transport uses these envelopes in B03–B05:

```json
{"contract_version":"page-scene/v1","job_id":"...","page_id":"...","page_revision":3,"logical_scene_sha256":"...","scene":{}}
```

A successful result replaces `scene` with `rendered_png` (`sha256`, `byte_length`, `mime_type`), `logical_scene_sha256`, `page_revision`, `renderer_build`, `browser_build`, `font_sha256s`, and `diagnostics`. Latest pointers may advance only when page revision and logical-scene digest match the queued job.

A new project archive contains the immutable source bytes, one logical scene, every referenced cleanup/font asset by digest, and settings. Import validates every digest and rejects unsupported versions. It does not convert historical archives.

## Fixture suite

`fixtures/page-scene-v1/` contains valid logical, resolved, fractional-rotation/empty-manual, and joint-overlap scenes. `invalid-cases.json` applies RFC 6901-style mutations to the valid scene so each failure is both concise and executable: unsupported version, non-finite geometry, empty automatic text, preserved action with cleanup, missing asset, wrong source, and resolved data in a logical scene.

Run `node contracts/validate-page-scene-v1.cjs`. The runner validates schema and semantic invariants. Run it after copying only `contracts/` to a fresh directory with `AJV_MODULE` pointing to an installed Ajv module; this proves the artifacts neither read old project data nor depend on a parent-path schema link.
