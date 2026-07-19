import React from "react";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import EditIcon from "@mui/icons-material/Edit";
import UploadIcon from "@mui/icons-material/Upload";
import DownloadIcon from "@mui/icons-material/Download";
import DeleteIcon from "@mui/icons-material/Delete";
import type { Series, Chapter } from "../types";

export interface ChapterHeaderProps {
  selectedSeries: Series;
  selectedChapter: Chapter;
  onBack: () => void;
  onEditClick: () => void;
  onImportClick: () => void;
  onExportClick: () => void;
  onUploadClick: () => void;
  onDeleteClick: () => void;
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
  onDeleteClick,
  isImporting,
}) => {
  return (
    <Box sx={{ mb: 4 }}>
      <Button
        variant="outlined"
        size="small"
        onClick={onBack}
        sx={{ mb: 2 }}
      >
        ← Back to Series
      </Button>

      <Card elevation={3}>
        <CardContent sx={{ p: 0, "&:last-child": { pb: 0 } }}>
          <Grid container spacing={0}>
            {/* Cover/Thumbnail column matching Series header for uniformity */}
            <Grid size={{ xs: 12, sm: 4, md: 3, lg: 2.5 }}>
              <Box
                sx={{
                  width: "100%",
                  height: "100%",
                  minHeight: { xs: 200, sm: 250 },
                  maxHeight: { xs: 300, sm: 350 },
                  backgroundColor: "background.default",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRight: (theme) => ({ sm: `1px solid ${theme.palette.divider}` }),
                  borderBottom: (theme) => ({ xs: `1px solid ${theme.palette.divider}`, sm: "none" }),
                  overflow: "hidden",
                }}
              >
                {selectedChapter.coverImageUrl ? (
                  <Box
                    component="img"
                    src={selectedChapter.coverImageUrl}
                    alt={selectedChapter.title || `Chapter ${selectedChapter.chapterNumber}`}
                    sx={{
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                    }}
                  />
                ) : (
                  <Typography variant="body1" color="text.secondary">
                    Chapter {selectedChapter.chapterNumber}
                  </Typography>
                )}
              </Box>
            </Grid>

            {/* Info Column */}
            <Grid size={{ xs: 12, sm: 8, md: 9, lg: 9.5 }}>
              <Box sx={{ p: { xs: 2, sm: 3 }, display: "flex", flexDirection: "column", height: "100%" }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
                  <Typography variant="h4" component="h1" sx={{ fontWeight: "bold", fontFamily: '"Outfit", sans-serif' }}>
                    Chapter {selectedChapter.chapterNumber}
                  </Typography>
                  <IconButton onClick={onEditClick} title="Edit Chapter Name & Number" size="small">
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Box>
                <Typography variant="body1" color="text.secondary" gutterBottom>
                  {selectedSeries.title} {selectedChapter.title ? `/ ${selectedChapter.title}` : ""}
                </Typography>

                <Grid container spacing={2} sx={{ mt: 1, mb: 3 }}>
                  <Grid item>
                    <Typography variant="body2" color="text.secondary" gutterBottom>
                      Pages
                    </Typography>
                    <Typography variant="body1" fontWeight="medium">
                      {selectedChapter.pageCount || 0}
                    </Typography>
                  </Grid>
                  <Grid item>
                    <Typography variant="body2" color="text.secondary" gutterBottom>
                      Context Injection
                    </Typography>
                    <Chip size="small" label={selectedChapter.useContextMemory ? "Enabled" : "Disabled"} color={selectedChapter.useContextMemory ? "success" : "default"} />
                  </Grid>
                </Grid>

                {/* Models Info */}
                <Box sx={{ mb: 3 }}>
                  <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                    Configured Models
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                    {selectedChapter.resolvedOcr?.model && (
                      <Chip size="small" variant="outlined" label={`OCR: ${selectedChapter.resolvedOcr.model}`} />
                    )}
                    {selectedChapter.resolvedTranslation?.model && (
                      <Chip size="small" variant="outlined" label={`Translation: ${selectedChapter.resolvedTranslation.model}`} />
                    )}
                    {selectedChapter.resolvedQa?.llmModel && (
                      <Chip size="small" variant="outlined" label={`QA: ${selectedChapter.resolvedQa.llmModel}`} />
                    )}
                    {!selectedChapter.resolvedOcr?.model && !selectedChapter.resolvedTranslation?.model && !selectedChapter.resolvedQa?.llmModel && (
                      <Typography variant="body2" color="text.disabled">
                        Using Default Models
                      </Typography>
                    )}
                  </Stack>
                </Box>

                <Box sx={{ flexGrow: 1 }} />
                <Divider sx={{ mb: 2, mt: 1 }} />

                {/* Actions Row */}
                <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
                  <Button variant="contained" startIcon={<UploadIcon />} onClick={onUploadClick}>
                    Upload Page
                  </Button>
                  <Button variant="outlined" startIcon={<UploadIcon />} onClick={onImportClick} disabled={isImporting}>
                    {isImporting ? "Importing..." : "Import Project (ZIP)"}
                  </Button>
                  <Button variant="outlined" startIcon={<DownloadIcon />} onClick={onExportClick}>
                    Export Chapter (ZIP)
                  </Button>
                  <Button variant="outlined" color="error" startIcon={<DeleteIcon />} onClick={onDeleteClick}>
                    Delete Chapter
                  </Button>
                </Stack>
              </Box>
            </Grid>
          </Grid>
        </CardContent>
      </Card>
    </Box>
  );
};

export default React.memo(ChapterHeader);
