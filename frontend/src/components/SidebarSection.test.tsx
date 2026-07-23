import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import SidebarSection from "./SidebarSection";

describe("SidebarSection", () => {
  it("renders children", () => {
    render(<SidebarSection>content</SidebarSection>);
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("renders title when provided", () => {
    render(<SidebarSection title="My Title">content</SidebarSection>);
    expect(screen.getByText("My Title")).toBeInTheDocument();
  });

  it("does not render title section when omitted", () => {
    const { container } = render(<SidebarSection>content</SidebarSection>);
    expect(container.querySelector("span")).toBeNull();
  });

  it("renders headerExtra when provided", () => {
    render(
      <SidebarSection
        title="T"
        headerExtra={<button>Extra</button>}
      >
        content
      </SidebarSection>,
    );
    expect(screen.getByText("Extra")).toBeInTheDocument();
  });
});
