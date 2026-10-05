import JSZip from "jszip";
import { describe, it, expect } from "vitest";
import {
  buildOrderedArchive,
  keepEntry,
  naturalCompare,
  readArchivePages,
} from "../../utils/zipPages";

const zipOf = async (files: Record<string, string>) => {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "blob" });
};

describe("zipPages: the gallery shows what the backend would import", () => {
  it("orders pages naturally, like archive.rs natural_cmp", () => {
    const names = [
      "10.png",
      "2.png",
      "1.png",
      "chapter/11.webp",
      "chapter/3.webp",
    ];
    expect([...names].sort(naturalCompare)).toEqual([
      "1.png",
      "2.png",
      "10.png",
      "chapter/3.webp",
      "chapter/11.webp",
    ]);
  });

  it("matches archive.rs natural_cmp case for case", () => {
    // The cases from archive.rs's own tests.
    const sorted = (names: string[]) => [...names].sort(naturalCompare);
    expect(naturalCompare("007.png", "8.png")).toBeLessThan(0);
    expect(naturalCompare("7.png", "008.png")).toBeLessThan(0);
    expect(naturalCompare("010.png", "9.png")).toBeGreaterThan(0);
    expect(naturalCompare("007.png", "7.png")).not.toBe(0);
    expect(
      sorted(["ch1/10.jpg", "ch1/2.jpg", "ch10/1.jpg", "ch2/1.jpg"]),
    ).toEqual(["ch1/2.jpg", "ch1/10.jpg", "ch2/1.jpg", "ch10/1.jpg"]);
    expect(sorted(["Page10.png", "page2.png", "PAGE1.png"])).toEqual([
      "PAGE1.png",
      "page2.png",
      "Page10.png",
    ]);
    expect(naturalCompare("a.png", "A.png")).not.toBe(0);
    expect(
      naturalCompare(
        "9999999999999999999999999999999999999999.png",
        "10000000000000000000000000000000000000000.png",
      ),
    ).toBeLessThan(0);
  });

  it("orders non-ASCII names by byte, as the backend does, not by locale", () => {
    // A locale collator puts é next to e, before z; the backend compares UTF-8 bytes.
    expect([..."é.jpg z.jpg".split(" ")].sort(naturalCompare)).toEqual([
      "z.jpg",
      "é.jpg",
    ]);
  });

  it("skips macOS forks and hidden files, like archive.rs keep", () => {
    expect(keepEntry("__MACOSX/._1.png")).toBe(false);
    expect(keepEntry("chapter/.DS_Store")).toBe(false);
    expect(keepEntry(".hidden.png")).toBe(false);
    expect(keepEntry("chapter/1.png")).toBe(true);
  });

  it("reads only image entries, in natural order, and flags project archives", async () => {
    const chapter = await readArchivePages(
      await zipOf({
        "ch/10.png": "ten",
        "ch/2.jpg": "two",
        "ch/notes.txt": "not a page",
        "__MACOSX/ch/._2.jpg": "junk",
      }),
    );
    expect(chapter.pages.map((p) => p.id)).toEqual(["ch/2.jpg", "ch/10.png"]);
    expect(chapter.pages.map((p) => p.name)).toEqual(["2.jpg", "10.png"]);
    expect(chapter.isProjectArchive).toBe(false);

    const project = await readArchivePages(
      await zipOf({ "project.json": "{}", "original.png": "x" }),
    );
    expect(project.isProjectArchive).toBe(true);
  });

  it("filters and orders by the stored name, as archive.rs does, not JSZip's resolved one", async () => {
    // JSZip resolves `chapter/./2.png` to `chapter/2.png` and `ch//10.png` to `ch/10.png`.
    // archive.rs reads the stored names: the first holds "/." so `keep` drops it, and the
    // second sorts before `ch/2.png` because "/" is below "2" (CodeRabbit on #222).
    const dotted = await readArchivePages(
      await zipOf({ "chapter/./2.png": "two", "chapter/1.png": "one" }),
    );
    expect(dotted.pages.map((p) => p.id)).toEqual(["chapter/1.png"]);

    const doubled = await readArchivePages(
      await zipOf({ "ch/2.png": "two", "ch//10.png": "ten" }),
    );
    expect(doubled.pages.map((p) => p.id)).toEqual(["ch/10.png", "ch/2.png"]);
  });

  it("rebuilds an archive whose names put the pages in the chosen order", async () => {
    const { pages } = await readArchivePages(
      await zipOf({ "a/1.png": "one", "a/2.jpg": "two", "a/3.webp": "three" }),
    );
    // Drop page 2, put page 3 first.
    const blob = await buildOrderedArchive([pages[2], pages[0]]);
    const rebuilt = await JSZip.loadAsync(blob);
    const names = Object.keys(rebuilt.files).sort(naturalCompare);
    expect(names).toEqual(["0001.webp", "0002.png"]);
    expect(await rebuilt.file("0001.webp")!.async("string")).toBe("three");
    expect(await rebuilt.file("0002.png")!.async("string")).toBe("one");
  });
});
