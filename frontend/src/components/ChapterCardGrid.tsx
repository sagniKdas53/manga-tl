import React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActions from "@mui/material/CardActions";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import ImportExportIcon from "@mui/icons-material/ImportExport";
import type { Series, Chapter, SystemSettingsDto } from "../types";
import { toSlug } from "../utils";
import LazyImage from "./LazyImage";
import LoadMoreSentinel from "./LoadMoreSentinel";

interface ChapterCardGridProps {
  chapters: Chapter[];
  series: Series;
  sortAsc: boolean;
  onToggleSort: () => void;
  onSelectChapter: (chapter: Chapter) => void;
  onEditChapter: (chapter: Chapter, e: React.MouseEvent) => void;
  onDeleteChapter: (chapterId: string, e: React.MouseEvent) => void;
  onNavigate: (path: string) => void;
  settings?: SystemSettingsDto | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}

export const ChapterCardGrid: React.FC<ChapterCardGridProps> = ({
  chapters,
  series,
  sortAsc,
  onToggleSort,
  onSelectChapter,
  onEditChapter,
  onDeleteChapter,
  onNavigate,
  hasMore,
  isLoadingMore,
  onLoadMore,
}) => {
  return (
    <>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        sx={{
          justifyContent: "space-between",
          alignItems: { xs: "stretch", sm: "center" },
          mb: 2,
        }}
      >
        <Typography
          variant="h5"
          component="h2"
          sx={{ fontWeight: 600 }}
        >
          Chapters ({chapters.length})
        </Typography>
        <Button
          variant="outlined"
          size="small"
          startIcon={<ImportExportIcon />}
          onClick={onToggleSort}
        >
          Sort: {sortAsc ? "Ascending ↑" : "Descending ↓"}
        </Button>
      </Stack>

      <Grid
        container
        spacing={2}
      >
        {/* Already sorted server-side by chapterNumber/sortAsc (see App.tsx) — re-sorting
            here would be wrong once the list is a partial infinite-scroll prefix. */}
        {chapters.map((c) => (
          <Grid
            key={c.id}
            size={{ xs: 6, sm: 4, md: 3, lg: 2 }}
            sx={{ display: "flex" }}
          >
            <Card
              sx={{
                cursor: "pointer",
                // The card fills its Grid cell so a row of mixed-length titles stays even.
                width: "100%",
                display: "flex",
                flexDirection: "column",
                transition: "transform 0.2s, box-shadow 0.2s",
                "&:hover": {
                  transform: "translateY(-4px)",
                  boxShadow: 4,
                },
              }}
              onClick={() => {
                onSelectChapter(c);
                onNavigate(
                  `/chapters/${c.id}/${toSlug(c.title || `chapter-${c.chapterNumber}`)}`,
                );
              }}
            >
              {c.coverImageUrl ? (
                <LazyImage
                  src={c.coverImageUrl}
                  alt={c.title || `Chapter ${c.chapterNumber}`}
                  sx={{
                    display: "block",
                    width: "100%",
                    aspectRatio: "2/3",
                    objectFit: "cover",
                    bgcolor: "#000",
                  }}
                />
              ) : series.coverImageUrl ? (
                <LazyImage
                  src={series.coverImageUrl}
                  alt="Fallback Cover"
                  sx={{
                    display: "block",
                    width: "100%",
                    aspectRatio: "2/3",
                    objectFit: "cover",
                    bgcolor: "#000",
                  }}
                />
              ) : (
                <Box
                  sx={{
                    aspectRatio: "2/3",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    bgcolor: "grey.900",
                    color: "text.secondary",
                    fontFamily: '"Outfit", sans-serif',
                    fontWeight: 700,
                    p: 2,
                    textAlign: "center",
                    fontSize: 24,
                  }}
                >
                  C{c.chapterNumber}
                </Box>
              )}

              <CardContent
                sx={{ flex: 1, py: 1.5, pb: 1, "&:last-child": { pb: 1.5 } }}
              >
                <Typography
                  variant="subtitle2"
                  sx={{
                    color: "primary.main",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    fontSize: "0.75rem",
                    mb: 0.5,
                  }}
                >
                  Chapter {c.chapterNumber}
                </Typography>
                <Typography
                  variant="h6"
                  noWrap
                  title={c.title || "Untitled"}
                  sx={{ fontSize: "1rem", lineHeight: 1.2, mb: 1 }}
                >
                  {c.title || "Untitled"}
                </Typography>

                {(c.pageCount ||
                  c.useContextMemory !== undefined ||
                  c.resolvedOcr ||
                  c.resolvedTranslation) && (
                  <Box
                    sx={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 0.5,
                      mt: 0.5,
                    }}
                  >
                    {c.pageCount !== undefined && c.pageCount > 0 && (
                      <Chip
                        label={`${c.pageCount} pages`}
                        size="small"
                        variant="outlined"
                        title="Total pages in this chapter"
                      />
                    )}
                    {c.useContextMemory !== undefined && (
                      <Chip
                        label={c.useContextMemory ? "Context" : "No Context"}
                        size="small"
                        variant="outlined"
                        color={c.useContextMemory ? "primary" : "default"}
                        title={
                          c.useContextMemory
                            ? "Context memory enabled"
                            : "Context memory disabled"
                        }
                      />
                    )}
                    {(c.resolvedOcr || c.resolvedTranslation) && (
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                          fontSize: "10px",
                          lineHeight: "20px",
                          width: "100%",
                          mt: 0.5,
                        }}
                      >
                        {c.resolvedOcr && c.resolvedOcr.source !== "global"
                          ? `OCR: ${c.resolvedOcr.provider}${c.resolvedOcr.model ? " / " + c.resolvedOcr.model : ""} (${c.resolvedOcr.source})`
                          : ""}
                        {c.resolvedOcr &&
                        c.resolvedOcr.source !== "global" &&
                        c.resolvedTranslation &&
                        c.resolvedTranslation.source !== "global"
                          ? " | "
                          : ""}
                        {c.resolvedTranslation &&
                        c.resolvedTranslation.source !== "global"
                          ? `TL: ${c.resolvedTranslation.provider}${c.resolvedTranslation.model ? " / " + c.resolvedTranslation.model : ""} (${c.resolvedTranslation.source})`
                          : ""}
                      </Typography>
                    )}
                  </Box>
                )}
              </CardContent>

              <CardActions sx={{ justifyContent: "flex-end", pt: 0 }}>
                <IconButton
                  size="small"
                  aria-label="Edit Chapter"
                  title="Edit Chapter"
                  onClick={(e) => onEditChapter(c, e)}
                >
                  <EditIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label="Delete Chapter"
                  title="Delete Chapter"
                  color="error"
                  onClick={(e) => onDeleteChapter(c.id, e)}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </CardActions>
            </Card>
          </Grid>
        ))}
      </Grid>

      <LoadMoreSentinel
        hasMore={hasMore}
        isLoading={isLoadingMore}
        onLoadMore={onLoadMore}
      />
    </>
  );
};

export default React.memo(ChapterCardGrid);
