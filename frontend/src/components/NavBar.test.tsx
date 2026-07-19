import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrowserRouter } from "react-router-dom";
import { NavBar } from "./NavBar";
import { useColorMode } from "../hooks/useColorMode";

// Mock the components inside NavBar
vi.mock("./QueueManager", () => ({
  QueueManager: ({ onRequestOpen, onClose }: any) => (
    <div data-testid="queue-manager">
      <button onClick={onRequestOpen} data-testid="qm-open" />
      <button onClick={onClose} data-testid="qm-close" />
    </div>
  )
}));
vi.mock("./NotificationCenter", () => ({
  NotificationCenter: ({ onRequestOpen, onClose }: any) => (
    <div data-testid="notification-center">
      <button onClick={onRequestOpen} data-testid="nc-open" />
      <button onClick={onClose} data-testid="nc-close" />
    </div>
  )
}));

vi.mock("../hooks/useColorMode", () => ({
  useColorMode: vi.fn(),
}));

describe("NavBar", () => {
  const mockToggleMode = vi.fn();
  
  beforeEach(() => {
    vi.clearAllMocks();
    (useColorMode as import("vitest").Mock).mockReturnValue({
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
    renderWithRouter(<NavBar {...defaultProps} user={{ id: "1", token: "tok" } as import("../types").User} />);
    
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
    renderWithRouter(<NavBar {...defaultProps} user={{ id: "1", token: "tok" } as import("../types").User} />);
    
    fireEvent.click(screen.getByTitle("Settings"));
    expect(defaultProps.setIsSettingsOpen).toHaveBeenCalledWith(true);
    
    fireEvent.click(screen.getByTitle("Account"));
    expect(defaultProps.setIsUserModalOpen).toHaveBeenCalledWith(true);
    
    fireEvent.click(screen.getByTitle("Sign Out"));
    expect(defaultProps.handleLogout).toHaveBeenCalled();
    
    fireEvent.click(screen.getByTitle("Switch to Light Mode"));
    expect(mockToggleMode).toHaveBeenCalled();
  });

  it("handles drawer interactions and navigation", () => {
    renderWithRouter(<NavBar {...defaultProps} user={{ id: "1", token: "tok" } as import("../types").User} />);
    
    // Test navigation click on logo
    fireEvent.click(screen.getByText("tl-hub"));

    // Test QueueManager interactions
    fireEvent.click(screen.getByTestId("qm-open"));
    expect(defaultProps.setActiveDrawer).toHaveBeenCalledWith("queue");
    
    fireEvent.click(screen.getByTestId("qm-close"));
    expect(defaultProps.setActiveDrawer).toHaveBeenCalledWith("none");
    
    // Test NotificationCenter interactions
    fireEvent.click(screen.getByTestId("nc-open"));
    expect(defaultProps.setActiveDrawer).toHaveBeenCalledWith("notifications");
    
    fireEvent.click(screen.getByTestId("nc-close"));
    expect(defaultProps.setActiveDrawer).toHaveBeenCalledWith("none");
  });
});
