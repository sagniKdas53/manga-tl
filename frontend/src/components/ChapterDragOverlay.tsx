import React from "react";
import Backdrop from "@mui/material/Backdrop";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";

export interface ChapterDragOverlayProps {
  visible: boolean;
  chapterNumber: number;
}

const ChapterDragOverlay: React.FC<ChapterDragOverlayProps> = ({
  visible,
  chapterNumber,
}) => {
  if (!visible) return null;

  return (
    <Backdrop
      open
      // Not interactive — it only reports that a drop is possible, and swallowing pointer
      // events here would stop the drop landing on the page underneath.
      sx={{
        zIndex: 10000,
        pointerEvents: "none",
        m: 2,
        borderRadius: 4,
        border: "4px dashed",
        borderColor: "primary.main",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
    >
      <Paper
        elevation={24}
        sx={{
          px: { xs: 4, sm: 7.5 },
          py: 5,
          borderRadius: 2.5,
          textAlign: "center",
          maxWidth: "min(90vw, 480px)",
        }}
      >
        <Stack
          alignItems="center"
          spacing={2}
        >
          <Box
            sx={{
              width: 60,
              height: 60,
              borderRadius: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              // The theme's own primary, at low alpha, so this reads correctly in both modes.
              bgcolor: (theme) => theme.palette.action.selected,
              color: "primary.main",
            }}
          >
            <FileUploadOutlinedIcon fontSize="large" />
          </Box>
          <Typography
            variant="h6"
            component="h2"
            sx={{ fontWeight: 700 }}
          >
            Drop Manga Pages Anywhere
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
          >
            Release to add multiple files to Chapter {chapterNumber}
          </Typography>
        </Stack>
      </Paper>
    </Backdrop>
  );
};

export default React.memo(ChapterDragOverlay);
