import React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
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
          variant="text"
          size="small"
          startIcon={<ImportExportIcon />}
          onClick={onToggleSort}
          sx={{ color: "text.secondary" }}
        >
          Sort: {sortAsc ? "first to last" : "last to first"}
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
                bgcolor: "transparent",
                boxShadow: "none",
                borderRadius: 0,
                overflow: "visible",
                "&:hover .chapter-cover, &:focus-visible .chapter-cover": {
                  outline: "2px solid",
                  outlineColor: "primary.main",
                  outlineOffset: 2,
                },
                "&:hover .chapter-tools, &:focus-within .chapter-tools": {
                  opacity: 1,
                },
              }}
              role="link"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                onSelectChapter(c);
                onNavigate(
                  `/chapters/${c.id}/${toSlug(c.title || `chapter-${c.chapterNumber}`)}`,
                );
              }}
              onClick={() => {
                onSelectChapter(c);
                onNavigate(
                  `/chapters/${c.id}/${toSlug(c.title || `chapter-${c.chapterNumber}`)}`,
                );
              }}
            >
              <Box
                className="chapter-cover"
                sx={{
                  position: "relative",
                  aspectRatio: "2 / 3",
                  borderRadius: "6px",
                  overflow: "hidden",
                  bgcolor: "background.paper",
                }}
              >
                {c.coverImageUrl || series.coverImageUrl ? (
                  <LazyImage
                    src={(c.coverImageUrl || series.coverImageUrl)!}
                    alt={
                      c.coverImageUrl
                        ? c.title || `Chapter ${c.chapterNumber}`
                        : "Fallback Cover"
                    }
                    sx={{
                      display: "block",
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                ) : (
                  <Box
                    sx={{
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "text.secondary",
                      fontWeight: 700,
                      fontSize: 24,
                    }}
                  >
                    {c.chapterNumber}
                  </Box>
                )}
                <Box
                  className="chapter-tools"
                  sx={{
                    position: "absolute",
                    top: 6,
                    right: 6,
                    display: "flex",
                    gap: 0.5,
                    opacity: 0,
                    transition: "opacity 0.12s ease",
                    "@media (hover: none)": { opacity: 1 },
                  }}
                >
                  {[
                    {
                      title: "Edit Chapter",
                      icon: <EditIcon sx={{ fontSize: 16 }} />,
                      onClick: (e: React.MouseEvent) => onEditChapter(c, e),
                    },
                    {
                      title: "Delete Chapter",
                      icon: <DeleteIcon sx={{ fontSize: 16 }} />,
                      onClick: (e: React.MouseEvent) =>
                        onDeleteChapter(c.id, e),
                    },
                  ].map((tool) => (
                    <IconButton
                      key={tool.title}
                      size="small"
                      aria-label={tool.title}
                      title={tool.title}
                      onClick={tool.onClick}
                      onKeyDown={(e) => e.stopPropagation()}
                      sx={{
                        width: 30,
                        height: 30,
                        bgcolor: "rgba(0,0,0,0.7)",
                        color: "#fff",
                        "&:hover": { bgcolor: "rgba(0,0,0,0.85)" },
                      }}
                    >
                      {tool.icon}
                    </IconButton>
                  ))}
                </Box>
              </Box>
              <Typography
                sx={{ mt: 1, fontWeight: 700, fontSize: "0.9375rem" }}
              >
                Chapter {c.chapterNumber}
              </Typography>
              <Typography
                variant="body2"
                noWrap
                title={c.title || "Untitled"}
              >
                {c.title || "Untitled"}
              </Typography>
              <Typography
                variant="body2"
                sx={{ color: "text.secondary", fontSize: "0.8125rem" }}
              >
                {[
                  c.pageCount ? `${c.pageCount} pages` : "No pages",
                  c.useContextMemory ? "page context on" : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </Typography>
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
