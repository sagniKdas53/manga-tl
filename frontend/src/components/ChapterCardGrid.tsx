import React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActions from "@mui/material/CardActions";
import CardContent from "@mui/material/CardContent";
import CardMedia from "@mui/material/CardMedia";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import ImportExportIcon from "@mui/icons-material/ImportExport";
import type { Series, Chapter, SystemSettingsDto } from "../types";
import { toSlug } from "../utils";

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
}) => {
  return (
    <>
      <div
        className="chapters-section-header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2>Chapters ({chapters.length})</h2>
        <Button
          variant="outlined"
          size="small"
          startIcon={<ImportExportIcon />}
          onClick={onToggleSort}
        >
          Sort: {sortAsc ? "Ascending ↑" : "Descending ↓"}
        </Button>
      </div>

      <div className="chapters-grid">
        {[...chapters]
          .sort((a, b) =>
            sortAsc
              ? a.chapterNumber - b.chapterNumber
              : b.chapterNumber - a.chapterNumber,
          )
          .map((c) => (
            <Card
              key={c.id}
              sx={{
                cursor: "pointer",
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
                <CardMedia
                  component="img"
                  image={c.coverImageUrl}
                  alt={c.title || `Chapter ${c.chapterNumber}`}
                  sx={{
                    aspectRatio: "2/3",
                    objectFit: "cover",
                    bgcolor: "#000",
                  }}
                />
              ) : series.coverImageUrl ? (
                <CardMedia
                  component="img"
                  image={series.coverImageUrl}
                  alt="Fallback Cover"
                  sx={{
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
                  title="Edit Chapter"
                  onClick={(e) => onEditChapter(c, e)}
                >
                  <EditIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  title="Delete Chapter"
                  color="error"
                  onClick={(e) => onDeleteChapter(c.id, e)}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </CardActions>
            </Card>
          ))}
      </div>
    </>
  );
};

export default React.memo(ChapterCardGrid);
