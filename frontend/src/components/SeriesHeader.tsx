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
import AddIcon from "@mui/icons-material/Add";
import UploadIcon from "@mui/icons-material/Upload";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import type { Series } from "../types";

interface SeriesHeaderProps {
  series: Series;
  chapterCount: number;
  onAddChapter: () => void;
  onImportChapter: () => void;
  onEditSeries: () => void;
  onDeleteSeries: (e: React.MouseEvent) => void;
}

export const SeriesHeader: React.FC<SeriesHeaderProps> = ({
  series,
  chapterCount,
  onAddChapter,
  onImportChapter,
  onEditSeries,
  onDeleteSeries,
}) => {
  return (
    <Card elevation={3} sx={{ mb: 4, overflow: "visible" }}>
      <CardContent sx={{ p: 0, "&:last-child": { pb: 0 } }}>
        <Grid container spacing={0}>
          {/* Cover Image Column */}
          <Grid item xs={12} sm={4} md={3} lg={2.5}>
            <Box
              sx={{
                width: "100%",
                height: "100%",
                minHeight: { xs: 200, sm: 300 },
                backgroundColor: "background.default",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRight: (theme) => ({ sm: `1px solid ${theme.palette.divider}` }),
                borderBottom: (theme) => ({ xs: `1px solid ${theme.palette.divider}`, sm: "none" }),
                overflow: "hidden",
              }}
            >
              {series.coverImageUrl ? (
                <Box
                  component="img"
                  src={series.coverImageUrl}
                  alt={series.title}
                  sx={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              ) : (
                <Typography variant="body1" color="text.secondary">
                  {series.title}
                </Typography>
              )}
            </Box>
          </Grid>

          {/* Info Column */}
          <Grid item xs={12} sm={8} md={9} lg={9.5}>
            <Box sx={{ p: { xs: 2, sm: 3 }, display: "flex", flexDirection: "column", height: "100%" }}>
              <Typography variant="h4" component="h1" gutterBottom sx={{ fontWeight: "bold", fontFamily: '"Outfit", sans-serif' }}>
                {series.title}
              </Typography>

              <Grid container spacing={2} sx={{ mb: 3 }}>
                <Grid item>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Language
                  </Typography>
                  <Chip
                    size="small"
                    label={`${series.sourceLanguage || series.originalLanguage || "ja"} → ${series.targetLanguage || "en"}`}
                  />
                </Grid>
                <Grid item>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Direction
                  </Typography>
                  <Chip size="small" label={series.readingDirection} />
                </Grid>
                <Grid item>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Chapters
                  </Typography>
                  <Typography variant="body1" fontWeight="medium">
                    {chapterCount}
                  </Typography>
                </Grid>
              </Grid>

              {/* Models Info */}
              <Box sx={{ mb: 3 }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Configured Models
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                  {series.ocrModel && (
                    <Chip size="small" variant="outlined" label={`OCR: ${series.ocrModel}`} />
                  )}
                  {series.tlModel && (
                    <Chip size="small" variant="outlined" label={`Translation: ${series.tlModel}`} />
                  )}
                  {series.qaLlmModel && (
                    <Chip size="small" variant="outlined" label={`QA: ${series.qaLlmModel}`} />
                  )}
                  {!series.ocrModel && !series.tlModel && !series.qaLlmModel && (
                    <Typography variant="body2" color="text.disabled">
                      Using Global Defaults
                    </Typography>
                  )}
                </Stack>
              </Box>

              <Box sx={{ flexGrow: 1 }} />
              <Divider sx={{ mb: 2, mt: 1 }} />

              {/* Actions Row */}
              <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
                <Button variant="contained" startIcon={<AddIcon />} onClick={onAddChapter}>
                  Add Chapter
                </Button>
                <Button variant="outlined" startIcon={<UploadIcon />} onClick={onImportChapter}>
                  Import Chapter (ZIP)
                </Button>
                <Button variant="outlined" startIcon={<EditIcon />} onClick={onEditSeries}>
                  Edit Series
                </Button>
                <Button variant="outlined" color="error" startIcon={<DeleteIcon />} onClick={onDeleteSeries}>
                  Delete Series
                </Button>
              </Stack>
            </Box>
          </Grid>
        </Grid>
      </CardContent>
    </Card>
  );
};

export default React.memo(SeriesHeader);
