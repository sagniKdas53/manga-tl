import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ToastProvider, useToast } from "../../components/ToastContext";

const TestComponent = () => {
  const { showToast, showSuccess, showError, showInfo } = useToast();
  return (
    <div>
      <button onClick={() => showToast("Success message", "success")}>Show Toast</button>
      <button onClick={() => showSuccess("Success helper")}>Show Success</button>
      <button onClick={() => showError("Error helper")}>Show Error</button>
      <button onClick={() => showInfo("Info helper", { action: { label: "Undo", onClick: vi.fn() } })}>
        Show Action
      </button>
    </div>
  );
};

describe("ToastContext", () => {
  it("renders toast notifications and removes them on timeout or click", async () => {
    vi.useFakeTimers();

    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByText("Show Toast"));
    expect(screen.getByText("Success message")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Show Success"));
    expect(screen.getByText("Success helper")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Show Error"));
    expect(screen.getByText("Error helper")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Show Action"));
    expect(screen.getByText("Info helper")).toBeInTheDocument();

    const undoBtn = screen.getByRole("button", { name: "Undo" });
    fireEvent.click(undoBtn);

    act(() => {
      vi.advanceTimersByTime(6500);
    });

    vi.useRealTimers();
  });
});
