import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ReaderTopNav from "./ReaderTopNav";

describe("ReaderTopNav", () => {
  it("renders correctly", () => {
    render(
      <ReaderTopNav
        title="Test Title"
        onBack={vi.fn()}
        onToggleLeftSidebar={vi.fn()}
        onToggleRightSidebar={vi.fn()}
      />
    );
    expect(screen.getByText("Test Title")).toBeInTheDocument();
  });

  it("calls callbacks when buttons are clicked", () => {
    const onBack = vi.fn();
    const onToggleLeftSidebar = vi.fn();
    const onToggleRightSidebar = vi.fn();

    render(
      <ReaderTopNav
        title="Test Title"
        onBack={onBack}
        onToggleLeftSidebar={onToggleLeftSidebar}
        onToggleRightSidebar={onToggleRightSidebar}
      />
    );

    fireEvent.click(screen.getByTitle("Back"));
    expect(onBack).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("Settings"));
    expect(onToggleLeftSidebar).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("Right Sidebar"));
    expect(onToggleRightSidebar).toHaveBeenCalled();
  });
});
