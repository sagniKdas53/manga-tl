import React, { useState, useEffect } from "react";
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
import type { Series, User, SystemSettingsDto } from "../types";
import { safeFetch, resolveOverride } from "../utils";

interface SeriesHeaderProps {
  series: Series;
  chapterCount: number;
  user: User;
  onAddChapter: () => void;
  onImportChapter: () => void;
  onEditSeries: () => void;
  onDeleteSeries: (e: React.MouseEvent) => void;
}

export const SeriesHeader: React.FC<SeriesHeaderProps> = ({
  series,
  chapterCount,
  user,
  onAddChapter,
  onImportChapter,
  onEditSeries,
  onDeleteSeries,
}) => {
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);

  useEffect(() => {
    safeFetch("/api/settings", {
      headers: { Authorization: `Bearer ${user.token}` },
    })
      .then((r) => r.json())
      .then((d) => setSettings(d))
      .catch(() => {});
  }, [user.token]);

  const resolvedOcrProvider = resolveOverride(null, series.ocrProvider, settings?.ocrProvider);
  let resolvedOcr = resolveOverride(null, series.ocrModel, settings?.ocrModel);
  if (resolvedOcrProvider.value === "local") {
    resolvedOcr = {
      value: settings?.localOcrModel || "local",
      source: resolvedOcrProvider.source,
    };
  }

  const resolvedTlProvider = resolveOverride(null, series.tlProvider, settings?.tlProvider);
  const resolvedTl = resolveOverride(null, series.tlModel, settings?.tlModel);
  
  const resolvedQaProvider = resolveOverride(null, series.qaProvider, settings?.qaProvider);
  const resolvedQaRouting = resolveOverride(null, series.routingStrategy, settings?.routingStrategy);
  const resolvedQa = resolveOverride(null, series.qaLlmModel, settings?.qaLlmModel);
  const resolvedQaVlm = resolveOverride(null, series.qaVlmModel, settings?.qaVlmModel);
  const resolvedQaMode = resolveOverride(null, series.qaMode, settings?.qaMode);

  return (
    <Card elevation={3} sx={{ mb: 4, overflow: "visible" }}>
      <CardContent sx={{ p: 0, "&:last-child": { pb: 0 } }}>
        <Grid container spacing={0}>
          {/* Cover Image Column */}
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
              {series.coverImageUrl ? (
                <Box
                  component="img"
                  src={series.coverImageUrl}
                  alt={series.title}
                  sx={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
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
          <Grid size={{ xs: 12, sm: 8, md: 9, lg: 9.5 }}>
            <Box sx={{ p: { xs: 2, sm: 3 }, display: "flex", flexDirection: "column", height: "100%" }}>
              <Typography variant="h4" component="h1" gutterBottom sx={{ fontWeight: "bold", fontFamily: '"Outfit", sans-serif' }}>
                {series.title}
              </Typography>

              <Grid container spacing={2} sx={{ mb: 3 }}>
                <Grid>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Language
                  </Typography>
                  <Chip
                    size="small"
                    label={`${series.sourceLanguage || series.originalLanguage || "ja"} → ${series.targetLanguage || "en"}`}
                  />
                </Grid>
                <Grid>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Direction
                  </Typography>
                  <Chip size="small" label={series.readingDirection} />
                </Grid>
                <Grid>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Chapters
                  </Typography>
                  <Typography variant="body1" fontWeight="medium">
                    {chapterCount}
                  </Typography>
                </Grid>
                <Grid>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Fallback Models
                  </Typography>
                  <Chip size="small" label={series.useFallbackModels === false ? "Disabled" : "Enabled"} color={series.useFallbackModels === false ? "warning" : "default"} />
                </Grid>
              </Grid>

              {/* Models Info */}
              <Box sx={{ mb: 3 }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Configured Models
                </Typography>
                <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: "wrap" }}>
                  {resolvedOcrProvider.value && (
                    <Chip size="small" variant="outlined" label={`OCR Provider: ${resolvedOcrProvider.value}`} />
                  )}
                  {resolvedOcr.value && (
                    <Chip size="small" variant="outlined" label={`OCR: ${resolvedOcr.value} ${resolvedOcr.source === "series" ? "(overridden)" : "(inherited)"}`} />
                  )}
                  {resolvedTlProvider.value && (
                    <Chip size="small" variant="outlined" label={`TL Provider: ${resolvedTlProvider.value}`} />
                  )}
                  {resolvedTl.value && (
                    <Chip size="small" variant="outlined" label={`Translation: ${resolvedTl.value} ${resolvedTl.source === "series" ? "(overridden)" : "(inherited)"}`} />
                  )}
                  {resolvedQaRouting.value && (
                    <Chip size="small" variant="outlined" color="primary" label={`Strategy: ${resolvedQaRouting.value}`} />
                  )}
                  {resolvedQaMode.value && (
                    <Chip size="small" variant="outlined" label={`QA Mode: ${resolvedQaMode.value} ${resolvedQaMode.source === "series" ? "(overridden)" : "(inherited)"}`} />
                  )}
                  {resolvedQa.value && (
                    <Chip size="small" variant="outlined" label={`QA LLM: ${resolvedQa.value} ${resolvedQa.source === "series" ? "(overridden)" : "(inherited)"}`} />
                  )}
                  {resolvedQaVlm.value && (
                    <Chip size="small" variant="outlined" label={`QA VLM: ${resolvedQaVlm.value} ${resolvedQaVlm.source === "series" ? "(overridden)" : "(inherited)"}`} />
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
