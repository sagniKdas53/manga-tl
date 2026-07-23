import React, { useState } from "react";
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
import MoreVertIcon from "@mui/icons-material/MoreVert";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import ButtonGroup from "@mui/material/ButtonGroup";
import ClickAwayListener from "@mui/material/ClickAwayListener";
import Grow from "@mui/material/Grow";
import Paper from "@mui/material/Paper";
import Popper from "@mui/material/Popper";
import MenuList from "@mui/material/MenuList";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import type { Series, Chapter } from "../types";

export interface ChapterHeaderProps {
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
  const [openSplit, setOpenSplit] = useState(false);
  const [splitAnchorEl, setSplitAnchorEl] = useState<HTMLDivElement | null>(
    null,
  );

  const [overflowAnchorEl, setOverflowAnchorEl] = useState<null | HTMLElement>(
    null,
  );
  const openOverflow = Boolean(overflowAnchorEl);

  const handleToggleSplit = () => {
    setOpenSplit((prevOpen) => !prevOpen);
  };

  const handleCloseSplit = () => {
    if (
      splitAnchorEl &&
      splitAnchorEl.contains(document.activeElement as HTMLElement)
    ) {
      return;
    }
    setOpenSplit(false);
  };

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
          <Grid
            container
            spacing={0}
          >
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
                  borderRight: (theme) => ({
                    sm: `1px solid ${theme.palette.divider}`,
                  }),
                  borderBottom: (theme) => ({
                    xs: `1px solid ${theme.palette.divider}`,
                    sm: "none",
                  }),
                  overflow: "hidden",
                }}
              >
                {selectedChapter.coverImageUrl ? (
                  <Box
                    component="img"
                    src={selectedChapter.coverImageUrl}
                    alt={
                      selectedChapter.title ||
                      `Chapter ${selectedChapter.chapterNumber}`
                    }
                    sx={{
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                    }}
                  />
                ) : (
                  <Typography
                    variant="body1"
                    color="text.secondary"
                  >
                    Chapter {selectedChapter.chapterNumber}
                  </Typography>
                )}
              </Box>
            </Grid>

            {/* Info Column */}
            <Grid size={{ xs: 12, sm: 8, md: 9, lg: 9.5 }}>
              <Box
                sx={{
                  p: { xs: 2, sm: 3 },
                  display: "flex",
                  flexDirection: "column",
                  height: "100%",
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    mb: 0.5,
                  }}
                >
                  <Typography
                    variant="h4"
                    component="h1"
                    sx={{
                      fontWeight: "bold",
                      fontFamily: '"Outfit", sans-serif',
                    }}
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
                </Box>
                <Typography
                  variant="body1"
                  color="text.secondary"
                  gutterBottom
                >
                  {selectedSeries.title}{" "}
                  {selectedChapter.title ? `/ ${selectedChapter.title}` : ""}
                </Typography>

                <Grid
                  container
                  spacing={2}
                  sx={{ mt: 1, mb: 3 }}
                >
                  <Grid>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      gutterBottom
                    >
                      Pages
                    </Typography>
                    <Typography
                      variant="body1"
                      sx={{ fontWeight: "medium" }}
                    >
                      {selectedChapter.pageCount || 0}
                    </Typography>
                  </Grid>
                  <Grid>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      gutterBottom
                    >
                      Context Injection
                    </Typography>
                    <Chip
                      size="small"
                      label={
                        selectedChapter.useContextMemory
                          ? "Enabled"
                          : "Disabled"
                      }
                      color={
                        selectedChapter.useContextMemory ? "success" : "default"
                      }
                    />
                  </Grid>
                  <Grid>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      gutterBottom
                    >
                      Fallback Models
                    </Typography>
                    <Chip
                      size="small"
                      label={
                        selectedChapter.useFallbackModels === false
                          ? "Disabled"
                          : "Enabled"
                      }
                      color={
                        selectedChapter.useFallbackModels === false
                          ? "warning"
                          : "default"
                      }
                    />
                  </Grid>
                </Grid>

                {/* Models Info */}
                <Box sx={{ mb: 3 }}>
                  <Typography
                    variant="subtitle2"
                    color="text.secondary"
                    gutterBottom
                  >
                    Configured Models
                  </Typography>
                  <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    sx={{ mt: 1, flexWrap: "wrap" }}
                  >
                    {selectedChapter.resolvedOcr?.provider && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`OCR Provider: ${selectedChapter.resolvedOcr.provider}`}
                      />
                    )}
                    {selectedChapter.resolvedOcr?.model && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`OCR: ${selectedChapter.resolvedOcr.model} ${selectedChapter.resolvedOcr.source === "chapter" ? "(overridden)" : "(inherited)"}`}
                      />
                    )}
                    {selectedChapter.resolvedTranslation?.provider && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`TL Provider: ${selectedChapter.resolvedTranslation.provider}`}
                      />
                    )}
                    {selectedChapter.resolvedTranslation?.model && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`Translation: ${selectedChapter.resolvedTranslation.model} ${selectedChapter.resolvedTranslation.source === "chapter" ? "(overridden)" : "(inherited)"}`}
                      />
                    )}
                    {selectedChapter.resolvedQa?.routingStrategy && (
                      <Chip
                        size="small"
                        variant="outlined"
                        color="primary"
                        label={`Strategy: ${selectedChapter.resolvedQa.routingStrategy}`}
                      />
                    )}
                    {selectedChapter.resolvedQa?.mode && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`QA Mode: ${selectedChapter.resolvedQa.mode} ${selectedChapter.resolvedQa.source === "chapter" ? "(overridden)" : "(inherited)"}`}
                      />
                    )}
                    {selectedChapter.resolvedQa?.llmModel && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`QA LLM: ${selectedChapter.resolvedQa.llmModel} ${selectedChapter.resolvedQa.source === "chapter" ? "(overridden)" : "(inherited)"}`}
                      />
                    )}
                    {selectedChapter.resolvedQa?.vlmModel && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`QA VLM: ${selectedChapter.resolvedQa.vlmModel} ${selectedChapter.resolvedQa.source === "chapter" ? "(overridden)" : "(inherited)"}`}
                      />
                    )}
                  </Stack>
                </Box>

                <Box sx={{ flexGrow: 1 }} />
                <Divider sx={{ mb: 2, mt: 1 }} />

                {/* Actions Row */}
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ flexWrap: "wrap", gap: 1, alignItems: "center" }}
                >
                  <Button
                    variant="contained"
                    startIcon={<UploadIcon />}
                    onClick={onUploadClick}
                  >
                    Upload Page
                  </Button>
                  <Button
                    variant="outlined"
                    startIcon={<UploadIcon />}
                    onClick={onImportClick}
                    disabled={isImporting}
                  >
                    {isImporting ? "Importing..." : "Import Project (ZIP)"}
                  </Button>

                  <ButtonGroup
                    variant="outlined"
                    ref={setSplitAnchorEl}
                    aria-label="split button"
                  >
                    <Button
                      onClick={onExportClick}
                      startIcon={<DownloadIcon />}
                    >
                      Export Chapter (ZIP)
                    </Button>
                    <Button
                      size="small"
                      aria-controls={
                        openSplit ? "split-button-menu" : undefined
                      }
                      aria-expanded={openSplit ? "true" : undefined}
                      aria-label="select export option"
                      aria-haspopup="menu"
                      onClick={handleToggleSplit}
                    >
                      <ArrowDropDownIcon />
                    </Button>
                  </ButtonGroup>
                  <Popper
                    sx={{ zIndex: 1 }}
                    open={openSplit}
                    anchorEl={splitAnchorEl}
                    role={undefined}
                    transition
                    disablePortal
                  >
                    {({ TransitionProps, placement }) => (
                      <Grow
                        {...TransitionProps}
                        style={{
                          transformOrigin:
                            placement === "bottom"
                              ? "center top"
                              : "center bottom",
                        }}
                      >
                        <Paper>
                          <ClickAwayListener onClickAway={handleCloseSplit}>
                            <MenuList
                              id="split-button-menu"
                              autoFocusItem
                            >
                              <MenuItem
                                onClick={() => {
                                  onReexportClick();
                                  setOpenSplit(false);
                                }}
                              >
                                Force Re-export
                              </MenuItem>
                            </MenuList>
                          </ClickAwayListener>
                        </Paper>
                      </Grow>
                    )}
                  </Popper>

                  <Button
                    variant="outlined"
                    color="error"
                    startIcon={<DeleteIcon />}
                    onClick={onDeleteClick}
                  >
                    Delete Chapter
                  </Button>

                  <IconButton
                    onClick={(e) => setOverflowAnchorEl(e.currentTarget)}
                    size="small"
                    aria-label="more actions"
                    aria-controls={
                      openOverflow ? "chapter-overflow-menu" : undefined
                    }
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
                    MenuListProps={{
                      "aria-labelledby": "basic-button",
                    }}
                  >
                    <MenuItem
                      onClick={() => {
                        onClearExportsClick();
                        setOverflowAnchorEl(null);
                      }}
                    >
                      Clear Exports
                    </MenuItem>
                  </Menu>
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
