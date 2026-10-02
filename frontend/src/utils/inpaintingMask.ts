/** The mask editor's pure helpers: what a brushed canvas becomes before it is sent. */

export interface MarkBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The smallest box holding every marked pixel (alpha > 0), or null when nothing is marked. */
export function markBounds(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): MarkBounds | null {
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (rgba[row + x * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** The marked pixels of one box as an opaque-white / transparent mask, what the backend reads. */
export function binaryMask(
  rgba: Uint8ClampedArray,
  width: number,
  box: MarkBounds,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const from = ((box.y + y) * width + (box.x + x)) * 4;
      const to = (y * box.width + x) * 4;
      if (rgba[from + 3] > 0) {
        out[to] = out[to + 1] = out[to + 2] = out[to + 3] = 255;
      }
    }
  }
  return out;
}
