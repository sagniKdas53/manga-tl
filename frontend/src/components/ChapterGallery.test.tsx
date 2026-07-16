import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ChapterGallery from "./ChapterGallery";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

const mockSafeFetch = vi.fn();
vi.mock("../utils", () => ({
  safeFetch: (url: string, ...args: unknown[]) => {
    if (typeof url === "string" && url.includes("/api/settings")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ocrProvider: "local",
            ocrVlmModelList: ["model-ocr-1"],
            tlProvider: "openrouter",
            tlLlmModelList: ["model-tl-1"],
            qaProvider: "openrouter",
            qaLlmModelList: ["model-qa-llm-1"],
            qaVlmModelList: ["model-qa-vlm-1"],
          }),
      });
    }
    return mockSafeFetch(url, ...args);
  },
  toSlug: (s: string) => s.toLowerCase().replace(/\s+/g, "-"),
  getContextPath: () => "",
}));

vi.mock("./ToastContext", () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

describe("ChapterGallery Component", () => {
  const mockUser = {
    id: "1",
    username: "testuser",
    email: "test@test.com",
    role: "translator",
    token: "token123",
  };

  const mockSeries = {
    id: "s1",
    title: "One Piece",
    coverImageUrl: "http://example.com/op.jpg",
    readingDirection: "rtl",
    sourceLanguage: "ja",
    targetLanguage: "en",
    chaptersCount: 1,
    imageId: "img1",
    slug: "one-piece",
  };

  const mockChapter = {
    id: "c1",
    seriesId: "s1",
    chapterNumber: 1,
    title: "Romance Dawn",
    status: "PENDING",
    pagesCount: 1,
  };

  const mockPages = [
    {
      id: "p1",
      chapterId: "c1",
      pageNumber: 1,
      imageId: "img1",
      status: "PENDING",
      imagePath: "/path/to/img",
      processingProgress: 0,
      url: "http://example.com/p1.jpg",
    },
  ];

  const mockSetSelectedChapter = vi.fn();
  const mockSetPages = vi.fn();
  const mockOnSelectPage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeFetch.mockReset();
  });

  it("renders chapter details and pages", () => {
    render(
      <ChapterGallery
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        setSelectedChapter={mockSetSelectedChapter}
        pages={mockPages}
        setPages={mockSetPages}
        onSelectPage={mockOnSelectPage}
        isLoadingDetails={false}
      />,
    );

    expect(screen.getByText("Chapter 1")).toBeInTheDocument();
    expect(screen.getByText("One Piece / Romance Dawn")).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("clicks page thumbnail to open in reader", () => {
    render(
      <ChapterGallery
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        setSelectedChapter={mockSetSelectedChapter}
        pages={mockPages}
        setPages={mockSetPages}
        onSelectPage={mockOnSelectPage}
        isLoadingDetails={false}
      />,
    );

    const thumbnail = screen.getByAltText("Page 1");
    fireEvent.click(thumbnail);

    expect(mockOnSelectPage).toHaveBeenCalledWith(mockPages[0]);
    expect(mockNavigate).toHaveBeenCalledWith(
      "/chapters/c1/romance-dawn/reader/1",
    );
  });

  it("opens edit chapter name modal and saves updates", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ ...mockChapter, title: "Romance Dawn Updated" }),
    });

    render(
      <ChapterGallery
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        setSelectedChapter={mockSetSelectedChapter}
        pages={mockPages}
        setPages={mockSetPages}
        onSelectPage={mockOnSelectPage}
        isLoadingDetails={false}
      />,
    );

    const editBtn = screen.getByTitle("Edit Chapter Name & Number");
    fireEvent.click(editBtn);

    expect(
      screen.getByRole("heading", { name: "Edit Chapter" }),
    ).toBeInTheDocument();

    const titleInput = screen.getByDisplayValue("Romance Dawn");
    fireEvent.change(titleInput, { target: { value: "Romance Dawn Updated" } });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/series/chapters/c1", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer token123`,
        },
        body: JSON.stringify({
          chapterNumber: 1,
          title: "Romance Dawn Updated",
          useContextMemory: true,
          ocrProvider: null,
          ocrModel: null,
          tlProvider: null,
          tlModel: null,
          qaProvider: null,
          qaLlmModel: null,
          qaVlmModel: null,
          qaMode: null,
        }),
      });
      expect(mockSetSelectedChapter).toHaveBeenCalled();
    });
  });

  it("handles deleting a page", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: true });
    // For the refresh fetch
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    render(
      <ChapterGallery
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        setSelectedChapter={mockSetSelectedChapter}
        pages={mockPages}
        setPages={mockSetPages}
        onSelectPage={mockOnSelectPage}
        isLoadingDetails={false}
      />,
    );

    const deleteBtn = screen.getByTitle("Delete page");
    fireEvent.click(deleteBtn);

    const confirmBtns = screen.getAllByRole("button", { name: "Delete Page" });
    const confirmBtn = confirmBtns[confirmBtns.length - 1];
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "/api/pages/p1",
        expect.objectContaining({
          method: "DELETE",
        }),
      );
      expect(mockSetPages).toHaveBeenCalled();
    });
  });

  it("handles exporting chapter zip", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: () => "application/zip",
      },
      blob: () =>
        Promise.resolve(new Blob(["dummy"], { type: "application/zip" })),
    });

    global.URL.createObjectURL = vi.fn(() => "blob:http://localhost/dummy");
    global.URL.revokeObjectURL = vi.fn();

    render(
      <ChapterGallery
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        setSelectedChapter={mockSetSelectedChapter}
        pages={mockPages}
        setPages={mockSetPages}
        onSelectPage={mockOnSelectPage}
        isLoadingDetails={false}
      />,
    );

    const exportBtn = screen.getByRole("button", {
      name: "Export Chapter (ZIP)",
    });
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "/api/series/chapters/c1/export?format=zip",
        expect.any(Object),
      );
      expect(global.URL.createObjectURL).toHaveBeenCalled();
    });
  });

  it("handles moving a page left and right", async () => {
    mockSafeFetch.mockResolvedValue({ ok: true });

    const twoPages = [
      { ...mockPages[0], id: "p1", pageNumber: 1 },
      { ...mockPages[0], id: "p2", pageNumber: 2 },
    ];

    render(
      <ChapterGallery
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        setSelectedChapter={mockSetSelectedChapter}
        pages={twoPages}
        setPages={mockSetPages}
        onSelectPage={mockOnSelectPage}
        isLoadingDetails={false}
      />,
    );

    const moveRightBtns = screen.getAllByTitle("Move page right");
    // Click move right on the first page
    fireEvent.click(moveRightBtns[0]);

    await waitFor(() => {
      expect(mockSetPages).toHaveBeenCalled();
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "/api/chapters/c1/pages/reorder",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify(["p2", "p1"]),
        }),
      );
    });
  });

  it("handles project import", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: true }); // for import
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    }); // for pages refresh

    render(
      <ChapterGallery
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        setSelectedChapter={mockSetSelectedChapter}
        pages={mockPages}
        setPages={mockSetPages}
        onSelectPage={mockOnSelectPage}
        isLoadingDetails={false}
      />,
    );
    const projInput = document.querySelector(
      "#project-import-upload",
    ) as HTMLInputElement;
    const file = new File(["1"], "proj.zip", { type: "application/zip" });
    fireEvent.change(projInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "/api/chapters/c1/import-project",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("handles uploading multiple pages with progress", async () => {
    const sendMock = vi.fn(function (this: XMLHttpRequest) {
      if (this.upload && this.upload.onprogress) {
        this.upload.onprogress({
          lengthComputable: true,
          loaded: 50,
          total: 100,
        });
      }
      this.status = 200;
      if (this.onload) this.onload();
    });

    const XHRMock = vi.fn().mockImplementation(function (this: XMLHttpRequest) {
      this.open = vi.fn();
      this.send = sendMock;
      this.setRequestHeader = vi.fn();
      this.upload = { onprogress: null };
      this.status = 200;
      this.onload = null;
    });

    vi.stubGlobal("XMLHttpRequest", XHRMock);

    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    }); // for pages refresh

    render(
      <ChapterGallery
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        setSelectedChapter={mockSetSelectedChapter}
        pages={mockPages}
        setPages={mockSetPages}
        onSelectPage={mockOnSelectPage}
        isLoadingDetails={false}
      />,
    );

    const fileInput = document.querySelector(
      "#file-upload",
    ) as HTMLInputElement;
    const files = [
      new File(["1"], "page1.jpg", { type: "image/jpeg" }),
    ] as unknown as FileList;
    files.item = (i: number) => files[i];

    fireEvent.change(fileInput, { target: { files } });

    // Check that xhr.send was called
    await waitFor(() => {
      expect(sendMock).toHaveBeenCalled();
    });

    // Wait for pages refresh
    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "/api/chapters/c1/pages",
        expect.any(Object),
      );
    });
  });

  it("handles edit chapter failure", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: false,
      text: () => Promise.resolve("Validation error"),
    });

    render(
      <ChapterGallery
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        setSelectedChapter={mockSetSelectedChapter}
        pages={mockPages}
        setPages={mockSetPages}
        onSelectPage={mockOnSelectPage}
        isLoadingDetails={false}
      />,
    );

    const editBtn = screen.getByTitle("Edit Chapter Name & Number");
    fireEvent.click(editBtn);

    const titleInput = screen.getByDisplayValue("Romance Dawn");
    fireEvent.change(titleInput, { target: { value: "Romance Dawn Failed" } });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText("Validation error")).toBeInTheDocument();
    });
  });
});
