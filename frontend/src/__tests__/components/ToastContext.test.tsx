import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ToastProvider, useToast } from "../../components/ToastContext";

const TestComponent = () => {
  const { showToast } = useToast();
  return (
    <div>
      <button onClick={() => showToast("Success message", "success")}>Show Success</button>
      <button onClick={() => showToast("Error message", "error")}>Show Error</button>
      <button onClick={() => showToast("Info message", "info")}>Show Info</button>
    </div>
  );
};

describe("ToastContext", () => {
  it("renders toast notifications and removes them on timeout or click", async () => {
    vi.useFakeTimers();

    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText("Show Success"));
    expect(screen.getByText("Success message")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Show Error"));
    expect(screen.getByText("Error message")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4500);
    });

    vi.useRealTimers();
  });
});
