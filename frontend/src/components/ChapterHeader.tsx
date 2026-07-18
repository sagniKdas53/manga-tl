import React from "react";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import EditIcon from "@mui/icons-material/Edit";
import type { Series, Chapter } from "../types";

export interface ChapterHeaderProps {
  selectedSeries: Series;
  selectedChapter: Chapter;
  onBack: () => void;
  onEditClick: () => void;
  onImportClick: () => void;
  onExportClick: () => void;
  onUploadClick: () => void;
  isImporting: boolean;
  mode: "light" | "dark";
}

const ChapterHeader: React.FC<ChapterHeaderProps> = ({
  selectedSeries,
  selectedChapter,
  onBack,
  onEditClick,
  onImportClick,
  onExportClick,
  onUploadClick,
  isImporting,
  mode,
}) => {
  return (
    <div>
      <Button
        variant="outlined"
        size="small"
        onClick={onBack}
        sx={{ mb: 2 }}
      >
        ← Back to Series
      </Button>
      <div className="page-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <Typography
              variant="h4"
              sx={{ fontFamily: '"Outfit", sans-serif', fontWeight: 600, color: mode === "dark" ? "white" : "black" }}
            >
              Chapter {selectedChapter.chapterNumber}
            </Typography>
            <IconButton
              onClick={onEditClick}
              title="Edit Chapter Name & Number"
              size="small"
            >
              <EditIcon fontSize="small" />
            </IconButton>
          </div>
          <p style={{ color: "var(--text-muted)", margin: "8px 0 0" }}>
            {selectedSeries.title} / {selectedChapter.title || "Untitled"}
          </p>
        </div>
        <Stack
          direction="row"
          spacing={1}
        >
          <Button
            variant="outlined"
            size="small"
            onClick={onImportClick}
            disabled={isImporting}
          >
            {isImporting ? "Importing..." : "Import Project (ZIP)"}
          </Button>
          <Button
            variant="outlined"
            size="small"
            onClick={onExportClick}
          >
            Export Chapter (ZIP)
          </Button>
          <Button
            variant="contained"
            size="small"
            onClick={onUploadClick}
          >
            Upload Page
          </Button>
        </Stack>
      </div>
    </div>
  );
};

export default React.memo(ChapterHeader);
