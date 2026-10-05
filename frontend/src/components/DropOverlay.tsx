import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import UploadFileIcon from "@mui/icons-material/UploadFile";

/** Says what a drop will do, before it happens. Not interactive, so the drop lands below. */
const DropOverlay: React.FC<{
  visible: boolean;
  title: string;
  detail?: string;
}> = ({ visible, title, detail }) =>
  visible ? (
    <Box
      aria-hidden
      sx={{
        position: "fixed",
        inset: 0,
        zIndex: (t) => t.zIndex.modal + 1,
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: "rgba(10,10,10,0.72)",
        backdropFilter: "blur(4px)",
      }}
    >
      <Box
        sx={{
          px: 5,
          py: 4,
          borderRadius: "10px",
          border: "2px dashed",
          borderColor: "primary.main",
          bgcolor: "background.paper",
          textAlign: "center",
          maxWidth: 420,
        }}
      >
        <UploadFileIcon sx={{ fontSize: 40, color: "primary.main" }} />
        <Typography sx={{ fontWeight: 700, fontSize: "1.125rem", mt: 1 }}>
          {title}
        </Typography>
        {detail && (
          <Typography
            variant="body2"
            sx={{ color: "text.secondary", mt: 0.5 }}
          >
            {detail}
          </Typography>
        )}
      </Box>
    </Box>
  ) : null;

export default DropOverlay;
