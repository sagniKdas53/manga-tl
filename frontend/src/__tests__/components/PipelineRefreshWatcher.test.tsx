import { render } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import PipelineRefreshWatcher from "../../components/PipelineRefreshWatcher";

const mockSubscribe = vi.fn();
vi.mock("../../components/useNotifications", () => ({
  useNotifications: () => ({ notifications: [], subscribe: mockSubscribe }),
}));

type SSEEvent = { type: string; data: string };

/**
 * AUDIT-F19. The grids rendered whatever their first fetch returned and nothing ever asked again —
 * no subscription, no background poll — so a chapter that finished translating while its page was
 * open kept showing untranslated thumbnails until a manual reload.
 */
describe("PipelineRefreshWatcher", () => {
  let emit: (event: SSEEvent) => void = () => {};
  const unsubscribe = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockSubscribe.mockImplementation((cb: (event: SSEEvent) => void) => {
      emit = cb;
      return unsubscribe;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const jobUpdate = (status: string) => ({
    type: "job_update",
    data: JSON.stringify({ status, imageId: "img1" }),
  });

  it("re-reads once after a burst settles, not once per event", () => {
    // A chapter run emits hundreds of these — one per stage per page. Refreshing on each would put
    // the grid's whole loaded window back on the wire dozens of times a minute.
    const onPipelineActivity = vi.fn();
    render(<PipelineRefreshWatcher onPipelineActivity={onPipelineActivity} />);

    for (let i = 0; i < 25; i++) emit(jobUpdate("COMPLETED"));
    expect(onPipelineActivity).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4000);
    expect(onPipelineActivity).toHaveBeenCalledTimes(1);
  });

  it("re-reads on a failure too — a red page is a change the grid should show", () => {
    const onPipelineActivity = vi.fn();
    render(<PipelineRefreshWatcher onPipelineActivity={onPipelineActivity} />);

    emit(jobUpdate("FAILED"));
    vi.advanceTimersByTime(4000);
    expect(onPipelineActivity).toHaveBeenCalledTimes(1);
  });

  it("ignores a job merely starting", () => {
    const onPipelineActivity = vi.fn();
    render(<PipelineRefreshWatcher onPipelineActivity={onPipelineActivity} />);

    emit(jobUpdate("PENDING"));
    emit(jobUpdate("PROCESSING"));
    vi.advanceTimersByTime(4000);
    expect(onPipelineActivity).not.toHaveBeenCalled();
  });

  it("ignores unrelated events and malformed payloads", () => {
    const onPipelineActivity = vi.fn();
    render(<PipelineRefreshWatcher onPipelineActivity={onPipelineActivity} />);

    emit({ type: "notification", data: '{"type":"SUCCESS"}' });
    emit({ type: "job_update", data: "not json" });
    vi.advanceTimersByTime(4000);
    expect(onPipelineActivity).not.toHaveBeenCalled();
  });

  // AUDIT-F27. The 4s window only coalesces events that arrive inside it. AUDIT-W13 made a
  // context-injecting chapter translate strictly in page order, so completions now land tens of
  // seconds apart — each settling its own timer and firing its own full loaded-window refresh.
  describe("a slow drip is bounded too, not just a burst", () => {
    it("does not re-read once per page when completions are further apart than the window", () => {
      const onPipelineActivity = vi.fn();
      render(<PipelineRefreshWatcher onPipelineActivity={onPipelineActivity} />);

      // Ten pages, each finishing 10s after the last — a serialized chapter. Without a floor this
      // is ten refreshes, each re-requesting every loaded pagination batch.
      for (let i = 0; i < 10; i++) {
        emit(jobUpdate("COMPLETED"));
        vi.advanceTimersByTime(10000);
      }

      // The first is prompt; the rest collapse onto the 30s cadence rather than one per page.
      expect(onPipelineActivity.mock.calls.length).toBeLessThanOrEqual(4);
      expect(onPipelineActivity).toHaveBeenCalled();
    });

    it("still re-reads promptly for the first completion after mount", () => {
      const onPipelineActivity = vi.fn();
      render(<PipelineRefreshWatcher onPipelineActivity={onPipelineActivity} />);

      emit(jobUpdate("COMPLETED"));
      vi.advanceTimersByTime(4000);
      expect(onPipelineActivity).toHaveBeenCalledTimes(1);
    });

    it("holds a completion that lands inside the cooldown until the cooldown ends", () => {
      const onPipelineActivity = vi.fn();
      render(<PipelineRefreshWatcher onPipelineActivity={onPipelineActivity} />);

      emit(jobUpdate("COMPLETED"));
      vi.advanceTimersByTime(4000);
      expect(onPipelineActivity).toHaveBeenCalledTimes(1);

      // A second page finishes 5s later. It must not refresh now...
      vi.advanceTimersByTime(5000);
      emit(jobUpdate("COMPLETED"));
      vi.advanceTimersByTime(4000);
      expect(onPipelineActivity).toHaveBeenCalledTimes(1);

      // ...but it must not be dropped either: the last page of a chapter is always followed by a
      // re-read, once the floor allows one.
      vi.advanceTimersByTime(30000);
      expect(onPipelineActivity).toHaveBeenCalledTimes(2);
    });
  });

  it("does not fire after unmount", () => {
    const onPipelineActivity = vi.fn();
    const { unmount } = render(
      <PipelineRefreshWatcher onPipelineActivity={onPipelineActivity} />,
    );

    emit(jobUpdate("COMPLETED"));
    unmount();
    vi.advanceTimersByTime(4000);

    expect(onPipelineActivity).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
