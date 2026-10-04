import React, { useState, useEffect } from "react";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import AddIcon from "@mui/icons-material/Add";
import UploadIcon from "@mui/icons-material/Upload";
import EditIcon from "@mui/icons-material/Edit";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import type { Series, User, SystemSettingsDto } from "../types";
import { safeFetch, resolveOverride } from "../utils";
import { readingDirectionLabel } from "../utils/readingDirection";
import {
  HeaderShell,
  Inherited,
  MetaRows,
  ModelPill,
  PillRow,
} from "./DetailParts";

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

  const resolvedOcrProvider = resolveOverride(
    null,
    series.ocrProvider,
    settings?.ocrProvider,
  );
  let resolvedOcr = resolveOverride(null, series.ocrModel, settings?.ocrModel);
  if (resolvedOcrProvider.value === "local") {
    resolvedOcr = {
      value: settings?.localOcrModel || "local",
      source: resolvedOcrProvider.source,
    };
  }

  // -------------------------------------------------------------------------------------
  // MODEL INHERITANCE LOGIC:
  // We use `resolveOverride(fallback, override, base)` to compute the effective values.
  // The backend handles resolving chapters, but for Series, we compute it on the frontend.
  // We check `settings?.providerModelsMap` to ensure we don't display chips for
  // models (like qaVLM) if the configured provider does not support them.
  // -------------------------------------------------------------------------------------

  const resolvedTlProvider = resolveOverride(
    null,
    series.tlProvider,
    settings?.tlProvider,
  );
  const resolvedTl = resolveOverride(null, series.tlModel, settings?.tlModel);

  const resolvedQaRouting = resolveOverride(
    null,
    series.routingStrategy,
    settings?.routingStrategy,
  );
  const resolvedQa = resolveOverride(
    null,
    series.qaLlmModel,
    settings?.qaLlmModel,
  );
  const resolvedQaVlm = resolveOverride(
    null,
    series.qaVlmModel,
    settings?.qaVlmModel,
  );
  const resolvedQaMode = resolveOverride(null, series.qaMode, settings?.qaMode);

  const resolvedQaProvider = resolveOverride(
    null,
    series.qaProvider,
    settings?.qaProvider,
  );

  const qaVlmModels =
    settings?.providerModelsMap?.[resolvedQaProvider.value || "openrouter"]?.[
      "qaVLM"
    ] || [];
  const qaVlmCapabilityMissing = qaVlmModels.length === 0;

  const usesOpenRouter =
    resolvedOcrProvider.value === "openrouter" ||
    resolvedTlProvider.value === "openrouter" ||
    resolvedQaProvider.value === "openrouter";

  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const fromSettings = (source?: string | null) =>
    source === "series" ? null : "settings";
  const directionLabel = readingDirectionLabel(series.readingDirection);

  return (
    <Box sx={{ mb: 4 }}>
      <HeaderShell
        coverUrl={series.coverImageUrl}
        coverAlt={series.title}
        coverFallback={series.title}
      >
        <Typography
          variant="h4"
          component="h1"
        >
          {series.title}
        </Typography>

        <MetaRows
          rows={[
            {
              label: "Languages",
              value: `${series.sourceLanguage || series.originalLanguage || "ja"} → ${series.targetLanguage || "en"}`,
            },
            { label: "Reading", value: directionLabel },
            { label: "Chapters", value: chapterCount },
            {
              label: "Fallback models",
              value: (
                <Inherited
                  value={series.resolvedUseFallbackModels ? "On" : "Off"}
                  from={series.useFallbackModels === null ? "settings" : null}
                />
              ),
            },
            {
              label: "Routing",
              value: (
                <Inherited
                  value={resolvedQaRouting.value}
                  from={fromSettings(resolvedQaRouting.source)}
                />
              ),
              hidden: !usesOpenRouter || !resolvedQaRouting.value,
            },
            {
              label: "QA",
              value: (
                <Inherited
                  value={resolvedQaMode.value || "Not set"}
                  from={
                    resolvedQaMode.value
                      ? fromSettings(resolvedQaMode.source)
                      : null
                  }
                />
              ),
            },
            {
              label: "Models",
              value: (
                <PillRow>
                  {resolvedOcr.value && (
                    <ModelPill
                      role="OCR"
                      model={resolvedOcr.value}
                      provider={resolvedOcrProvider.value}
                      setHere={resolvedOcr.source === "series"}
                      levelName="series"
                    />
                  )}
                  {resolvedTl.value && (
                    <ModelPill
                      role="Translation"
                      model={resolvedTl.value}
                      provider={resolvedTlProvider.value}
                      setHere={resolvedTl.source === "series"}
                      levelName="series"
                    />
                  )}
                  {resolvedQa.value && (
                    <ModelPill
                      role="QA text"
                      model={resolvedQa.value}
                      setHere={resolvedQa.source === "series"}
                      disabled={
                        resolvedQaMode.value === "vlm" ||
                        resolvedQaMode.value === "none"
                      }
                      levelName="series"
                    />
                  )}
                  {resolvedQaVlm.value && !qaVlmCapabilityMissing && (
                    <ModelPill
                      role="QA vision"
                      model={resolvedQaVlm.value}
                      setHere={resolvedQaVlm.source === "series"}
                      disabled={
                        resolvedQaMode.value === "llm" ||
                        resolvedQaMode.value === "none"
                      }
                      levelName="series"
                    />
                  )}
                </PillRow>
              ),
            },
          ]}
        />

        <Stack
          direction="row"
          sx={{ flexWrap: "wrap", gap: 1, alignItems: "center", mt: 0.5 }}
        >
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={onAddChapter}
          >
            Add chapter
          </Button>
          <Button
            variant="outlined"
            startIcon={<UploadIcon />}
            onClick={onImportChapter}
          >
            Import chapter (ZIP)
          </Button>
          <Button
            variant="outlined"
            startIcon={<EditIcon />}
            onClick={onEditSeries}
          >
            Edit series
          </Button>
          <IconButton
            aria-label="more series actions"
            aria-haspopup="true"
            onClick={(e) => setMenuAnchor(e.currentTarget)}
          >
            <MoreVertIcon />
          </IconButton>
          <Menu
            anchorEl={menuAnchor}
            open={Boolean(menuAnchor)}
            onClose={() => setMenuAnchor(null)}
          >
            <MenuItem
              onClick={(e) => {
                setMenuAnchor(null);
                onDeleteSeries(e);
              }}
              sx={{ color: "error.main" }}
            >
              Delete series
            </MenuItem>
          </Menu>
        </Stack>
      </HeaderShell>
    </Box>
  );
};

export default React.memo(SeriesHeader);
