import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MoveChapterDialog } from "../../components/MoveChapterDialog";
import type { Chapter, Series, User } from "../../types";

const mockSafeFetch = vi.fn();
vi.mock("../../utils", () => ({
  safeFetch: (url: string, options?: RequestInit) =>
    mockSafeFetch(url, options),
}));

const user = { token: "t", role: "translator" } as unknown as User;
const from = {
  id: "s1",
  title: "One Piece",
  originalLanguage: "ja",
  sourceLanguage: "ja",
  targetLanguage: "en",
  readingDirection: "rtl",
  kind: "series",
} as Series;
const naruto = { ...from, id: "s2", title: "Naruto" } as Series;
const korean = {
  ...from,
  id: "s3",
  title: "Solo Leveling",
  sourceLanguage: "ko",
  originalLanguage: "ko",
} as Series;
const chapter = {
  id: "c6",
  seriesId: "s1",
  chapterNumber: 6,
  title: "",
} as Chapter;

const ok = (body: unknown, status = 200) =>
  Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  });

const pick = async (name: string) => {
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "Move to" }));
  fireEvent.click(await screen.findByRole("option", { name }));
};

const moveBody = () => {
  const [, init] = mockSafeFetch.mock.calls.find(([url]) =>
    String(url).endsWith("/move"),
  )!;
  return JSON.parse(init.body as string);
};

describe("MoveChapterDialog", () => {
  beforeEach(() => {
    mockSafeFetch.mockReset();
    mockSafeFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/series?"))
        return ok({ content: [from, naruto, korean] });
      if (url.startsWith("/api/series/s2/chapters"))
        return ok({ content: [{ chapterNumber: 6 }, { chapterNumber: 7.5 }] });
      if (url.startsWith("/api/series/s3/chapters")) return ok({ content: [] });
      if (url.endsWith("/move"))
        return ok({ chapter: { ...chapter, seriesId: "s2" }, series: naruto });
      return Promise.reject(new Error(`unexpected ${url}`));
    });
  });

  it("moves into another series, suggesting the next free number when its own is taken", async () => {
    const onMoved = vi.fn();
    render(
      <MoveChapterDialog
        open
        onClose={vi.fn()}
        user={user}
        chapter={chapter}
        series={from}
        onMoved={onMoved}
      />,
    );
    // Only series (no one-shots) are listed, and never the chapter's own.
    await waitFor(() =>
      expect(mockSafeFetch.mock.calls[0][0]).toContain("kind=series"),
    );
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Move to" }));
    expect(
      await screen.findByRole("option", { name: "Library (as a one-shot)" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "One Piece" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Naruto" }));

    const number = await screen.findByLabelText(/Chapter number/);
    await waitFor(() => expect(number).toHaveValue(8));

    // A taken number is shown before confirming, and Move waits for a free one.
    fireEvent.change(number, { target: { value: "6" } });
    expect(
      screen.getByText(/Naruto already has chapter 6. Next free: 8./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();
    fireEvent.change(number, { target: { value: "9" } });

    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    expect(moveBody()).toEqual({
      seriesId: "s2",
      chapterNumber: 9,
      keepSettings: true,
    });
  });

  it("moves out to the library as a one-shot, and can let the new series' settings apply", async () => {
    const onMoved = vi.fn();
    render(
      <MoveChapterDialog
        open
        onClose={vi.fn()}
        user={user}
        chapter={chapter}
        series={from}
        onMoved={onMoved}
      />,
    );
    await pick("Library (as a one-shot)");
    expect(screen.queryByLabelText(/Chapter number/)).toBeNull();
    expect(screen.getByText("One Piece — Chapter 6")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Keep this chapter's models and settings",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    expect(moveBody()).toEqual({ oneshot: true, keepSettings: false });
  });

  it("does not offer the library to a chapter that is already a one-shot", async () => {
    render(
      <MoveChapterDialog
        open
        onClose={vi.fn()}
        user={user}
        chapter={chapter}
        series={{ ...from, kind: "oneshot" }}
        onMoved={vi.fn()}
      />,
    );
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Move to" }));
    expect(
      await screen.findByRole("option", { name: "Naruto" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Library (as a one-shot)" }),
    ).toBeNull();
  });

  it("says when the destination translates other languages, and still allows the move", async () => {
    render(
      <MoveChapterDialog
        open
        onClose={vi.fn()}
        user={user}
        chapter={chapter}
        series={from}
        onMoved={vi.fn()}
      />,
    );
    await pick("Solo Leveling");
    expect(
      await screen.findByText(
        /Solo Leveling translates ko → en; this chapter was translated ja → en/,
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Move" })).toBeEnabled(),
    );
  });

  it("takes the server's next free number when the number was taken meanwhile", async () => {
    mockSafeFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/series?")) return ok({ content: [korean] });
      if (url.startsWith("/api/series/s3/chapters")) return ok({ content: [] });
      if (url.endsWith("/move"))
        return ok(
          {
            message: "Chapter 6 already exists in Solo Leveling.",
            nextFreeNumber: 12,
          },
          409,
        );
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const onMoved = vi.fn();
    render(
      <MoveChapterDialog
        open
        onClose={vi.fn()}
        user={user}
        chapter={chapter}
        series={from}
        onMoved={onMoved}
      />,
    );
    await pick("Solo Leveling");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Move" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(
      await screen.findByText("Chapter 6 already exists in Solo Leveling."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Chapter number/)).toHaveValue(12);
    expect(onMoved).not.toHaveBeenCalled();
  });
});
