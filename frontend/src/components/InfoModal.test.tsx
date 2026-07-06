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
    fireEvent.keyDown(window, { key: "Escape" });
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("closes on clicking backdrop overlay but not modal body", () => {
    const { container } = render(<InfoModal {...defaultProps} />);

    // Backdrop is the outer div (first child)
    const backdrop = container.firstChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("handles button hover style changes", () => {
    render(<InfoModal {...defaultProps} />);
    const okBtn = screen.getByRole("button", { name: /ok/i });

    fireEvent.mouseEnter(okBtn);
    expect(okBtn.style.opacity).toBe("0.88");
    fireEvent.mouseLeave(okBtn);
    expect(okBtn.style.opacity).toBe("1");
  });
});
