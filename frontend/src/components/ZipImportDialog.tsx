import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import CloseIcon from "@mui/icons-material/Close";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import RestoreIcon from "@mui/icons-material/Restore";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import type { Chapter, Series, SystemSettingsDto, User } from "../types";
import { safeFetch } from "../utils";
import {
  buildOrderedArchive,
  isChapterArchiveFile,
  naturalCompare,
  readArchivePages,
  releaseArchivePages,
  type ArchivePage,
} from "../utils/zipPages";
import { fetchHighestChapterNumber } from "./chapterNumbering";
import ModelOverridesAccordion, {
  type ModelOverridesValue,
} from "./ModelOverridesAccordion";

/**
 * Import a chapter archive, after seeing and editing its pages (UI overhaul, #217).
 *
 * The archive is read in the browser. You can remove pages, put them in a different order, and
 * choose where the chapter goes: an existing series, or a new one (with its languages). On
 * import, a new archive is built with exactly the kept pages, named in the chosen order, and sent
 * to the existing import route. Nothing on the server changes.
 *
 * Not here yet, because they need the server: one-shot chapters with no series (#216).
 */

const LANG_OPTS = ["ja", "zh-TW", "zh-CN", "ko", "en"];
const TARGET_OPTS = ["en", "ja", "zh-TW", "zh-CN", "ko"];
const DIR_OPTS = [
  { value: "rtl", label: "Right to left (manga)" },
  { value: "ltr", label: "Left to right (comics)" },
  { value: "ttb", label: "Top to bottom (webtoon)" },
];
const NEW_SERIES = "__new__";

const EMPTY_OVERRIDES: ModelOverridesValue = {
  ocrProvider: "",
  ocrModel: "",
  tlProvider: "",
  tlModel: "",
  qaProvider: "",
  qaLlmModel: "",
  qaVlmModel: "",
  qaMode: "",
  routingStrategy: "",
  cleanupMode: "",
  ocrMergeThreshold: null,
  ocrTextAngle: null,
  useFallbackModels: null,
};

/** "[Group] Some Title (Ch. 3).zip" → "[Group] Some Title (Ch. 3)" */
const titleFromFileName = (name: string) =>
  name.replace(/\.(zip|cbz|epub)$/i, "");

export interface ZipImportDialogProps {
  open: boolean;
  onClose: () => void;
  user: User;
  /** An archive dropped on the page, read as soon as the dialog opens. */
  initialFile?: File | null;
  /** Import into this series (a series page). Without it, the dialog asks where to put it. */
  series?: Series | null;
  onImported: (chapter: Chapter, series: Series, pageCount: number) => void;
}

interface PageItem extends ArchivePage {
  removed: boolean;
}

export const ZipImportDialog: React.FC<ZipImportDialogProps> = ({
  open,
  onClose,
  user,
  initialFile = null,
  series = null,
  onImported,
}) => {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));

  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState("");
  const [items, setItems] = useState<PageItem[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const [seriesOptions, setSeriesOptions] = useState<Series[]>([]);
  const [destination, setDestination] = useState<string>(series?.id ?? "");
  const [newTitle, setNewTitle] = useState("");
  const [sourceLang, setSourceLang] = useState("ja");
  const [targetLang, setTargetLang] = useState("en");
  const [direction, setDirection] = useState("rtl");

  const [chapterNum, setChapterNum] = useState(1);
  const numberTouchedRef = useRef(false);
  const [chapterTitle, setChapterTitle] = useState("");

  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [overrides, setOverrides] =
    useState<ModelOverridesValue>(EMPTY_OVERRIDES);

  const [importing, setImporting] = useState(false);
  const [buildPercent, setBuildPercent] = useState<number | null>(null);
  const [importError, setImportError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const targetSeries = useMemo<Series | null>(
    () =>
      series ??
      seriesOptions.find((candidate) => candidate.id === destination) ??
      null,
    [series, seriesOptions, destination],
  );
  const isNewSeries = !series && destination === NEW_SERIES;

  // --- reading the archive ----------------------------------------------------------------

  // Each read gets a number. A read that finishes after a newer file was chosen, or after the
  // dialog closed, is released instead of shown, so the preview never belongs to another file.
  const loadSeqRef = useRef(0);
  const loadFile = useCallback(async (next: File) => {
    const seq = ++loadSeqRef.current;
    setFile(next);
    setReadError("");
    setReading(true);
    setItems((prev) => {
      releaseArchivePages(prev);
      return [];
    });
    try {
      const { pages, isProjectArchive } = await readArchivePages(next);
      if (seq !== loadSeqRef.current) {
        releaseArchivePages(pages);
        return;
      }
      if (isProjectArchive) {
        releaseArchivePages(pages);
        setReadError(
          "This is a page project archive. Open the chapter and use Import project (ZIP) instead.",
        );
      } else if (pages.length === 0) {
        setReadError(
          "No pages found. The archive needs PNG, JPG, WebP or GIF images.",
        );
      } else {
        setItems(pages.map((page) => ({ ...page, removed: false })));
        setNewTitle((current) => current || titleFromFileName(next.name));
      }
    } catch {
      if (seq !== loadSeqRef.current) return;
      setReadError(
        "This file could not be read as a ZIP, CBZ or ePub archive.",
      );
    } finally {
      if (seq === loadSeqRef.current) setReading(false);
    }
  }, []);
  // Closing ends any read still running and lets go of the previews: a 400-page archive holds
  // one Blob per page until they are released, and the dialog stays mounted while closed.
  useEffect(() => {
    if (open) return;
    loadSeqRef.current++;
    Promise.resolve().then(() =>
      setItems((prev) => {
        releaseArchivePages(prev);
        return prev.length ? [] : prev;
      }),
    );
  }, [open]);

  // Reset every time the dialog opens; read a dropped file straight away.
  useEffect(() => {
    if (!open) return;
    Promise.resolve().then(() => {
      setImportError("");
      setReadError("");
      setChapterTitle("");
      setNewTitle("");
      setOverrides(EMPTY_OVERRIDES);
      setOverridesOpen(false);
      numberTouchedRef.current = false;
      setDestination(series?.id ?? "");
      if (initialFile) void loadFile(initialFile);
      else {
        setFile(null);
        setItems((prev) => {
          releaseArchivePages(prev);
          return [];
        });
      }
    });
  }, [open, initialFile, series, loadFile]);

  // Object URLs outlive the component unless released.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(
    () => () => {
      loadSeqRef.current++;
      releaseArchivePages(itemsRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    safeFetch("/api/settings", {
      headers: { Authorization: `Bearer ${user.token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setSettings(d))
      .catch(() => {});
    if (series) return;
    safeFetch("/api/series?page=0&size=100&sortBy=updatedAt&sortDir=desc", {
      headers: { Authorization: `Bearer ${user.token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list: Series[] = d?.content ?? [];
        setSeriesOptions(list);
        setDestination((current) => current || list[0]?.id || NEW_SERIES);
      })
      .catch(() => setDestination((current) => current || NEW_SERIES));
  }, [open, series, user.token]);

  // Suggest the next chapter number of the chosen series (AUDIT-F18: ask the server, the loaded
  // list is only one page). A number the user typed is never overwritten.
  useEffect(() => {
    if (!open) return;
    if (isNewSeries) {
      if (!numberTouchedRef.current)
        Promise.resolve().then(() => setChapterNum(1));
      return;
    }
    if (!targetSeries) return;
    let cancelled = false;
    void fetchHighestChapterNumber(targetSeries.id, user.token)
      .then((highest) => {
        if (cancelled || numberTouchedRef.current) return;
        setChapterNum((highest ?? 0) + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, isNewSeries, targetSeries, user.token]);

  // While the dialog is open, a file dropped anywhere (on the backdrop, between tiles) is taken
  // as "choose another file" instead of making the browser open it and leave the app.
  const pickFileRef = useRef<(next: File | undefined) => void>(() => {});
  useEffect(() => {
    if (!open) return;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!importing) pickFileRef.current(e.dataTransfer?.files?.[0]);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [open, importing]);

  // --- editing the page list ---------------------------------------------------------------

  const kept = items.filter((item) => !item.removed);
  const removedCount = items.length - kept.length;
  const positionOf = useMemo(() => {
    const map = new Map<string, number>();
    items
      .filter((item) => !item.removed)
      .forEach((item, index) => map.set(item.id, index + 1));
    return map;
  }, [items]);

  const toggleRemoved = (id: string) =>
    setItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, removed: !item.removed } : item,
      ),
    );

  const move = (id: string, delta: number) =>
    setItems((prev) => {
      const from = prev.findIndex((item) => item.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    setItems((prev) => {
      const from = prev.findIndex((item) => item.id === dragId);
      const to = prev.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const sortByName = () =>
    setItems((prev) => [...prev].sort((a, b) => naturalCompare(a.id, b.id)));
  const reverse = () => setItems((prev) => [...prev].reverse());
  const restoreAll = () =>
    setItems((prev) => prev.map((item) => ({ ...item, removed: false })));
  const isReordered = items.some(
    (item, index, all) =>
      index > 0 && naturalCompare(all[index - 1].id, item.id) > 0,
  );

  // --- importing ---------------------------------------------------------------------------

  const canImport =
    kept.length > 0 &&
    !importing &&
    chapterNum > 0 &&
    (isNewSeries ? newTitle.trim().length > 0 : Boolean(targetSeries));

  const createSeries = async (): Promise<Series> => {
    const res = await safeFetch("/api/series", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: newTitle.trim(),
        originalLanguage: sourceLang,
        sourceLanguage: sourceLang,
        targetLanguage: targetLang,
        readingDirection: direction,
      }),
    });
    if (!res.ok) throw new Error("Could not create the series.");
    return res.json();
  };

  const handleImport = async () => {
    if (!canImport || !file) return;
    setImportError("");
    setImporting(true);
    try {
      let into: Series;
      if (isNewSeries) {
        into = await createSeries();
        // Point the dialog at the series just made, so a retry after a failed upload imports
        // into it instead of creating a second one.
        setSeriesOptions((prev) => [into, ...prev]);
        setDestination(into.id);
      } else {
        into = targetSeries!;
      }
      const formData = new FormData();
      if (removedCount === 0 && !isReordered) {
        // Nothing was changed: send the archive as it came, without unpacking and re-zipping.
        formData.append("file", file, file.name);
      } else {
        const archive = await buildOrderedArchive(kept, (percent) =>
          setBuildPercent(Math.round(percent)),
        );
        setBuildPercent(null);
        formData.append("file", archive, `${titleFromFileName(file.name)}.zip`);
      }
      formData.append("chapterNumber", String(chapterNum));
      formData.append("title", chapterTitle);
      const o = overrides;
      if (o.ocrProvider) formData.append("ocrProvider", o.ocrProvider);
      if (o.ocrModel) formData.append("ocrModel", o.ocrModel);
      if (o.tlProvider) formData.append("tlProvider", o.tlProvider);
      if (o.tlModel) formData.append("tlModel", o.tlModel);
      if (o.qaProvider) formData.append("qaProvider", o.qaProvider);
      if (o.qaLlmModel) formData.append("qaLlmModel", o.qaLlmModel);
      if (o.qaVlmModel) formData.append("qaVlmModel", o.qaVlmModel);
      if (o.qaMode) formData.append("qaMode", o.qaMode);
      if (o.routingStrategy)
        formData.append("routingStrategy", o.routingStrategy);
      if (o.cleanupMode) formData.append("cleanupMode", o.cleanupMode);
      if (o.ocrMergeThreshold !== null)
        formData.append("ocrMergeThreshold", String(o.ocrMergeThreshold));
      if (o.ocrTextAngle !== null)
        formData.append("ocrTextAngle", String(o.ocrTextAngle));
      // Only a value set on this chapter is sent. The backend reads any value other than "true"
      // as false, so sending "null" (or the series' value) would pin the chapter instead of
      // letting it inherit.
      if (o.useFallbackModels !== null)
        formData.append("useFallbackModels", String(o.useFallbackModels));

      const res = await safeFetch(`/api/series/${into.id}/chapters/import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData,
      } as RequestInit);
      if (!res.ok) {
        const text = await res.text();
        let message = "The import failed.";
        try {
          message = JSON.parse(text).message || message;
        } catch {
          if (text) message = text;
        }
        throw new Error(message);
      }
      const chapter: Chapter = await res.json();
      onImported(chapter, into, kept.length);
      onClose();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
      setBuildPercent(null);
    }
  };

  // --- rendering ---------------------------------------------------------------------------

  const pickFile = (next: File | undefined) => {
    if (!next) return;
    if (!isChapterArchiveFile(next)) {
      setReadError("Choose a .zip, .cbz or .epub file.");
      return;
    }
    void loadFile(next);
  };
  useEffect(() => {
    pickFileRef.current = pickFile;
  });

  const inherited = {
    ocrProvider: targetSeries?.ocrProvider || settings?.ocrProvider,
    ocrModel: targetSeries?.ocrModel || settings?.ocrModel,
    tlProvider: targetSeries?.tlProvider || settings?.tlProvider,
    tlModel: targetSeries?.tlModel || settings?.tlModel,
    qaProvider: targetSeries?.qaProvider || settings?.qaProvider,
    qaMode: targetSeries?.qaMode || settings?.qaMode,
    qaLlmModel: targetSeries?.qaLlmModel || settings?.qaLlmModel,
    qaVlmModel: targetSeries?.qaVlmModel || settings?.qaVlmModel,
    routingStrategy: targetSeries?.routingStrategy || settings?.routingStrategy,
    cleanupMode: targetSeries?.cleanupMode || settings?.cleanupMode,
    ocrMergeThreshold:
      targetSeries?.ocrMergeThreshold ?? settings?.ocrMergeThreshold,
    ocrTextAngle: targetSeries?.ocrTextAngle ?? settings?.ocrTextAngle,
    useFallbackModels:
      targetSeries?.useFallbackModels ?? settings?.useFallbackModels,
  };

  return (
    <Dialog
      open={open}
      onClose={importing ? undefined : onClose}
      maxWidth="md"
      fullWidth
      fullScreen={fullScreen}
      aria-labelledby="zip-import-title"
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 1,
          px: 3,
          pt: 2.5,
          pb: 1.5,
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            id="zip-import-title"
            variant="h6"
            component="h2"
            sx={{ fontSize: "1.25rem" }}
          >
            Import chapter
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {file
              ? file.name
              : series
                ? `Into ${series.title}`
                : "A ZIP, CBZ or ePub of page images"}
          </Typography>
        </Box>
        <IconButton
          aria-label="Close"
          onClick={onClose}
          disabled={importing}
        >
          <CloseIcon />
        </IconButton>
      </Box>

      <DialogContent sx={{ pt: 0 }}>
        <input
          ref={fileInputRef}
          type="file"
          hidden
          accept=".zip,.cbz,.epub,application/zip,application/epub+zip"
          data-testid="zip-import-file"
          onChange={(e) => {
            pickFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />

        {/* 1. The pages ------------------------------------------------------------------ */}
        {items.length === 0 ? (
          <Box
            sx={{
              border: "1.5px dashed",
              borderColor: "divider",
              borderRadius: "8px",
              py: 6,
              px: 2,
              textAlign: "center",
              bgcolor: "action.hover",
            }}
          >
            {reading ? (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 1.5,
                }}
              >
                <CircularProgress size={18} />
                <Typography>Reading {file?.name}…</Typography>
              </Box>
            ) : (
              <>
                <UploadFileIcon
                  sx={{ fontSize: 36, color: "text.secondary" }}
                />
                <Typography sx={{ fontWeight: 600, mt: 1 }}>
                  Drop an archive here
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ color: "text.secondary", mb: 2 }}
                >
                  You can check, remove and reorder its pages before importing.
                </Typography>
                <Button
                  variant="outlined"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose a file
                </Button>
              </>
            )}
          </Box>
        ) : (
          <>
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 1,
                mb: 1.5,
              }}
            >
              <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 180 }}>
                {kept.length} of {items.length} pages
                {removedCount > 0 && (
                  <Button
                    size="small"
                    onClick={restoreAll}
                    sx={{ ml: 1 }}
                  >
                    Restore {removedCount} removed
                  </Button>
                )}
              </Typography>
              {isReordered && (
                <Button
                  size="small"
                  variant="outlined"
                  onClick={sortByName}
                >
                  Sort by file name
                </Button>
              )}
              <Button
                size="small"
                variant="outlined"
                onClick={reverse}
              >
                Reverse order
              </Button>
              <Button
                size="small"
                variant="outlined"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose another file
              </Button>
            </Box>
            <Typography
              variant="body2"
              sx={{ color: "text.secondary", mb: 1.5 }}
            >
              Drag a page to move it, or use the arrows. Removed pages stay
              here, faded, until you import.
            </Typography>

            <Box
              role="list"
              aria-label="Pages to import"
              sx={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))",
                gap: 1.25,
                maxHeight: { xs: "none", sm: 360 },
                overflowY: "auto",
                p: 0.5,
                mx: -0.5,
              }}
            >
              {items.map((item, index) => {
                const position = positionOf.get(item.id);
                const isDropTarget =
                  dropTargetId === item.id && dragId !== item.id;
                return (
                  <Box
                    key={item.id}
                    role="listitem"
                    aria-label={
                      item.removed
                        ? `${item.name}, removed`
                        : `Page ${position}, ${item.name}`
                    }
                    draggable={!item.removed}
                    onDragStart={(e) => {
                      setDragId(item.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnter={() => dragId && setDropTargetId(item.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      // Only a page being moved is handled here. A file dragged in from
                      // outside falls through to the dialog's window-level drop handler.
                      if (!dragId) return;
                      e.preventDefault();
                      e.stopPropagation();
                      dropOn(item.id);
                      setDragId(null);
                      setDropTargetId(null);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropTargetId(null);
                    }}
                    sx={{
                      position: "relative",
                      borderRadius: "4px",
                      outline: isDropTarget ? "2px solid" : "none",
                      outlineColor: "primary.main",
                      outlineOffset: 2,
                      opacity: dragId === item.id ? 0.4 : 1,
                      cursor: item.removed ? "default" : "grab",
                      "&:hover .page-tools, &:focus-within .page-tools": {
                        opacity: 1,
                      },
                    }}
                  >
                    <Box
                      sx={{
                        aspectRatio: "2 / 3",
                        borderRadius: "4px",
                        overflow: "hidden",
                        bgcolor: "background.default",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Box
                        component="img"
                        src={item.thumbUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                        sx={{
                          width: "100%",
                          height: "100%",
                          objectFit: "contain",
                          filter: item.removed ? "grayscale(1)" : "none",
                          opacity: item.removed ? 0.3 : 1,
                        }}
                      />
                    </Box>
                    {/* Position, bottom-left: the order is the point of this view. */}
                    <Box
                      sx={{
                        position: "absolute",
                        left: 4,
                        bottom: 4,
                        px: 0.75,
                        borderRadius: "3px",
                        fontSize: "0.75rem",
                        fontWeight: 700,
                        bgcolor: item.removed
                          ? "transparent"
                          : "rgba(0,0,0,0.72)",
                        color: item.removed ? "text.secondary" : "#fff",
                      }}
                    >
                      {item.removed ? "Removed" : position}
                    </Box>
                    <Tooltip title={item.removed ? "Put back" : "Remove page"}>
                      <IconButton
                        size="small"
                        aria-label={
                          item.removed
                            ? `Put back ${item.name}`
                            : `Remove ${item.name}`
                        }
                        onClick={() => toggleRemoved(item.id)}
                        sx={{
                          position: "absolute",
                          top: 4,
                          right: 4,
                          width: 26,
                          height: 26,
                          bgcolor: "rgba(0,0,0,0.72)",
                          color: "#fff",
                          "&:hover": { bgcolor: "rgba(0,0,0,0.85)" },
                        }}
                      >
                        {item.removed ? (
                          <RestoreIcon sx={{ fontSize: 16 }} />
                        ) : (
                          <CloseIcon sx={{ fontSize: 16 }} />
                        )}
                      </IconButton>
                    </Tooltip>
                    {!item.removed && (
                      <Box
                        className="page-tools"
                        sx={{
                          position: "absolute",
                          right: 4,
                          bottom: 4,
                          display: "flex",
                          gap: 0.25,
                          opacity: { xs: 1, md: 0 },
                          transition: "opacity 0.12s ease",
                        }}
                      >
                        <IconButton
                          size="small"
                          aria-label={`Move ${item.name} earlier`}
                          disabled={index === 0}
                          onClick={() => move(item.id, -1)}
                          sx={{
                            width: 24,
                            height: 24,
                            bgcolor: "rgba(0,0,0,0.72)",
                            color: "#fff",
                            "&:hover": { bgcolor: "rgba(0,0,0,0.85)" },
                          }}
                        >
                          <ChevronLeftIcon sx={{ fontSize: 18 }} />
                        </IconButton>
                        <IconButton
                          size="small"
                          aria-label={`Move ${item.name} later`}
                          disabled={index === items.length - 1}
                          onClick={() => move(item.id, 1)}
                          sx={{
                            width: 24,
                            height: 24,
                            bgcolor: "rgba(0,0,0,0.72)",
                            color: "#fff",
                            "&:hover": { bgcolor: "rgba(0,0,0,0.85)" },
                          }}
                        >
                          <ChevronRightIcon sx={{ fontSize: 18 }} />
                        </IconButton>
                      </Box>
                    )}
                  </Box>
                );
              })}
            </Box>
          </>
        )}

        {readError && (
          <Alert
            severity="warning"
            sx={{ mt: 2 }}
          >
            {readError}
          </Alert>
        )}

        {/* 2. Where it goes --------------------------------------------------------------- */}
        <Box
          sx={{
            mt: 3,
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "2fr 1fr 2fr" },
            gap: 2,
          }}
        >
          {!series && (
            <TextField
              select
              label="Into"
              value={destination}
              onChange={(e) => {
                numberTouchedRef.current = false;
                setDestination(e.target.value);
              }}
              sx={{ gridColumn: { sm: "1 / -1" } }}
            >
              {seriesOptions.map((option) => (
                <MenuItem
                  key={option.id}
                  value={option.id}
                >
                  {option.title}
                </MenuItem>
              ))}
              <MenuItem value={NEW_SERIES}>New series…</MenuItem>
            </TextField>
          )}

          {isNewSeries && (
            <>
              <TextField
                label="Series title"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                required
                sx={{ gridColumn: { sm: "1 / -1" } }}
              />
              <TextField
                select
                label="Translate from"
                value={sourceLang}
                onChange={(e) => setSourceLang(e.target.value)}
              >
                {LANG_OPTS.map((l) => (
                  <MenuItem
                    key={l}
                    value={l}
                  >
                    {l}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                label="Into"
                value={targetLang}
                onChange={(e) => setTargetLang(e.target.value)}
              >
                {TARGET_OPTS.map((l) => (
                  <MenuItem
                    key={l}
                    value={l}
                  >
                    {l}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                label="Reading direction"
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
              >
                {DIR_OPTS.map((d) => (
                  <MenuItem
                    key={d.value}
                    value={d.value}
                  >
                    {d.label}
                  </MenuItem>
                ))}
              </TextField>
            </>
          )}

          {targetSeries && !isNewSeries && (
            <Typography
              variant="body2"
              sx={{ color: "text.secondary", gridColumn: { sm: "1 / -1" } }}
            >
              Translated{" "}
              {targetSeries.sourceLanguage ||
                targetSeries.originalLanguage ||
                "ja"}{" "}
              → {targetSeries.targetLanguage || "en"}, as set on the series.
            </Typography>
          )}

          <TextField
            label="Chapter number"
            type="number"
            value={chapterNum}
            onChange={(e) => {
              numberTouchedRef.current = true;
              setChapterNum(parseFloat(e.target.value) || 0);
            }}
            required
          />
          <TextField
            label="Chapter title"
            value={chapterTitle}
            onChange={(e) => setChapterTitle(e.target.value)}
            placeholder="Optional"
            sx={{ gridColumn: { sm: "span 2" } }}
          />
        </Box>

        {/* 3. How it is processed, collapsed: the defaults are right most of the time. ---- */}
        {!isNewSeries ? (
          <Box sx={{ mt: 2 }}>
            <ModelOverridesAccordion
              token={user.token}
              expanded={overridesOpen}
              onToggle={() => setOverridesOpen(!overridesOpen)}
              value={overrides}
              onChange={(field, value) =>
                setOverrides((prev) => ({ ...prev, [field]: value }))
              }
              settings={settings}
              inherited={inherited}
              ocrModelLabel="OCR Model"
              tlModelLabel="TL Model"
              localOcrModelLabel="Local"
              useResolvedQaModeForDisable={false}
            />
          </Box>
        ) : (
          <Typography
            variant="body2"
            sx={{ color: "text.secondary", mt: 2 }}
          >
            A new series uses your default models. You can change them later
            with Edit series.
          </Typography>
        )}

        {importError && (
          <Alert
            severity="error"
            sx={{ mt: 2 }}
          >
            {importError}
          </Alert>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button
          onClick={onClose}
          disabled={importing}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleImport}
          disabled={!canImport}
          startIcon={
            importing ? (
              <CircularProgress
                size={16}
                color="inherit"
              />
            ) : null
          }
        >
          {importing
            ? buildPercent !== null
              ? `Preparing pages… ${buildPercent}%`
              : "Importing…"
            : kept.length > 0
              ? `Import ${kept.length} ${kept.length === 1 ? "page" : "pages"}`
              : "Import"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ZipImportDialog;
