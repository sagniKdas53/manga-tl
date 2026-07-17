import React from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";

export interface InfoModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  type?: "success" | "error" | "info";
  onClose: () => void;
}

const InfoModal: React.FC<InfoModalProps> = ({
  isOpen,
  title,
  message,
  type = "info",
  onClose,
}) => {
  const Icon =
    type === "success"
      ? CheckCircleIcon
      : type === "error"
        ? ErrorIcon
        : InfoOutlinedIcon;

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      aria-labelledby="info-dialog-title"
      aria-describedby="info-dialog-description"
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle
        id="info-dialog-title"
        sx={{ display: "flex", alignItems: "center", gap: 1.5 }}
      >
        <Icon color={type} />
        {title}
      </DialogTitle>
      <DialogContent>
        <DialogContentText id="info-dialog-description">
          {message}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} variant="contained" autoFocus>
          OK
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default InfoModal;
