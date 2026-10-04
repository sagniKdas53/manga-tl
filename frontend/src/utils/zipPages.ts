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
 * archive.rs `natural_cmp`: digit runs compare by value, so `2.webp` comes before `10.webp`.
 * `Intl.Collator`'s numeric mode is the same rule for every name an archive realistically has.
 */
const collator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
export const naturalCompare = (a: string, b: string): number =>
  collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

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

export const readArchivePages = async (
  file: Blob,
): Promise<ArchiveContents> => {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter(
    (entry) => !entry.dir && keepEntry(entry.name),
  );
  const isProjectArchive = entries.some((entry) =>
    entry.name.toLowerCase().endsWith("project.json"),
  );
  const images = entries
    .filter((entry) => extensionOf(entry.name))
    .sort((a, b) => naturalCompare(a.name, b.name));

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
