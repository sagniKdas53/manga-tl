import { type FitBox, type TextMeasurer } from "./layout.js";
export interface SceneAsset {
    href: string;
    width: number;
    height: number;
}
export interface SceneTransform extends FitBox {
    rotationDegrees: number;
}
export interface SceneTextStyle {
    fontFamily: string;
    fill: string;
    stroke: string;
    weight: number;
    padding: number;
}
export interface SceneTextObject {
    objectId: string;
    text: string;
    transform: SceneTransform;
    writingMode: "horizontal-tb" | "vertical-rl" | "vertical-lr";
    alignment: "start" | "center" | "end" | "justify";
    style: SceneTextStyle;
    visible: boolean;
    zIndex: number;
}
export interface SceneCleanupAsset extends SceneAsset {
    cleanupId: string;
    x: number;
    y: number;
    zIndex: number;
    visible: boolean;
}
export interface PageSceneContentInput {
    source: SceneAsset;
    cleanupAssets: SceneCleanupAsset[];
    textObjects: SceneTextObject[];
}
export interface ResolvedLineBox extends FitBox {
    text: string;
}
export interface ResolvedTextObject {
    objectId: string;
    fontSize: number;
    lineBoxes: ResolvedLineBox[];
}
export interface SceneLayoutDiagnostic {
    code: "empty-manual-text" | "object-clips-page" | "text-overflow";
    objectId: string;
}
export interface ResolvedPageScene {
    input: PageSceneContentInput;
    objects: ResolvedTextObject[];
    diagnostics: SceneLayoutDiagnostic[];
}
/**
 * Resolves line geometry from an immutable content input. It owns layout only: source pixels,
 * cleanup pixels, OCR evidence, and editor controls remain outside this pure scene boundary.
 */
export declare function resolvePageScene(input: PageSceneContentInput, measureText: TextMeasurer): ResolvedPageScene;
/**
 * Produces a trusted SVG content scene. It contains source pixels, active cleanup assets, and
 * resolved glyphs only; the static renderer installs this markup into an SVG document directly.
 */
export declare function renderPageSceneSvg(scene: ResolvedPageScene): string;
