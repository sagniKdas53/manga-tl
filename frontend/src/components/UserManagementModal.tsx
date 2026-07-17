import React, { useState } from "react";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Alert from "@mui/material/Alert";
import Divider from "@mui/material/Divider";
import type { User } from "../types";
import { safeFetch } from "../utils";
import { useToast } from "./ToastContext";

interface UserManagementModalProps {
  open: boolean;
  onClose: () => void;
  user: User;
  onUserUpdate: (user: User) => void;
  onLogout: () => void;
}

export const UserManagementModal: React.FC<UserManagementModalProps> = ({
  open,
  onClose,
  user,
  onUserUpdate,
  onLogout,
}) => {
  const { showToast } = useToast();

  const [displayName, setDisplayName] = useState(user.displayName || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleUpdateProfile = async () => {
    try {
      const res = await safeFetch("/api/auth/me", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({ displayName }),
      });
      if (res.ok) {
        const data = await res.json();
        onUserUpdate({ ...user, displayName: data.displayName });
        showToast("Profile updated", "success");
      } else if (res.status === 401) {
        showToast("Session expired, please log in again", "error");
        onLogout();
      } else {
        showToast("Failed to update profile", "error");
      }
    } catch {
      showToast("Network error", "error");
    }
  };

  const handleChangePassword = async () => {
    setPasswordError("");
    if (!currentPassword) {
      setPasswordError("Current password is required");
      return;
    }
    if (!newPassword || newPassword.length < 6) {
      setPasswordError("New password must be at least 6 characters");
      return;
    }
    try {
      const res = await safeFetch("/api/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.ok) {
        showToast("Password changed successfully", "success");
        setCurrentPassword("");
        setNewPassword("");
      } else if (res.status === 403) {
        setPasswordError("Current password is incorrect");
      } else if (res.status === 401) {
        showToast("Session expired, please log in again", "error");
        onLogout();
      } else {
        const data = await res.json().catch(() => ({}));
        setPasswordError(data.message || "Failed to change password");
      }
    } catch {
      setPasswordError("Network error");
    }
  };

  const handleDeleteAccount = async () => {
    try {
      const res = await safeFetch("/api/auth/me", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${user.token}` },
      });
      if (res.ok) {
        showToast("Account deleted", "info");
        onLogout();
      } else {
        showToast("Failed to delete account", "error");
      }
    } catch {
      showToast("Network error", "error");
    }
  };

  const initials = (user.displayName || user.email || "?").substring(0, 2).toUpperCase();

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Account Settings</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 3 }}>
          <Avatar sx={{ width: 56, height: 56, fontSize: 24, bgcolor: "primary.main" }}>
            {initials}
          </Avatar>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>{user.displayName}</Typography>
            <Typography variant="body2" color="text.secondary">{user.email}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: "capitalize" }}>
              Role: {user.role}
            </Typography>
          </Box>
        </Box>

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Display Name</Typography>
        <Box sx={{ display: "flex", gap: 1, mb: 3 }}>
          <TextField
            size="small"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            fullWidth
            placeholder="Your display name"
          />
          <Button variant="outlined" size="small" onClick={handleUpdateProfile}>
            Save
          </Button>
        </Box>

        <Divider sx={{ my: 2 }} />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Change Password</Typography>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <TextField
            size="small"
            type="password"
            label="Current Password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            fullWidth
          />
          <TextField
            size="small"
            type="password"
            label="New Password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            fullWidth
            helperText="At least 6 characters"
          />
          {passwordError && <Alert severity="error" sx={{ py: 0 }}>{passwordError}</Alert>}
          <Button variant="outlined" color="primary" size="small" onClick={handleChangePassword}>
            Change Password
          </Button>
        </Box>

        <Divider sx={{ my: 2 }} />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, color: "error.main", mb: 1 }}>Danger Zone</Typography>
        {!showDeleteConfirm ? (
          <Button
            variant="outlined"
            color="error"
            size="small"
            onClick={() => setShowDeleteConfirm(true)}
          >
            Delete Account
          </Button>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <DialogContentText>
              Type <strong>DELETE</strong> to confirm account deletion. This action cannot be undone.
            </DialogContentText>
            <TextField
              size="small"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder='Type "DELETE" to confirm'
              fullWidth
            />
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button
                variant="contained"
                color="error"
                size="small"
                disabled={deleteConfirmText !== "DELETE"}
                onClick={handleDeleteAccount}
              >
                Permanently Delete
              </Button>
              <Button
                variant="outlined"
                size="small"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmText("");
                }}
              >
                Cancel
              </Button>
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};
