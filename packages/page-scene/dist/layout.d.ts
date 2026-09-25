export interface FitResult {
    fontSize: number;
    lines: string[];
    overflow: boolean;
    lineCenters?: number[];
}
export interface TextBoxInset {
    paddingPx: number;
    safetyPercent: number;
}
export declare const DEFAULT_TEXT_BOX_INSET: TextBoxInset;
/**
 * System Settings' text-box geometry: padding as a percentage of each box's shorter side, capped
 * at a max px (either 0 turns padding off), then the share of the rest text may use. The backend
 * resolves the same rule per box for the renderer (`TextBoxGeometry::padding_px`); the editor
 * resolves it here, so both fit text into the same rectangle.
 */
export interface TextBoxGeometry {
    paddingPercent: number;
    paddingMaxPx: number;
    safetyPercent: number;
}
/** Reproduces the pre-settings export: 4 px on any box at least 100 px across, no shrink. */
export declare const DEFAULT_TEXT_BOX_GEOMETRY: TextBoxGeometry;
/** The inset for one box under `geometry`. */
export declare function insetForBox(box: {
    width: number;
    height: number;
}, geometry?: TextBoxGeometry): TextBoxInset;
export interface FitBox {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface FitTextInput {
    text: string;
    maxWidth: number;
    maxHeight: number;
    fontFamily: string;
    defaultFontSize?: number;
    shape?: "rectangular" | "elliptical";
    boxX?: number;
    boxY?: number;
    maskPolygon?: string | null;
    fontWeight?: string;
    fontStyle?: string;
}
export type TextMeasurer = (font: string, text: string) => number;
export declare function textFitBox(box: FitBox, inset?: TextBoxInset): FitBox;
export declare function clampLineCenter(center: number, lineWidth: number, boxX: number, boxWidth: number): number;
export declare function fitTextInBox({ text, maxWidth, maxHeight, fontFamily, defaultFontSize, shape, boxX, boxY, maskPolygon, fontWeight, fontStyle, }: FitTextInput, measureText: TextMeasurer): FitResult;
