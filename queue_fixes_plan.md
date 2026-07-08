# Plan: Queue Architecture & Reliability Fixes

This document outlines a comprehensive plan to resolve the underlying issues with the job queue architecture, worker crash recovery, and the user experience (UX) of the Queue Manager and Notification Manager.

## 1. Issue: Permanent "PROCESSING" State (Stuck Jobs)

**Problem:** Currently, if a worker container crashes (e.g., runs out of memory, or receives a `SIGTERM`) while a job is in the `PROCESSING` state, the job remains stuck as `PROCESSING` indefinitely. The `JobCoordinatorService` only resets these jobs to `PENDING` on application startup. If the backend does not restart, the queue appears permanently stuck.

**Proposed Solution:**

* **Backend Timeout CRON:** Implement a scheduled cron task in the **Spring Boot backend** (`JobCoordinatorService`) running every 5 minutes. It will find any job in the `PROCESSING` state where `updated_at` is older than a specified threshold (e.g., 10 minutes) and reset it to `PENDING` (or `FAILED` if it exceeds max attempts). This is simpler and more robust than implementing a constant heartbeat.

## 2. Issue: Confusing Queue Progression & Notification Swarm

**Problem:**

* The pipeline spawns a brand new job ID for every stage of the image's lifecycle (`panel-detection` → `ocr` → `layout` → `translation` → `render` → `qa`), so the total queue count doesn't accurately reflect remaining images.
* The user is swamped with individual notifications for every intermediate stage of the pipeline completing.

**Proposed Solution:**

* **Single Job Entity per Image:** Instead of creating a new row in the `job` table for each step, create a single `Job` entity per image (e.g., `JobType: image-pipeline`).
* **Track Sub-status:** Add a `stage` or `sub_status` column to the `job` table (e.g., `status: PROCESSING, stage: QA`).
* **Update Queue UI:** The `QueueManager` frontend will show one entry per image with a progress indicator (e.g., "Processing Image 12 (Stage 6/6: QA)"). This guarantees the queue badge decreases predictably as images fully complete.
* **Consolidated Notifications:** Implement the same grouping logic for the **Notification Manager**. Stop emitting notifications for intermediate stages. Instead:
  * Emit a single "Page Completed" notification when the *entire pipeline* (including QA) is finished for an image.
  * Emit a separate "Manual Review Needed" notification only if the QA explicitly fails and requires user intervention.

## 3. Issue: QA Job Visibility & Integration

**Problem:** QA jobs involve LLM network requests and can take time, sometimes appearing as a bottleneck at the end of the pipeline.

**Proposed Solution:**

* **Retain in Main Loop:** QA remains an integral part of the main pipeline and will stay in the unified queue.
* **Optimize Where Possible:** Review the QA prompts and network call configurations in the worker to see if latency can be reduced. However, if it remains slow, it will simply process sequentially as designed. The consolidated UI and notifications (from Issue 2) will ensure that users are clearly informed that QA is currently running as part of the overall page progress, making the wait time transparent and acceptable.

## 4. Implementation Steps

1. **Phase 1: Backend Recovery CRON (Quick Win)**
    * Add a `@Scheduled` method in Spring Boot to sweep stale `PROCESSING` jobs every 5 minutes.
2. **Phase 2: Notification Consolidation**
    * Update backend SSE logic to stop emitting intermediate success toasts, moving to a single "Page Completed" or "Action Required" model.
3. **Phase 3: Pipeline Refactor & Queue Grouping**
    * Refactor `JobCoordinatorService` to reuse the same `Job` ID across the pipeline lifecycle, updating a `current_stage` field. Update the frontend `QueueManager.tsx` to display this unified progress.
