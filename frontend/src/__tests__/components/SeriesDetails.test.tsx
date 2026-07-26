import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import SeriesDetails from "../../components/SeriesDetails";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("../../components/ToastContext", () => ({
  useToast: () => ({
    showToast: vi.fn(),
    showError: vi.fn(),
  }),
}));

vi.mock("../../utils", () => ({
  safeFetch: () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    }),
  toSlug: (s: string) => s.toLowerCase(),
  resolveOverride: (_v1: unknown, v2: unknown) => ({ value: String(v2 || ""), source: "series" }),
}));

describe("SeriesDetails", () => {
  const mockUser = {
    id: "1",
    username: "test",
    email: "t@t.com",
    displayName: "test",
    role: "translator",
    token: "tok123",
  };

  const mockSeries = {
    id: "s1",
    title: "Bleach",
    originalLanguage: "ja",
    readingDirection: "rtl",
  };

  const mockChapters = [
    {
      id: "c1",
      seriesId: "s1",
      chapterNumber: 1,
      title: "The Substitute",
    },
  ];

  const mockSetSelectedSeries = vi.fn();
  const mockSetChapters = vi.fn();
  const mockOnSelectChapter = vi.fn();

  it("renders loading spinner when loading or no selected series", () => {
    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={null}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={[]}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={true}
      />,
    );

    expect(screen.getByText("Loading series details...")).toBeInTheDocument();
  });

  it("renders series details and chapters when data is available", () => {
    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    expect(screen.getAllByText("Bleach").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("The Substitute")).toBeInTheDocument();
  });

  it("navigates back to library on click", () => {
    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    fireEvent.click(screen.getByText("← Back to Library"));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  it("opens add chapter dialog", () => {
    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Add Chapter/ }));
    expect(screen.getByRole("heading", { name: "Add Chapter" })).toBeInTheDocument();
  });

  it("opens import chapter dialog", () => {
    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Import Chapter/ }));
    expect(screen.getByRole("heading", { name: /Import Chapter/ })).toBeInTheDocument();
  });

  it("opens edit series dialog", () => {
    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Edit Series/ }));
    expect(screen.getByRole("heading", { name: "Edit Series" })).toBeInTheDocument();
  });

  it("opens delete confirm modal on delete series click", () => {
    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    const deleteBtn = screen.getByRole("button", { name: /Delete Series/ });
    fireEvent.click(deleteBtn);

    expect(screen.getByText(/Are you sure you want to delete this series/)).toBeInTheDocument();
  });
});
