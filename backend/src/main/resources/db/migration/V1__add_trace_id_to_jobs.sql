ALTER TABLE jobs ADD COLUMN IF NOT EXISTS trace_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_jobs_trace_id ON jobs(trace_id);
