package com.manga.library.config;

import java.util.UUID;
import org.slf4j.MDC;

/**
 * The single owner of the {@code traceId} MDC key that {@code logback-spring.xml} prints on every
 * line.
 *
 * <p>The id itself is not new. {@link com.manga.library.service.JobCoordinatorService} has minted
 * one per pipeline since AUDIT-P8, keyed in Redis under {@code pipeline:trace:<imageId>}, persisted
 * to {@code jobs.trace_id} and handed to the worker in the job payload. What was missing was any
 * path from that id to a log line: before this class, following one page through the six pipeline
 * stages meant grepping an imageId plus a different jobId per stage, in two containers, and the
 * worker's output carried neither.
 *
 * <p>There are three entry points that can establish the id, and they agree on one value per
 * pipeline:
 *
 * <ul>
 *   <li>{@link TraceIdFilter} — an inbound HTTP request carrying {@value #TRACE_HEADER}. This is
 *       how the worker's six callbacks per page land under the pipeline's id.
 *   <li>{@code JobCoordinatorService.enqueueJobDirectly} — the pipeline id resolved from Redis, for
 *       work that starts from an upload rather than a callback.
 *   <li>{@code WorkerDispatcherService} — read back off the job payload, because the dispatcher runs
 *       on a scheduler thread with no request attached.
 * </ul>
 *
 * <p>Always paired with {@link #clear()} in a finally block. The MDC is a thread-local and both the
 * Tomcat exec pool and the scheduling pool are reused, so an id left behind does not go stale
 * quietly — it attaches itself to whatever unrelated work lands on that thread next, which is worse
 * than having no id at all.
 */
public final class TraceContext {

  /** MDC key. Must match the {@code %X{traceId}} conversion word in {@code logback-spring.xml}. */
  public static final String TRACE_ID = "traceId";

  /**
   * Propagation header. The worker sets this on its callbacks and status PATCHes; the backend echoes
   * it on responses so a caller can correlate from the outside.
   */
  public static final String TRACE_HEADER = "X-Trace-Id";

  private TraceContext() {}

  /**
   * Binds {@code traceId} to the current thread, ignoring null or blank input so that a caller with
   * nothing to contribute leaves an id already in place alone rather than blanking it.
   */
  public static void put(String traceId) {
    if (traceId != null && !traceId.isBlank()) {
      MDC.put(TRACE_ID, traceId);
    }
  }

  /** Binds a fresh random id, for work that has no upstream trace to inherit. */
  public static String putNew() {
    String traceId = UUID.randomUUID().toString();
    MDC.put(TRACE_ID, traceId);
    return traceId;
  }

  /** The id bound to the current thread, or null. */
  public static String current() {
    return MDC.get(TRACE_ID);
  }

  public static void clear() {
    MDC.remove(TRACE_ID);
  }
}
