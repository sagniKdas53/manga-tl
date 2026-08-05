import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { UploadProvider, useUploadQueue } from "../../components/UploadContext";

function TestUploadConsumer() {
  const { items, addItems, updateItem, dismiss } = useUploadQueue();
  return (
    <div>
      <span data-testid="items-count">{items.length}</span>
      <button
        onClick={() =>
          addItems([{ id: "u1", name: "page1.jpg", progress: 0, status: "pending" }])
        }
      >
        Add Item
      </button>
      <button onClick={() => updateItem("u1", { progress: 100, status: "completed" })}>
        Complete Item
      </button>
      <button onClick={() => dismiss()}>Dismiss</button>
    </div>
  );
}

describe("UploadProvider & Context", () => {
  it("manages upload queue items", () => {
    render(
      <UploadProvider>
        <TestUploadConsumer />
      </UploadProvider>,
    );

    expect(screen.getByTestId("items-count")).toHaveTextContent("0");

    fireEvent.click(screen.getByText("Add Item"));
    expect(screen.getByTestId("items-count")).toHaveTextContent("1");
    expect(screen.getByText("page1.jpg")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByText("Complete Item"));
    });
    expect(screen.getByText("completed")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.getByTestId("items-count")).toHaveTextContent("0");
  });

  // AUDIT-F6: both were icon-only with no accessible name. The expand one also carries
  // aria-expanded, since its label changes with the state it reports.
  it("names the panel's icon-only controls", () => {
    render(
      <UploadProvider>
        <TestUploadConsumer />
      </UploadProvider>,
    );
    fireEvent.click(screen.getByText("Add Item"));

    const collapse = screen.getByRole("button", { name: "Collapse upload list" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Dismiss uploads" }),
    ).toBeInTheDocument();

    fireEvent.click(collapse);
    expect(
      screen.getByRole("button", { name: "Expand upload list" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});
