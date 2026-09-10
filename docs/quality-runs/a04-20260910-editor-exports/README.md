# A04 — editor and export capture attempt

This run directory is reserved for the six A03 baseline projects. Capture did not
produce browser or PNG/ZIP artifacts because the current isolated stack required
credentials that were not available to the runner. No source files or application
behavior were changed.

## Inputs

Source run: `../a03-20260910-fresh-admin/manifest.json`

Expected projects/pages: `sample177`, `sample222`, `sample61`, `sample99`, `sample93`, `sample83`.

## Attempt result

`capture_exports.cjs --help` completed successfully. The browser check against the
default port first returned `ERR_CONNECTION_REFUSED`; the live stack was then
verified at `http://localhost:18080/tlhub` and all five Compose services were
healthy. An access-recovery probe registered a unique disposable `translator`
account; its generated password was held only in-process and was neither printed
nor persisted. Authenticated series/chapter listing returned only the `sample83`
chapter: the other five A03 series had empty chapter lists. The prior A03 admin
password remains unavailable, and the repository credential returned HTTP 401.

Therefore the six requested A03 chapter records are not all present in the
current isolated database, so editor/export capture remains blocked.

Effective system font probes were recorded in A04.md; no run-specific browser font
or export artifact could be captured.
