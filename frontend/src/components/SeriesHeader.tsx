import React from "react";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import AddIcon from "@mui/icons-material/Add";
import UploadIcon from "@mui/icons-material/Upload";
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
    <div className="series-details-container">
      <div className="series-cover-column">
        {series.coverImageUrl ? (
          <img
            src={series.coverImageUrl}
            className="series-large-cover"
            alt={series.title}
          />
        ) : (
          <div className="series-large-cover-placeholder">
            <span>{series.title}</span>
          </div>
        )}
      </div>

      <div className="series-info-column">
        <h1 className="series-title">{series.title}</h1>

        <div className="nhentai-meta-table">
          <div className="meta-row">
            <span className="meta-label">Language:</span>
            <span className="meta-value">
              <span className="meta-badge-nhentai">
                {series.sourceLanguage ||
                  series.originalLanguage ||
                  "ja"}{" "}
                → {series.targetLanguage || "en"}
                {(series.sourceLanguage ||
                  series.originalLanguage ||
                  "ja") === (series.targetLanguage || "en")
                  ? " (Reader Mode)"
                  : ""}
              </span>
            </span>
          </div>
          <div className="meta-row">
            <span className="meta-label">Direction:</span>
            <span className="meta-value">
              <span className="meta-badge-nhentai">
                {series.readingDirection}
              </span>
            </span>
          </div>
          <div className="meta-row">
            <span className="meta-label">Chapters:</span>
            <span className="meta-value">{chapterCount}</span>
          </div>
        </div>

        <div className="series-actions-row">
          <Stack
            direction="row"
            spacing={1}
            flexWrap="wrap"
            useFlexGap
          >
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={onAddChapter}
            >
              Add Chapter
            </Button>
            <Button
              variant="outlined"
              startIcon={<UploadIcon />}
              onClick={onImportChapter}
            >
              Import Chapter (ZIP)
            </Button>
            <Button
              variant="outlined"
              onClick={onEditSeries}
            >
              Edit Series
            </Button>
            <Button
              variant="outlined"
              color="error"
              onClick={onDeleteSeries}
            >
              Delete Series
            </Button>
          </Stack>
        </div>
      </div>
    </div>
  );
};

export default React.memo(SeriesHeader);
