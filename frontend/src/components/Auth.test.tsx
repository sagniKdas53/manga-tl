import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Auth from "./Auth";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

const mockSafeFetch = vi.fn();
vi.mock("../utils", () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}));

describe("Auth Component", () => {
  const mockOnLoginSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeFetch.mockReset();
    // Default mock response for setup-required check
    mockSafeFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ setupRequired: false }),
    });
  });

  it("renders login form by default", () => {
    render(<Auth onLoginSuccess={mockOnLoginSuccess} />);
    expect(screen.getByText("Welcome Back")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("admin@manga.local"),
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("John Doe")).not.toBeInTheDocument();
  });

  it("toggles to sign up form", async () => {
    render(<Auth onLoginSuccess={mockOnLoginSuccess} />);
    const toggleBtn = screen.getByText("Don't have an account? Sign Up");
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(screen.getByText("Create Account")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("John Doe")).toBeInTheDocument();
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/auth/setup-required");
    });
  });

  it("submits login details successfully", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "u1",
          username: "user",
          email: "user@test.com",
          token: "tok",
        }),
    });

    render(<Auth onLoginSuccess={mockOnLoginSuccess} />);

    fireEvent.change(screen.getByPlaceholderText("admin@manga.local"), {
      target: { value: "user@test.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), {
      target: { value: "password123" },
    });

    const submitBtn = screen.getByRole("button", { name: /sign in/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "user@test.com",
          password: "password123",
        }),
      });
      expect(mockOnLoginSuccess).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith("/");
    });
  });

  it("handles auth error message on login failure", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: false,
      text: () => Promise.resolve("Invalid credentials"),
    });

    render(<Auth onLoginSuccess={mockOnLoginSuccess} />);

    fireEvent.change(screen.getByPlaceholderText("admin@manga.local"), {
      target: { value: "wrong@test.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), {
      target: { value: "wrongpass" },
    });

    const submitBtn = screen.getByRole("button", { name: /sign in/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
    });
  });

  it("handles setup-required network error during sign up switch", async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSafeFetch.mockRejectedValueOnce(new Error("Network err"));
    render(<Auth onLoginSuccess={mockOnLoginSuccess} />);
    fireEvent.click(screen.getByText("Don't have an account? Sign Up"));
    
    await waitFor(() => {
      expect(screen.getByText("Create Account")).toBeInTheDocument();
    });
    consoleSpy.mockRestore();
  });

  it("renders setupRequired warning if no users exist", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ setupRequired: true }),
    });
    render(<Auth onLoginSuccess={mockOnLoginSuccess} />);
    fireEvent.click(screen.getByText("Don't have an account? Sign Up"));
    
    await waitFor(() => {
      expect(screen.getByText(/First user registration forces Admin privileges/i)).toBeInTheDocument();
    });
    
    fireEvent.change(screen.getByLabelText(/Display Name/i), { target: { value: "New Admin" } });
  });

  it("allows selecting a role when setup is not required", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ setupRequired: false }),
    });
    render(<Auth onLoginSuccess={mockOnLoginSuccess} />);
    fireEvent.click(screen.getByText("Don't have an account? Sign Up"));
    
    const select = await screen.findByRole("combobox");
    
    fireEvent.change(screen.getByLabelText(/Display Name/i), { target: { value: "New User" } });
    
    fireEvent.mouseDown(select);
    
    const viewerOption = await screen.findByRole("option", { name: /Viewer/i });
    fireEvent.click(viewerOption);
  });
});
