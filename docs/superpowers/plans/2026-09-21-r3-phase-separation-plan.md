# R3 phase separation implementation plan

1. Add page input generation and job lease/generation columns to `database/init.sql` and
   `models.rs`; make all fresh jobs carry the values in stored worker payloads.
2. Fence internal starts, heartbeats, retries, recovery, and callback claims by the four
   identity fields. Make recovery and dispatch conditional rather than read-then-update.
3. Factor coordinator persistence so a callback transaction can insert its successor job;
   retain immediate post-commit Redis publication and use pending reconciliation after crash.
4. Make OCR atomically persist regions and layout intent; make layout atomically persist
   classifications/conversations and cleanup intent; make cleanup atomically persist results
   and translation intent.
5. Advance input generation on source/geometry redo and cancellation/deletion, while keeping
   scene revisions for editor/render freshness only.
6. Extend the isolated Postgres/Valkey integration tests for heartbeat beyond old threshold,
   death before/after commit publication, duplicate and superseded callbacks, and edit/cancel/
   delete during cleanup. Run the focused backend gate through `scripts/test-env.sh`.
