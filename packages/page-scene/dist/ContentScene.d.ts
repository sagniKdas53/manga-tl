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
    /** Inset in px on every side, resolved per box by the scene builder from System Settings. */
    padding: number;
    /**
     * Share (1–100) of the padded box text may use. Not in the frozen scene contract: the render
     * job carries the System Settings value and the worker attaches it here. Absent means 100.
     */
    safetyPercent?: number;
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
/**
 * Stroke width as a fraction of the resolved font px (tracker R2, user decision 2 of 2026-09-17).
 * Read off Torii's client (`renderPipelineVectorText`, 2026-09-18): 6 px at 24 px, 8-12 px at
 * 40-77 px, i.e. 15-25 %. The previous 4 % was about five times too thin to read as a halo.
 */
export declare const STROKE_WIDTH_RATIO = 0.18;
/** What the renderer hands back per text object: the font px it settled on and the line breaks. */
export interface ResolvedTextLayout {
    object_id: string;
    font_size: number;
    lines: string[];
}
export declare function resolvedTextLayout(scene: ResolvedPageScene): ResolvedTextLayout[];
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
