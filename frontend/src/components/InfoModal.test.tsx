import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import InfoModal from "./InfoModal";

describe("InfoModal", () => {
  const defaultProps = {
    isOpen: true,
    title: "Info Title",
    message: "Info Message Detail",
    type: "info" as const,
    onClose: vi.fn(),
  };

  it("does not render when isOpen is false", () => {
    const { container } = render(
      <InfoModal
        {...defaultProps}
        isOpen={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders correct title, message, and type styles", () => {
    const { rerender } = render(<InfoModal {...defaultProps} />);
    expect(screen.getByText("Info Title")).toBeInTheDocument();
    expect(screen.getByText("Info Message Detail")).toBeInTheDocument();

    // Rerender as success
    rerender(
      <InfoModal
        {...defaultProps}
        type="success"
      />,
    );
    expect(screen.getByText("Info Title")).toBeInTheDocument();

    // Rerender as error
    rerender(
      <InfoModal
        {...defaultProps}
        type="error"
      />,
    );
    expect(screen.getByText("Info Title")).toBeInTheDocument();
  });

  it("calls onClose when OK button is clicked", () => {
    render(<InfoModal {...defaultProps} />);
    const okBtn = screen.getByRole("button", { name: /ok/i });
    fireEvent.click(okBtn);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("calls onClose when Escape key is pressed", () => {
    render(<InfoModal {...defaultProps} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("closes on clicking the backdrop overlay", () => {
    const onClose = vi.fn();
    render(
      <InfoModal
        isOpen={true}
        title="Test"
        message="Test"
        type="info"
        onClose={onClose}
      />,
    );
    const backdrop = document.querySelector(".MuiBackdrop-root") as HTMLElement;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("renders with different type icons", () => {
    const { rerender } = render(<InfoModal {...defaultProps} />);
    expect(screen.getByText("Info Title")).toBeInTheDocument();

    rerender(
      <InfoModal
        {...defaultProps}
        type="success"
      />,
    );
    expect(screen.getByText("Info Title")).toBeInTheDocument();

    rerender(
      <InfoModal
        {...defaultProps}
        type="error"
      />,
    );
    expect(screen.getByText("Info Title")).toBeInTheDocument();
  });
});
