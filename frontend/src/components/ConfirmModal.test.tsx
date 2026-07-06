import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ConfirmModal from "./ConfirmModal";

describe("ConfirmModal", () => {
  const defaultProps = {
    isOpen: true,
    title: "Test Title",
    message: "Test Message",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render when isOpen is false", () => {
    const { container } = render(
      <ConfirmModal
        {...defaultProps}
        isOpen={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders correct title and message", () => {
    render(<ConfirmModal {...defaultProps} />);
    expect(screen.getByText("Test Title")).toBeInTheDocument();
    expect(screen.getByText("Test Message")).toBeInTheDocument();
  });

  it("calls onCancel when Cancel button is clicked", () => {
    render(<ConfirmModal {...defaultProps} />);
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);
    expect(defaultProps.onCancel).toHaveBeenCalled();
  });

  it("calls onConfirm when Confirm button is clicked", () => {
    render(<ConfirmModal {...defaultProps} />);
    const confirmBtn = screen.getByRole("button", { name: /confirm/i });
    fireEvent.click(confirmBtn);
    expect(defaultProps.onConfirm).toHaveBeenCalled();
  });

  it("closes on Escape key down", () => {
    render(<ConfirmModal {...defaultProps} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(defaultProps.onCancel).toHaveBeenCalled();
  });

  it("renders isDangerous mode and handles button hover states", () => {
    render(
      <ConfirmModal
        {...defaultProps}
        isDangerous={true}
      />,
    );

    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    const confirmBtn = screen.getByRole("button", { name: /confirm/i });

    // Hover events for cancel button
    fireEvent.mouseEnter(cancelBtn);
    expect(cancelBtn.style.background).toBe("var(--bg-hover-more)");
    fireEvent.mouseLeave(cancelBtn);
    expect(cancelBtn.style.background).toBe("var(--bg-hover)");

    // Hover events for confirm button
    fireEvent.mouseEnter(confirmBtn);
    expect(confirmBtn.style.opacity).toBe("0.88");
    fireEvent.mouseLeave(confirmBtn);
    expect(confirmBtn.style.opacity).toBe("1");
  });
});
