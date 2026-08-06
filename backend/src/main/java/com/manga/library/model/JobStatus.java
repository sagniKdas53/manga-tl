package com.manga.library.model;

/**
 * The complete vocabulary of {@link Job#getStatus()}.
 *
 * <p>{@code jobs.status} stays a {@code String} column and {@code Job.status} stays a {@code
 * String} field. This enum is a <b>validator, not a mapping</b> — the entity is serialised onto
 * SSE, into Redis and into the frontend's generated schema, so changing the field's type is a
 * schema change with a blast radius well beyond AUDIT-B8. What this closes is the boundary: {@code
 * InternalJobController.updateJobStatus} used to write whatever string the worker sent straight
 * onto the row, so a typo persisted and every downstream {@code "PROCESSING".equals(...)} silently
 * stopped matching — the job then sat until {@code recoverStaleProcessingJobs} requeued it and the
 * whole OCR or translation pass ran again.
 *
 * <p>Deliberately <b>not</b> a state machine. A transition guard needs to tell a stale worker's
 * late callback from a live one, which needs job generation tracking this row does not carry
 * (AUDIT-P4 solved the duplicate-<i>result</i> half with {@code callbackAppliedAt}, not the status
 * half). Rejecting an unknown word is the part that can be done correctly here.
 */
public enum JobStatus {
  PENDING,
  PROCESSING,
  COMPLETED,
  FAILED,
  PAUSED;

  /** True when {@code status} is exactly one of these names. Case-sensitive: the writers all emit uppercase, and folding case here would hide the typo rather than reject it. */
  public static boolean isKnown(String status) {
    if (status == null) {
      return false;
    }
    for (JobStatus s : values()) {
      if (s.name().equals(status)) {
        return true;
      }
    }
    return false;
  }
}
