ALTER TABLE jobs ADD COLUMN trace_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_jobs_trace_id ON jobs(trace_id);
