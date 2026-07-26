import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import UserManagementModal from "../../components/UserManagementModal";

const mockSafeFetch = vi.fn();
vi.mock("../../utils", () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}));

const mockShowToast = vi.fn();
vi.mock("../../components/ToastContext", () => ({
  useToast: () => ({
    showToast: mockShowToast,
  }),
}));

describe("UserManagementModal", () => {
  const mockUser = {
    id: "1",
    displayName: "Jane Doe",
    email: "jane@example.com",
    role: "admin",
    token: "token123",
  };

  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    user: mockUser,
    onUserUpdate: vi.fn(),
    onLogout: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders user information", () => {
    render(<UserManagementModal {...defaultProps} />);
    expect(screen.getByText("Account Settings")).toBeInTheDocument();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
  });

  it("updates display name profile", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ displayName: "Jane Updated" }),
    });

    render(<UserManagementModal {...defaultProps} />);

    const input = screen.getByPlaceholderText("Your display name");
    fireEvent.change(input, { target: { value: "Jane Updated" } });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/auth/me", expect.objectContaining({ method: "PUT" }));
      expect(defaultProps.onUserUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: "Jane Updated" }),
      );
      expect(mockShowToast).toHaveBeenCalledWith("Profile updated", "success");
    });
  });

  it("changes password successfully", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: true });

    render(<UserManagementModal {...defaultProps} />);

    const currentPwdInput = screen.getByLabelText("Current Password");
    const newPwdInput = screen.getByLabelText("New Password");

    fireEvent.change(currentPwdInput, { target: { value: "oldpass123" } });
    fireEvent.change(newPwdInput, { target: { value: "newpass123" } });

    const changeBtn = screen.getByRole("button", { name: "Change Password" });
    fireEvent.click(changeBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "/api/auth/change-password",
        expect.objectContaining({ method: "POST" }),
      );
      expect(mockShowToast).toHaveBeenCalledWith(
        "Password changed successfully",
        "success",
      );
    });
  });

  it("deletes account after confirmation", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: true });

    render(<UserManagementModal {...defaultProps} />);

    const deleteBtn = screen.getByRole("button", { name: "Delete Account" });
    fireEvent.click(deleteBtn);

    const confirmInput = screen.getByPlaceholderText('Type "DELETE" to confirm');
    fireEvent.change(confirmInput, { target: { value: "DELETE" } });

    const permDeleteBtn = screen.getByRole("button", { name: "Permanently Delete" });
    fireEvent.click(permDeleteBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/auth/me", {
        method: "DELETE",
        headers: { Authorization: "Bearer token123" },
      });
      expect(defaultProps.onLogout).toHaveBeenCalled();
    });
  });
});
