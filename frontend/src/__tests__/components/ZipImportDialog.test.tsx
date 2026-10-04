import JSZip from "jszip";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZipImportDialog } from "../../components/ZipImportDialog";
import type { Series, User } from "../../types";

const mockSafeFetch = vi.fn();
vi.mock("../../utils", () => ({
  safeFetch: (url: string, options?: RequestInit) =>
    mockSafeFetch(url, options),
}));

vi.mock("../../components/chapterNumbering", () => ({
  fetchHighestChapterNumber: vi.fn(() => Promise.resolve(7)),
}));

// The overrides panel has its own tests and fetches; here it only has to be present.
vi.mock("../../components/ModelOverridesAccordion", () => ({
  default: () => <div>Model overrides</div>,
}));

const user = { token: "t", role: "admin" } as unknown as User;
const series = {
  id: "s1",
  title: "One Piece",
  sourceLanguage: "ja",
  targetLanguage: "en",
  readingDirection: "rtl",
  useFallbackModels: null,
} as unknown as Series;

const archiveFile = async () => {
  const zip = new JSZip();
  zip.file("ch/1.png", "one");
  zip.file("ch/2.png", "two");
  zip.file("ch/10.png", "ten");
  zip.file("__MACOSX/ch/._1.png", "junk");
  const blob = await zip.generateAsync({ type: "blob" });
  return new File([blob], "Romance Dawn.zip", { type: "application/zip" });
};

const ok = (body: unknown) =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  });

/** Pages of the archive the dialog uploaded, in the order the backend will import them. */
const uploadedPages = async (formData: FormData) => {
  const file = formData.get("file") as File;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const names = Object.keys(zip.files).sort();
  return Promise.all(names.map((name) => zip.file(name)!.async("string")));
};

describe("ZipImportDialog", () => {
  beforeEach(() => {
    mockSafeFetch.mockReset();
    mockSafeFetch.mockImplementation((url: string) => {
      if (url === "/api/settings") return ok({});
      if (url.startsWith("/api/series?")) return ok({ content: [series] });
      if (url === "/api/series")
        return ok({ ...series, id: "new", title: "Brand new" });
      if (url.endsWith("/chapters/import"))
        return ok({ id: "c1", chapterNumber: 8 });
      return Promise.reject(new Error(`unexpected ${url}`));
    });
  });

  it("shows the archive's pages in the order the backend would use, without the junk", async () => {
    render(
      <ZipImportDialog
        open
        onClose={vi.fn()}
        user={user}
        series={series}
        initialFile={await archiveFile()}
        onImported={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("3 of 3 pages")).toBeInTheDocument(),
    );
    const pages = screen
      .getAllByRole("listitem")
      .map((el) => el.getAttribute("aria-label"));
    expect(pages).toEqual(["Page 1, 1.png", "Page 2, 2.png", "Page 3, 10.png"]);
    // The next chapter number comes from the server, not the loaded list (AUDIT-F18).
    await waitFor(() =>
      expect(screen.getByLabelText(/Chapter number/)).toHaveValue(8),
    );
  });

  it("uploads only the kept pages, in the order shown", async () => {
    const onImported = vi.fn();
    render(
      <ZipImportDialog
        open
        onClose={vi.fn()}
        user={user}
        series={series}
        initialFile={await archiveFile()}
        onImported={onImported}
      />,
    );
    await waitFor(() => screen.getByText("3 of 3 pages"));

    fireEvent.click(screen.getByRole("button", { name: "Remove 2.png" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Move 10.png earlier" }),
    );
    // 2.png is removed but still listed, so 10.png now sits between 1.png and it.
    fireEvent.click(
      screen.getByRole("button", { name: "Move 10.png earlier" }),
    );
    expect(screen.getByText("2 of 3 pages")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Import 2 pages" }));

    await waitFor(() => expect(onImported).toHaveBeenCalled());
    const [, init] = mockSafeFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/chapters/import"),
    )!;
    const body = init.body as FormData;
    expect(await uploadedPages(body)).toEqual(["ten", "one"]);
    expect(body.get("chapterNumber")).toBe("8");
    expect(onImported).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1" }),
      series,
      2,
    );
  });

  it("creates a new series with the languages picked, then imports into it", async () => {
    render(
      <ZipImportDialog
        open
        onClose={vi.fn()}
        user={user}
        initialFile={await archiveFile()}
        onImported={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText("3 of 3 pages"));

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Into" }));
    fireEvent.click(await screen.findByRole("option", { name: "New series…" }));
    // The title is proposed from the file name.
    expect(screen.getByLabelText(/Series title/)).toHaveValue("Romance Dawn");

    fireEvent.mouseDown(
      screen.getByRole("combobox", { name: "Translate from" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "ko" }));

    fireEvent.click(screen.getByRole("button", { name: "Import 3 pages" }));

    await waitFor(() =>
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "/api/series/new/chapters/import",
        expect.anything(),
      ),
    );
    const [, createInit] = mockSafeFetch.mock.calls.find(
      ([url, init]) => url === "/api/series" && init?.method === "POST",
    )!;
    expect(JSON.parse(createInit.body as string)).toMatchObject({
      title: "Romance Dawn",
      sourceLanguage: "ko",
      targetLanguage: "en",
      readingDirection: "rtl",
    });
  });

  it("sends the archive untouched when no page was removed or moved", async () => {
    const file = await archiveFile();
    render(
      <ZipImportDialog
        open
        onClose={vi.fn()}
        user={user}
        series={series}
        initialFile={file}
        onImported={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText("3 of 3 pages"));
    fireEvent.click(screen.getByRole("button", { name: "Import 3 pages" }));

    await waitFor(() =>
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "/api/series/s1/chapters/import",
        expect.anything(),
      ),
    );
    const [, init] = mockSafeFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/chapters/import"),
    )!;
    const sent = (init.body as FormData).get("file") as File;
    expect(sent.name).toBe("Romance Dawn.zip");
    expect(sent.size).toBe(file.size);
  });

  it("does not create a second series when a failed upload is retried", async () => {
    let uploads = 0;
    mockSafeFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/settings") return ok({});
      if (url.startsWith("/api/series?")) return ok({ content: [series] });
      if (url === "/api/series" && init?.method === "POST")
        return ok({ ...series, id: "new", title: "Romance Dawn" });
      if (url.endsWith("/chapters/import")) {
        uploads += 1;
        return uploads === 1
          ? Promise.resolve({
              ok: false,
              json: () => Promise.resolve({}),
              text: () => Promise.resolve('{"message":"storage unavailable"}'),
            })
          : ok({ id: "c1", chapterNumber: 1 });
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const onImported = vi.fn();
    render(
      <ZipImportDialog
        open
        onClose={vi.fn()}
        user={user}
        initialFile={await archiveFile()}
        onImported={onImported}
      />,
    );
    await waitFor(() => screen.getByText("3 of 3 pages"));
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Into" }));
    fireEvent.click(await screen.findByRole("option", { name: "New series…" }));

    fireEvent.click(screen.getByRole("button", { name: "Import 3 pages" }));
    expect(await screen.findByText("storage unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Import 3 pages" }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());

    const creates = mockSafeFetch.mock.calls.filter(
      ([url, init]) => url === "/api/series" && init?.method === "POST",
    );
    expect(creates).toHaveLength(1);
    expect(mockSafeFetch).toHaveBeenLastCalledWith(
      "/api/series/new/chapters/import",
      expect.anything(),
    );
  });

  it("takes a file dropped anywhere while open as a new archive, without leaving the app", async () => {
    render(
      <ZipImportDialog
        open
        onClose={vi.fn()}
        user={user}
        series={series}
        initialFile={await archiveFile()}
        onImported={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText("3 of 3 pages"));

    const zip = new JSZip();
    zip.file("a.png", "a");
    zip.file("b.png", "b");
    const replacement = new File(
      [await zip.generateAsync({ type: "blob" })],
      "Other chapter.zip",
    );
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { types: ["Files"], files: [replacement] },
    });
    window.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
    expect(await screen.findByText("2 of 2 pages")).toBeInTheDocument();
    expect(screen.getByText("Other chapter.zip")).toBeInTheDocument();
  });

  it("says when a dropped file is not an archive", async () => {
    render(
      <ZipImportDialog
        open
        onClose={vi.fn()}
        user={user}
        series={series}
        onImported={vi.fn()}
      />,
    );
    // Let the dialog finish resetting itself after opening (it clears old errors).
    await act(async () => {});
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { types: ["Files"], files: [new File(["x"], "page.png")] },
    });
    window.dispatchEvent(drop);
    expect(
      await screen.findByText("Choose a .zip, .cbz or .epub file."),
    ).toBeInTheDocument();
  });

  it("refuses a page-project archive and says where it goes instead", async () => {
    const zip = new JSZip();
    zip.file("project.json", "{}");
    zip.file("original.png", "x");
    const file = new File(
      [await zip.generateAsync({ type: "blob" })],
      "page.zip",
    );

    render(
      <ZipImportDialog
        open
        onClose={vi.fn()}
        user={user}
        series={series}
        initialFile={file}
        onImported={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/This is a page project archive/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });
});
