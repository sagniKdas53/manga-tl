import React, { useEffect, useRef } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';

export interface InfoModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  type?: "success" | "error" | "info" | "warning";
  onClose: () => void;
}

const InfoModal: React.FC<InfoModalProps> = ({
  isOpen,
  title,
  message,
  type = "info",
  onClose,
}) => {
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => okRef.current?.focus(), 50);
    }
  }, [isOpen]);

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      aria-labelledby="info-dialog-title"
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle id="info-dialog-title">{title}</DialogTitle>
      <DialogContent>
        <Alert severity={type as "success" | "error" | "info" | "warning"}>
          {message}
        </Alert>
      </DialogContent>
      <DialogActions>
        <Button ref={okRef} onClick={onClose} variant="contained" color={type === "error" ? "error" : type === "success" ? "success" : "primary"}>
          OK
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default InfoModal;
