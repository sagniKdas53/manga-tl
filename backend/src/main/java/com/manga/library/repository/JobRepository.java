package com.manga.library.repository;

import com.manga.library.model.Job;
import java.time.OffsetDateTime;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public interface JobRepository extends JpaRepository<Job, String> {
  List<Job> findByStatusOrderByCreatedAtAsc(String status);

  List<Job> findByStatusInOrderByCreatedAtAsc(List<String> statuses);

  Job findFirstByImageIdAndTypeOrderByCreatedAtDesc(java.util.UUID imageId, String type);

  long countByStatus(String status);

  /**
   * Claims the right to apply this job's result callback, returning 1 on success and 0 if some
   * earlier callback already claimed it (AUDIT-P4).
   *
   * <p>Written as a conditional UPDATE rather than a read-then-write so the check and the set are a
   * single atomic statement. Two concurrent callbacks for the same job — which is precisely the
   * situation the recovery paths create — must not both observe a null and both proceed.
   */
  @Modifying
  @Query(
      "UPDATE Job j SET j.callbackAppliedAt = :now WHERE j.id = :id AND j.callbackAppliedAt IS NULL")
  int claimCallback(@Param("id") String id, @Param("now") OffsetDateTime now);

  /**
   * Stamps {@code started_at} without touching any other column.
   *
   * <p>Same reason as {@link #claimCallback}: a read-then-write here is a lost update. The worker
   * PATCHes PENDING → PROCESSING the instant it returns 202, which is the same instant the
   * dispatcher stamps this column. {@code Job} carries no {@code @Version} and no
   * {@code @DynamicUpdate}, so saving a detached entity merges every column back — including a
   * {@code status} read before the worker's PATCH landed, silently reverting it.
   *
   * <p>Carries its own {@code @Transactional} because the only caller — {@code
   * WorkerDispatcherService.markJobStarted}, on the scheduler thread — runs outside any transaction,
   * and a {@code @Modifying} query with no transaction throws {@code TransactionRequiredException}.
   * That exception would be swallowed by the caller's best-effort catch, leaving the column silently
   * unstamped. {@link #claimCallback} needs no such annotation: its callers are all
   * {@code @Transactional} already.
   */
  @Modifying
  @Transactional
  @Query("UPDATE Job j SET j.startedAt = :now WHERE j.id = :id")
  int markStarted(@Param("id") String id, @Param("now") OffsetDateTime now);
}
