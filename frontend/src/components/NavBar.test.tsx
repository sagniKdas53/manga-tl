import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrowserRouter } from "react-router-dom";
import { NavBar } from "./NavBar";
import { useColorMode } from "../hooks/useColorMode";

// Mock the components inside NavBar
vi.mock("./QueueManager", () => ({
  QueueManager: () => <div data-testid="queue-manager" />
}));
vi.mock("./NotificationCenter", () => ({
  NotificationCenter: () => <div data-testid="notification-center" />
}));

vi.mock("../hooks/useColorMode", () => ({
  useColorMode: vi.fn(),
}));

describe("NavBar", () => {
  const mockToggleMode = vi.fn();
  
  beforeEach(() => {
    vi.clearAllMocks();
    (useColorMode as any).mockReturnValue({
      mode: "dark",
      toggleMode: mockToggleMode,
    });
  });

  const defaultProps = {
    user: null,
    activeDrawer: "none" as const,
    setActiveDrawer: vi.fn(),
    setIsSettingsOpen: vi.fn(),
    setIsUserModalOpen: vi.fn(),
    handleLogout: vi.fn(),
  };

  const renderWithRouter = (ui: React.ReactElement) => {
    return render(<BrowserRouter>{ui}</BrowserRouter>);
  };

  it("renders basic elements when no user is logged in", () => {
    renderWithRouter(<NavBar {...defaultProps} />);
    
    expect(screen.getByText("tl-hub")).toBeInTheDocument();
    expect(screen.getByTitle("Switch to Light Mode")).toBeInTheDocument();
    
    // Authenticated components shouldn't be rendered
    expect(screen.queryByTestId("queue-manager")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notification-center")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Settings")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Account")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Sign Out")).not.toBeInTheDocument();
  });

  it("renders all elements when user is logged in", () => {
    renderWithRouter(<NavBar {...defaultProps} user={{ id: "1", token: "tok" } as any} />);
    
    expect(screen.getByText("tl-hub")).toBeInTheDocument();
    expect(screen.getByTitle("Switch to Light Mode")).toBeInTheDocument();
    
    // Authenticated components should be rendered
    expect(screen.getByTestId("queue-manager")).toBeInTheDocument();
    expect(screen.getByTestId("notification-center")).toBeInTheDocument();
    expect(screen.getByTitle("Settings")).toBeInTheDocument();
    expect(screen.getByTitle("Account")).toBeInTheDocument();
    expect(screen.getByTitle("Sign Out")).toBeInTheDocument();
  });

  it("calls appropriate handlers on click", () => {
    renderWithRouter(<NavBar {...defaultProps} user={{ id: "1", token: "tok" } as any} />);
    
    fireEvent.click(screen.getByTitle("Settings"));
    expect(defaultProps.setIsSettingsOpen).toHaveBeenCalledWith(true);
    
    fireEvent.click(screen.getByTitle("Account"));
    expect(defaultProps.setIsUserModalOpen).toHaveBeenCalledWith(true);
    
    fireEvent.click(screen.getByTitle("Sign Out"));
    expect(defaultProps.handleLogout).toHaveBeenCalled();
    
    fireEvent.click(screen.getByTitle("Switch to Light Mode"));
    expect(mockToggleMode).toHaveBeenCalled();
  });
});
