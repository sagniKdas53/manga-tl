import React, { useState, useEffect } from "react";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import UploadIcon from "@mui/icons-material/Upload";
import DownloadIcon from "@mui/icons-material/Download";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import type { Series, Chapter, User, SystemSettingsDto } from "../types";
import { safeFetch } from "../utils";
import {
  HeaderShell,
  Inherited,
  MetaRows,
  ModelPill,
  PillRow,
} from "./DetailParts";

export interface ChapterHeaderProps {
  user?: User;
  selectedSeries: Series;
  selectedChapter: Chapter;
  onBack: () => void;
  onEditClick: () => void;
  onImportClick: () => void;
  onExportClick: () => void;
  onReexportClick: () => void;
  onClearExportsClick: () => void;
  onUploadClick: () => void;
  onDeleteClick: () => void;
  isImporting: boolean;
  mode: "light" | "dark";
}

const ChapterHeader: React.FC<ChapterHeaderProps> = ({
  user,
  selectedSeries,
  selectedChapter,
  onBack,
  onEditClick,
  onImportClick,
  onExportClick,
  onReexportClick,
  onClearExportsClick,
  onUploadClick,
  onDeleteClick,
  isImporting,
}) => {
  const [overflowAnchorEl, setOverflowAnchorEl] = useState<null | HTMLElement>(
    null,
  );
  const openOverflow = Boolean(overflowAnchorEl);

  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);

  useEffect(() => {
    if (!user) return;
    safeFetch("/api/settings", {
      headers: { Authorization: `Bearer ${user.token}` },
    })
      .then((r) => r.json())
      .then((d) => setSettings(d))
      .catch(() => {});
    // Deliberately keyed on the token, not on `user`: the object is rebuilt on every auth state
    // change, and depending on it would refetch settings each time without the credentials
    // having changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.token]);

  // -------------------------------------------------------------------------------------
  // MODEL INHERITANCE LOGIC:
  // The backend already resolves the model inheritance (Global -> Series -> Chapter)
  // and returns it in `selectedChapter.resolvedQa`.
  // However, we fetch `settings` here to dynamically check `providerModelsMap`
  // so we know whether to hide the `QA VLM` chip if the provider doesn't support VLMs.
  // -------------------------------------------------------------------------------------
  const qaVlmModels =
    settings?.providerModelsMap?.[
      selectedChapter.resolvedQa?.provider || "openrouter"
    ]?.["qaVLM"] || [];
  const qaVlmCapabilityMissing = qaVlmModels.length === 0 && settings !== null;

  const usesOpenRouter =
    selectedChapter.resolvedOcr?.provider === "openrouter" ||
    selectedChapter.resolvedTranslation?.provider === "openrouter" ||
    selectedChapter.resolvedQa?.provider === "openrouter";

  const routingStrategy =
    selectedChapter.routingStrategy ||
    selectedSeries.routingStrategy ||
    "lowest-cost";

  const onOff = (on: boolean | null | undefined) => (on ? "On" : "Off");
  const inheritedFrom = (source?: string | null) =>
    source === "chapter" ? null : source === "series" ? "series" : "settings";

  return (
    <Box sx={{ mb: 4 }}>
      <Button
        variant="text"
        size="small"
        startIcon={<ArrowBackIcon fontSize="small" />}
        onClick={onBack}
        aria-label="Back to series"
        sx={{ mb: 1.5, color: "text.secondary", px: 1 }}
      >
        {selectedSeries.title}
      </Button>

      <HeaderShell
        coverUrl={selectedChapter.coverImageUrl}
        coverAlt={
          selectedChapter.title || `Chapter ${selectedChapter.chapterNumber}`
        }
        coverFallback={`Chapter ${selectedChapter.chapterNumber}`}
      >
        <Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <Typography
              variant="h4"
              component="h1"
            >
              Chapter {selectedChapter.chapterNumber}
            </Typography>
            <IconButton
              onClick={onEditClick}
              aria-label="Edit Chapter Name & Number"
              title="Edit Chapter Name & Number"
              size="small"
              sx={{ color: "text.secondary" }}
            >
              <EditIcon fontSize="small" />
            </IconButton>
          </Box>
          {selectedChapter.title && (
            <Typography
              variant="body1"
              sx={{ fontSize: "1.0625rem", mt: 0.25 }}
            >
              {selectedChapter.title}
            </Typography>
          )}
        </Box>

        <MetaRows
          rows={[
            { label: "Series", value: selectedSeries.title },
            {
              label: "Languages",
              value: `${selectedSeries.sourceLanguage || selectedSeries.originalLanguage || "ja"} → ${selectedSeries.targetLanguage || "en"}`,
            },
            { label: "Pages", value: selectedChapter.pageCount || 0 },
            {
              label: "Page context",
              value: selectedChapter.useContextMemory
                ? "On, the previous page is sent along"
                : "Off",
            },
            {
              label: "Fallback models",
              value: (
                <Inherited
                  value={onOff(selectedChapter.resolvedUseFallbackModels)}
                  from={
                    selectedChapter.useFallbackModels == null ? "series" : null
                  }
                />
              ),
            },
            {
              label: "Routing",
              value: routingStrategy,
              hidden: !usesOpenRouter || !routingStrategy,
            },
            {
              label: "QA",
              value: (
                <Inherited
                  value={selectedChapter.resolvedQa?.mode || "Not set"}
                  from={
                    selectedChapter.resolvedQa?.mode
                      ? inheritedFrom(selectedChapter.resolvedQa?.source)
                      : null
                  }
                />
              ),
            },
            {
              label: "Models",
              value: (
                <PillRow>
                  {selectedChapter.resolvedOcr?.model && (
                    <ModelPill
                      role="OCR"
                      model={selectedChapter.resolvedOcr.model}
                      provider={selectedChapter.resolvedOcr.provider}
                      source={selectedChapter.resolvedOcr.source}
                      level="chapter"
                    />
                  )}
                  {selectedChapter.resolvedTranslation?.model && (
                    <ModelPill
                      role="Translation"
                      model={selectedChapter.resolvedTranslation.model}
                      provider={selectedChapter.resolvedTranslation.provider}
                      source={selectedChapter.resolvedTranslation.source}
                      level="chapter"
                    />
                  )}
                  {selectedChapter.resolvedQa?.llmModel && (
                    <ModelPill
                      role="QA text"
                      model={selectedChapter.resolvedQa.llmModel}
                      source={selectedChapter.resolvedQa.source}
                      disabled={
                        selectedChapter.resolvedQa?.mode === "vlm" ||
                        selectedChapter.resolvedQa?.mode === "none"
                      }
                      level="chapter"
                    />
                  )}
                  {selectedChapter.resolvedQa?.vlmModel &&
                    !qaVlmCapabilityMissing && (
                      <ModelPill
                        role="QA vision"
                        model={selectedChapter.resolvedQa.vlmModel}
                        source={selectedChapter.resolvedQa.source}
                        disabled={
                          selectedChapter.resolvedQa?.mode === "llm" ||
                          selectedChapter.resolvedQa?.mode === "none"
                        }
                        level="chapter"
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
            startIcon={<UploadIcon />}
            onClick={onUploadClick}
          >
            Upload pages
          </Button>
          <Button
            variant="outlined"
            startIcon={<DownloadIcon />}
            onClick={onExportClick}
          >
            Export chapter (ZIP)
          </Button>
          <Button
            variant="outlined"
            startIcon={<UploadIcon />}
            onClick={onImportClick}
            disabled={isImporting}
          >
            {isImporting ? "Importing…" : "Import project (ZIP)"}
          </Button>

          <Button
            variant="outlined"
            color="error"
            startIcon={<DeleteIcon />}
            onClick={onDeleteClick}
          >
            Delete chapter
          </Button>
          <IconButton
            onClick={(e) => setOverflowAnchorEl(e.currentTarget)}
            aria-label="more actions"
            aria-controls={openOverflow ? "chapter-overflow-menu" : undefined}
            aria-haspopup="true"
            aria-expanded={openOverflow ? "true" : undefined}
          >
            <MoreVertIcon />
          </IconButton>
          <Menu
            id="chapter-overflow-menu"
            anchorEl={overflowAnchorEl}
            open={openOverflow}
            onClose={() => setOverflowAnchorEl(null)}
          >
            <MenuItem
              onClick={() => {
                onReexportClick();
                setOverflowAnchorEl(null);
              }}
            >
              Build a new export
            </MenuItem>
            <MenuItem
              onClick={() => {
                onClearExportsClick();
                setOverflowAnchorEl(null);
              }}
            >
              Delete saved exports
            </MenuItem>
          </Menu>
        </Stack>
      </HeaderShell>
    </Box>
  );
};

export default React.memo(ChapterHeader);
