import React, { useEffect, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { Chapter, Series, User } from "../types";
import { isOneshot } from "../types";
import { safeFetch } from "../utils";

/**
 * Move a chapter to another series, or out to the library as a one-shot (#218).
 *
 * The server does the move in one transaction (`POST /api/series/chapters/{id}/move`, #226):
 * pages, layers and renders stay as they are and nothing re-renders. Here the user picks where
 * it goes and its number there; a number already taken is shown before confirming, and the
 * server's 409 (with the next free number) covers a series too long to check from here.
 */

export interface MoveChapterResult {
  chapter: Chapter;
  /** The series the chapter is in now. */
  series: Series;
  /** The one-shot the move emptied and deleted, if any. */
  removedSeriesId?: string | null;
}

interface MoveChapterDialogProps {
  open: boolean;
  onClose: () => void;
  user: User;
  chapter: Chapter;
  /** The series the chapter is in now. */
  series: Series;
  onMoved: (result: MoveChapterResult) => void;
}

/** The "Library (as a one-shot)" choice, listed with the series. */
const LIBRARY = "__library__";

type Destination = { id: string; label: string; series: Series | null };

const languagesOf = (s: Series) =>
  `${s.sourceLanguage || s.originalLanguage || "ja"} → ${s.targetLanguage || "en"}`;

/** The lowest whole number above every number taken (1 when none is). */
const nextFree = (taken: number[]) =>
  taken.length ? Math.floor(Math.max(...taken)) + 1 : 1;

export const MoveChapterDialog: React.FC<MoveChapterDialogProps> = ({
  open,
  onClose,
  user,
  chapter,
  series,
  onMoved,
}) => {
  const [options, setOptions] = useState<Series[]>([]);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [taken, setTaken] = useState<number[] | null>(null);
  const [number, setNumber] = useState(chapter.chapterNumber);
  const [keepSettings, setKeepSettings] = useState(true);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState("");

  const label = chapter.title || `Chapter ${chapter.chapterNumber}`;
  const fromOneshot = isOneshot(series);

  // Reset on open, and list the series a chapter can go into: not its own, and no one-shot
  // (a one-shot holds one chapter).
  useEffect(() => {
    if (!open) return;
    Promise.resolve().then(() => {
      setDestination(null);
      setTaken(null);
      setNumber(chapter.chapterNumber);
      setKeepSettings(true);
      setError("");
    });
    safeFetch(
      "/api/series?page=0&size=100&sortBy=updatedAt&sortDir=desc&kind=series",
      { headers: { Authorization: `Bearer ${user.token}` } },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) =>
        setOptions(
          ((d?.content ?? []) as Series[]).filter((s) => s.id !== series.id),
        ),
      )
      .catch(() => setOptions([]));
  }, [open, chapter.chapterNumber, series.id, user.token]);

  const destinations = useMemo<Destination[]>(
    () => [
      ...(fromOneshot
        ? []
        : [{ id: LIBRARY, label: "Library (as a one-shot)", series: null }]),
      ...options.map((s) => ({ id: s.id, label: s.title, series: s })),
    ],
    [options, fromOneshot],
  );

  const target = destination?.series ?? null;
  const toLibrary = destination?.id === LIBRARY;

  // The numbers taken in the chosen series; suggest the chapter's own number if it is free,
  // otherwise the next free one.
  useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    safeFetch(`/api/series/${target.id}/chapters?page=0&size=100`, {
      headers: { Authorization: `Bearer ${user.token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        const numbers = ((d?.content ?? []) as Chapter[]).map(
          (c) => c.chapterNumber,
        );
        setTaken(numbers);
        setNumber(
          numbers.includes(chapter.chapterNumber)
            ? nextFree(numbers)
            : chapter.chapterNumber,
        );
      })
      .catch(() => !cancelled && setTaken([]));
    return () => {
      cancelled = true;
    };
  }, [open, target, chapter.chapterNumber, user.token]);

  const clash = Boolean(target && taken?.includes(number));
  const languagesDiffer = Boolean(
    target && languagesOf(target) !== languagesOf(series),
  );
  const canMove =
    !moving && (toLibrary || (Boolean(target) && number > 0 && !clash));

  const handleMove = async () => {
    if (!canMove) return;
    setMoving(true);
    setError("");
    try {
      const res = await safeFetch(`/api/series/chapters/${chapter.id}/move`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          toLibrary
            ? { oneshot: true, keepSettings }
            : { seriesId: target!.id, chapterNumber: number, keepSettings },
        ),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 409 && typeof body?.nextFreeNumber === "number") {
          setNumber(body.nextFreeNumber);
        }
        setError(body?.message || body?.detail || "The move failed.");
        return;
      }
      onMoved(body as MoveChapterResult);
      onClose();
    } catch {
      setError("The move failed.");
    } finally {
      setMoving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={moving ? undefined : onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>Move {label}</DialogTitle>
      <DialogContent dividers>
        <Typography
          variant="body2"
          sx={{ color: "text.secondary", mb: 2 }}
        >
          From {series.title}. Its pages, edits and renders move with it;
          nothing is translated again.
        </Typography>
        <Autocomplete
          options={destinations}
          value={destination}
          onChange={(_, value) => {
            setDestination(value);
            setTaken(null);
            setError("");
          }}
          getOptionLabel={(option) => option.label}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Move to"
              placeholder="Search series"
            />
          )}
        />

        {target && (
          <TextField
            label="Chapter number"
            type="number"
            value={number}
            onChange={(e) => setNumber(parseFloat(e.target.value) || 0)}
            error={clash}
            helperText={
              clash
                ? `${target.title} already has chapter ${number}. Next free: ${nextFree(taken ?? [])}.`
                : " "
            }
            fullWidth
            margin="normal"
          />
        )}
        {toLibrary && (
          <Typography
            variant="body2"
            sx={{ color: "text.secondary", mt: 2 }}
          >
            It becomes a one-shot titled{" "}
            <strong>
              {chapter.title ||
                `${series.title} — Chapter ${chapter.chapterNumber}`}
            </strong>
            , with {series.title}&apos;s languages and reading direction.
          </Typography>
        )}

        {languagesDiffer && target && (
          <Alert
            severity="warning"
            sx={{ mt: 1 }}
          >
            {target.title} translates {languagesOf(target)}; this chapter was
            translated {languagesOf(series)}. You can still move it.
          </Alert>
        )}

        <FormControlLabel
          sx={{ mt: 1 }}
          control={
            <Checkbox
              checked={keepSettings}
              onChange={(e) => setKeepSettings(e.target.checked)}
            />
          }
          label="Keep this chapter's models and settings"
        />
        <Typography
          variant="body2"
          sx={{ color: "text.secondary" }}
        >
          {keepSettings
            ? "Anything it would otherwise pick up from the new series is set on the chapter."
            : "Anything not set on the chapter comes from the new series."}
        </Typography>

        {error && (
          <Alert
            severity="error"
            sx={{ mt: 2 }}
          >
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button
          onClick={onClose}
          disabled={moving}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleMove}
          disabled={!canMove}
          startIcon={
            moving ? (
              <CircularProgress
                size={16}
                color="inherit"
              />
            ) : null
          }
        >
          {moving ? "Moving…" : "Move"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default MoveChapterDialog;
