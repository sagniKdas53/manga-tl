import React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
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
            <div
              key={c.id}
              className="chapter-card-nhentai"
              onClick={() => {
                onSelectChapter(c);
                onNavigate(
                  `/chapters/${c.id}/${toSlug(c.title || `chapter-${c.chapterNumber}`)}`,
                );
              }}
            >
              <div className="chapter-cover-container-nhentai">
                {c.coverImageUrl ? (
                  <img
                    src={c.coverImageUrl}
                    className="chapter-cover-img-nhentai"
                    alt={c.title || `Chapter ${c.chapterNumber}`}
                  />
                ) : series.coverImageUrl ? (
                  <img
                    src={series.coverImageUrl}
                    className="chapter-cover-img-nhentai fallback"
                    alt="Fallback Cover"
                  />
                ) : (
                  <div className="chapter-cover-placeholder-nhentai">
                    <span>C{c.chapterNumber}</span>
                  </div>
                )}

                <div
                  className="chapter-actions-overlay"
                  onClick={(e) => e.stopPropagation()}
                >
                  <IconButton
                    className="action-btn-small"
                    onClick={(e) => onEditChapter(c, e)}
                    size="small"
                    title="Edit Chapter"
                  >
                    <EditIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                  <IconButton
                    className="action-btn-small delete-btn"
                    onClick={(e) => onDeleteChapter(c.id, e)}
                    size="small"
                    title="Delete Chapter"
                    color="error"
                  >
                    <DeleteIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </div>
              </div>

              <div className="chapter-card-info-nhentai">
                <div className="chapter-card-number-nhentai">
                  Chapter {c.chapterNumber}
                </div>
                <div
                  className="chapter-card-title-nhentai"
                  title={c.title || "Untitled"}
                >
                  {c.title || "Untitled"}
                </div>
                {(c.pageCount ||
                  c.useContextMemory !== undefined ||
                  c.resolvedOcr ||
                  c.resolvedTranslation) && (
                  <Box
                    sx={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 0.5,
                      mt: 0.75,
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
              </div>
            </div>
          ))}
      </div>
    </>
  );
};

export default React.memo(ChapterCardGrid);
