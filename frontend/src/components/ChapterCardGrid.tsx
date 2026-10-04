import React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Grid from "@mui/material/Grid";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import ImportExportIcon from "@mui/icons-material/ImportExport";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import HistoryIcon from "@mui/icons-material/History";
import type { Series, Chapter, SystemSettingsDto } from "../types";
import { toSlug } from "../utils";
import LazyImage from "./LazyImage";
import LoadMoreSentinel from "./LoadMoreSentinel";
import CardFooter from "./CardFooter";

/** Models set on this chapter or its series (not the system defaults), in one short line. */
const overrideLine = (c: Chapter): string | null => {
  const parts: string[] = [];
  const slot = (
    name: string,
    s?: {
      provider?: string | null;
      model?: string | null;
      source?: string | null;
    },
  ) => {
    if (!s || s.source === "global" || !s.provider) return;
    parts.push(`${name} ${s.model || s.provider}`);
  };
  slot("OCR", c.resolvedOcr);
  slot("TL", c.resolvedTranslation);
  return parts.length ? parts.join(", ") : null;
};

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
              role="link"
              tabIndex={0}
              aria-label={`Chapter ${c.chapterNumber}${c.title ? `, ${c.title}` : ""}`}
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
              sx={{
                cursor: "pointer",
                // The card fills its Grid cell so a row of mixed-length titles stays even.
                width: "100%",
                display: "flex",
                flexDirection: "column",
                borderRadius: "8px",
                outline: "2px solid transparent",
                outlineOffset: 2,
                transition: "outline-color 0.12s ease",
                "&:hover, &:focus-visible": { outlineColor: "primary.main" },
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
                    aspectRatio: "2 / 3",
                    objectFit: "cover",
                  }}
                />
              ) : (
                <Box
                  sx={{
                    aspectRatio: "2 / 3",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "text.secondary",
                    bgcolor: "background.default",
                    fontWeight: 700,
                    fontSize: 24,
                  }}
                >
                  {c.chapterNumber}
                </Box>
              )}
              <Box sx={{ px: 1, pt: 0.75, minWidth: 0 }}>
                <Typography
                  noWrap
                  title={c.title || "Untitled"}
                  sx={{
                    fontSize: "0.875rem",
                    fontWeight: 700,
                    lineHeight: 1.3,
                  }}
                >
                  {c.chapterNumber}.{" "}
                  <Box
                    component="span"
                    sx={{ fontWeight: 500 }}
                  >
                    {c.title || "Untitled"}
                  </Box>
                </Typography>
                {overrideLine(c) && (
                  <Typography
                    noWrap
                    title={overrideLine(c) ?? undefined}
                    sx={{ fontSize: "0.6875rem", color: "text.secondary" }}
                  >
                    {overrideLine(c)}
                  </Typography>
                )}
              </Box>
              <CardFooter
                info={[
                  {
                    key: "pages",
                    icon: <DescriptionOutlinedIcon />,
                    text: c.pageCount ?? 0,
                    label: `${c.pageCount ?? 0} pages`,
                  },
                  ...(c.useContextMemory
                    ? [
                        {
                          key: "context",
                          icon: <HistoryIcon />,
                          label:
                            "Page context on: the previous page is sent along",
                        },
                      ]
                    : []),
                ]}
                actions={[
                  {
                    title: "Edit Chapter",
                    icon: <EditIcon />,
                    onClick: (e) => onEditChapter(c, e),
                  },
                  {
                    title: "Delete Chapter",
                    icon: <DeleteIcon />,
                    onClick: (e) => onDeleteChapter(c.id, e),
                    danger: true,
                  },
                ]}
              />
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
