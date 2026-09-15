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
