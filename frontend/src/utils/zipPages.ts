import JSZip from "jszip";

/**
 * Reading a chapter archive in the browser, so the import dialog can show its pages and let the
 * user drop or reorder them before anything is uploaded (UI overhaul, #217).
 *
 * The filters mirror `backend-rust/src/archive.rs` exactly: the gallery must show the pages the
 * backend would import, no more and no fewer. If the two drift, the preview lies.
 */

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** archive.rs `keep`: skip macOS resource forks and hidden files. */
export const keepEntry = (name: string): boolean => {
  const lower = name.toLowerCase();
  return !(
    lower.includes("__macosx") ||
    lower.includes("/.") ||
    name.startsWith(".")
  );
};

export const extensionOf = (name: string): string | null => {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
};

/**
 * archive.rs `natural_cmp`, ported byte for byte: digit runs compare by value (`2.webp` before
 * `10.webp`), ASCII letters ignore case, and the exact bytes break ties. It works on UTF-8 bytes
 * as the backend does. `Intl.Collator` was close but not equal: it orders accented letters by
 * locale (`é` before `z`) where the backend orders by byte (`z` first), so an untouched archive
 * could import in a different order than the preview showed (CodeRabbit on #222).
 */
const utf8 = new TextEncoder();

const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;
const asciiLower = (byte: number) =>
  byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;

const endOfDigits = (bytes: Uint8Array, from: number) => {
  let end = from;
  while (end < bytes.length && isDigit(bytes[end])) end++;
  return end;
};

/** Leaves at least one digit, so an all-zero run keeps a value. */
const firstSignificant = (bytes: Uint8Array, from: number, end: number) => {
  let i = from;
  while (i + 1 < end && bytes[i] === 0x30) i++;
  return i;
};

const compareBytes = (
  l: Uint8Array,
  lFrom: number,
  lEnd: number,
  r: Uint8Array,
  rFrom: number,
  rEnd: number,
) => {
  const n = Math.min(lEnd - lFrom, rEnd - rFrom);
  for (let k = 0; k < n; k++) {
    const d = l[lFrom + k] - r[rFrom + k];
    if (d !== 0) return d;
  }
  return lEnd - lFrom - (rEnd - rFrom);
};

export const naturalCompare = (left: string, right: string): number => {
  const l = utf8.encode(left);
  const r = utf8.encode(right);
  let i = 0;
  let j = 0;
  while (i < l.length && j < r.length) {
    const a = l[i];
    const b = r[j];
    const aDigit = isDigit(a);
    const bDigit = isDigit(b);
    if (aDigit && bDigit) {
      const aEnd = endOfDigits(l, i);
      const bEnd = endOfDigits(r, j);
      const aSig = firstSignificant(l, i, aEnd);
      const bSig = firstSignificant(r, j, bEnd);
      // By value: the longer significant run is bigger, else compare digit by digit.
      const byValue =
        aEnd - aSig - (bEnd - bSig) ||
        compareBytes(l, aSig, aEnd, r, bSig, bEnd);
      if (byValue !== 0) return byValue;
      i = aEnd;
      j = bEnd;
    } else if (aDigit !== bDigit) {
      // A digit and a letter have no numeric relationship; the raw bytes decide.
      return a - b;
    } else {
      const d = asciiLower(a) - asciiLower(b);
      if (d !== 0) return d;
      i++;
      j++;
    }
  }
  // Whatever is left decides: the shorter name first, then the exact bytes.
  return (
    l.length - i - (r.length - j) ||
    compareBytes(l, 0, l.length, r, 0, r.length)
  );
};

export interface ArchivePage {
  /** The entry's full path inside the archive; unique, so it doubles as an id. */
  id: string;
  name: string;
  extension: string;
  thumbUrl: string;
  /** The page's bytes, read from the archive only when an import needs them. */
  read: () => Promise<Uint8Array>;
}

export interface ArchiveContents {
  pages: ArchivePage[];
  /** A page-project archive (has `project.json`): that is Import project, not a chapter. */
  isProjectArchive: boolean;
}

/**
 * The name as stored in the archive. JSZip resolves `.`, `..` and `//` in `entry.name`, but
 * archive.rs filters and sorts the stored name, so the preview must too: `chapter/./2.png`
 * would otherwise show a page the backend drops (CodeRabbit on #222).
 */
const storedName = (entry: JSZip.JSZipObject): string =>
  entry.unsafeOriginalName ?? entry.name;

export const readArchivePages = async (
  file: Blob,
): Promise<ArchiveContents> => {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter(
    (entry) => !entry.dir && keepEntry(storedName(entry)),
  );
  const isProjectArchive = entries.some((entry) =>
    storedName(entry).toLowerCase().endsWith("project.json"),
  );
  const images = entries
    .filter((entry) => extensionOf(storedName(entry)))
    .sort((a, b) => naturalCompare(storedName(a), storedName(b)));

  // One copy per page in memory: JSZip's, plus a Blob behind each thumbnail. The bytes are not
  // also held as an array; `read` pulls them from the archive at import time.
  const pages = await Promise.all(
    images.map(async (entry) => {
      const extension = extensionOf(entry.name)!;
      const raw = await entry.async("blob");
      const blob = new Blob([raw], { type: MIME_BY_EXTENSION[extension] });
      return {
        id: entry.name,
        name: entry.name.split("/").pop() || entry.name,
        extension,
        thumbUrl: URL.createObjectURL(blob),
        read: () => entry.async("uint8array"),
      };
    }),
  );
  return { pages, isProjectArchive };
};

export const releaseArchivePages = (pages: ArchivePage[]) => {
  pages.forEach((page) => URL.revokeObjectURL(page.thumbUrl));
};

/**
 * A new archive holding exactly the chosen pages, named `0001.png`, `0002.jpg`, … in the chosen
 * order. The backend sorts entries naturally by name, so zero-padded positions are the order.
 * No server change is needed for removing or reordering pages.
 */
export const buildOrderedArchive = async (
  pages: ArchivePage[],
  /** 0–100. Rebuilding a 400-page chapter takes about 15 s on a laptop, so say how far it got. */
  onProgress?: (percent: number) => void,
): Promise<Blob> => {
  const zip = new JSZip();
  const width = Math.max(4, String(pages.length).length);
  for (const [index, page] of pages.entries()) {
    zip.file(
      `${String(index + 1).padStart(width, "0")}${page.extension}`,
      await page.read(),
    );
  }
  return zip.generateAsync({ type: "blob", compression: "STORE" }, (meta) =>
    onProgress?.(meta.percent),
  );
};

export const isChapterArchiveFile = (file: File): boolean =>
  /\.(zip|cbz|epub)$/i.test(file.name);
