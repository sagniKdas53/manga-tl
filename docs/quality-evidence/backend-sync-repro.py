"""Execute current dirty-page SQL in an isolated SQLite database, no services.

This proves query/ID and timestamp-predicate behavior, not an Axum/Postgres/queue
integration. SQL is read from current source; SQLite supplies a deterministic now().
Run: .venv/bin/python docs/quality-evidence/backend-sync-repro.py
"""

import json
import re
import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parents[2]
layers = (root / 'backend-rust/src/routes/layers.rs').read_text()
recovery = (root / 'backend-rust/src/jobs/recovery.rs').read_text()
handler = layers.split('pub async fn update_layer_element(', 1)[1].split('/// GET ', 1)[0]
assert 'touch_page(&state.pool, id).await;' in handler
query = re.search(r'"(UPDATE pages SET last_edited_at = now\(\).*?)"', layers).group(1)
assert 'WHERE id = $1' in query and 'SELECT page_id FROM layers' in query
assert 'UPDATE pages SET last_rendered_at = now() WHERE id = $1' in recovery
assert 'last_edited_at > last_rendered_at' in recovery

db = sqlite3.connect(':memory:')
db.create_function('now', 0, lambda: 20)
db.executescript('''
CREATE TABLE pages (id TEXT PRIMARY KEY, last_edited_at INTEGER, last_rendered_at INTEGER);
CREATE TABLE layers (id TEXT PRIMARY KEY, page_id TEXT);
CREATE TABLE layer_elements (id TEXT PRIMARY KEY, layer_id TEXT);
INSERT INTO pages VALUES ('page-1', 1, 2);
INSERT INTO layers VALUES ('layer-1', 'page-1');
INSERT INTO layer_elements VALUES ('element-1', 'layer-1');
''')
wrong = db.execute(query, {'1': 'element-1'}).rowcount
unchanged = db.execute('SELECT last_edited_at FROM pages').fetchone()[0]
right = db.execute(query, {'1': 'layer-1'}).rowcount
updated = db.execute('SELECT last_edited_at FROM pages').fetchone()[0]
assert (wrong, unchanged, right, updated) == (0, 1, 1, 20)

# Exactly the pending-render predicate from recovery.rs, with a future threshold.
pending = 'SELECT id FROM pages WHERE last_edited_at IS NOT NULL AND last_edited_at < $1 AND (last_rendered_at IS NULL OR last_edited_at > last_rendered_at)'
before_enqueue = len(db.execute(pending, {'1': 40}).fetchall())
db.execute('UPDATE pages SET last_rendered_at = now() WHERE id = $1', {'1': 'page-1'})
after_enqueue_without_completion = len(db.execute(pending, {'1': 40}).fetchall())
assert (before_enqueue, after_enqueue_without_completion) == (1, 0)

result = {'boundary': 'Current source SQL on isolated SQLite; not a Postgres/API integration',
          'touch_query': query, 'element_id_rows_updated': wrong, 'timestamp_after_element_id': unchanged,
          'layer_id_rows_updated': right, 'timestamp_after_layer_id': updated,
          'pending_before_enqueue': before_enqueue,
          'pending_after_enqueue_without_completion': after_enqueue_without_completion}
target = Path(__file__).with_name('backend-sync-results.json')
target.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
