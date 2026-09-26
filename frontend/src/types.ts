export interface User {
  token: string;
  id: string;
  email: string;
  displayName: string;
  role: string;
}

export interface Series {
  id: string;
  title: string;
  originalLanguage: string;
  readingDirection: string;
  coverImageUrl?: string | null;
  sourceLanguage?: string;
  targetLanguage?: string;
  ocrProvider?: string;
  ocrModel?: string;
  tlProvider?: string;
  tlModel?: string;
  qaProvider?: string;
  qaLlmModel?: string;
  qaVlmModel?: string;
  qaMode?: string;
  routingStrategy?: string;
  cleanupMode?: string;
  /** OCR grouping threshold override, in characters; null inherits. */
  ocrMergeThreshold?: number | null;
  useFallbackModels?: boolean | null;
  resolvedUseFallbackModels?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ResolvedModelSlot {
  provider: string;
  model: string;
  source: "global" | "series" | "chapter";
}

export interface ResolvedQaSlot {
  provider: string;
  llmModel: string;
  vlmModel: string;
  mode: string;
  source: "global" | "series" | "chapter";
}

export interface Chapter {
  id: string;
  seriesId: string;
  chapterNumber: number;
  title: string;
  coverImageUrl?: string | null;
  ocrProvider?: string;
  ocrModel?: string;
  tlProvider?: string;
  tlModel?: string;
  qaProvider?: string;
  qaLlmModel?: string;
  qaVlmModel?: string;
  qaMode?: string;
  routingStrategy?: string;
  cleanupMode?: string;
  /** OCR grouping threshold override, in characters; null inherits. */
  ocrMergeThreshold?: number | null;
  useFallbackModels?: boolean | null;
  resolvedUseFallbackModels?: boolean;
  useContextMemory?: boolean;
  pageCount?: number;
  createdAt?: string;
  updatedAt?: string;
  resolvedOcr?: ResolvedModelSlot;
  resolvedTranslation?: ResolvedModelSlot;
  resolvedQa?: ResolvedQaSlot;
}

export interface Page {
  id: string;
  pageNumber: number;
  imageId: string;
  filename: string;
  url: string;
  thumbnailUrl?: string;
  chapterId?: string;
  /**
   * AUDIT-F26. When the pipeline last rendered this page, or null if it never has.
   *
   * Every other field here is fixed at upload, which is why re-fetching `/pages` after a
   * translation used to return identical JSON and the grid could not update. This is the one
   * field a pipeline run changes.
   */
  lastRenderedAt?: string | null;
  /** Thumbnail of the *rendered* page, cache-keyed by `lastRenderedAt`; null until one exists. */
  renderedThumbnailUrl?: string | null;
}

export interface Panel {
  id: string;
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  gridRow: number;
  gridCol: number;
  readingOrder: number;
}

export interface OcrRegion {
  id: string;
  text: string;
  translatedText?: string | null;
  approved?: boolean;
  detectedLanguage: string;
  confidence: number;
  rotation: number;
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  panelReadingOrder: number;
  bubbleReadingOrder: number;
  bubbleX?: number | null;
  bubbleY?: number | null;
  bubbleW?: number | null;
  bubbleH?: number | null;
  backgroundColor?: string | null;
  qaStatus?:
    | "passed"
    | "failed"
    | "direct_fix"
    | "fixed"
    | "reject_sfx"
    | "manual_review"
    | "cleanup_review"
    | "rejected"
    | null;
  translationFailed?: boolean | null;
  regionType?: string | null;
  qaScore?: number | null;
  qaFeedback?: string | null;
  bubbleId?: string | null;
  detectionConfidence?: number | null;
  maskPolygon?: string | null;
  safeTextX?: number | null;
  safeTextY?: number | null;
  safeTextW?: number | null;
  safeTextH?: number | null;
}

export interface ConversationRegion {
  regionId: string;
  position: number;
}

export interface Conversation {
  id: string;
  sceneType: string;
  regions: ConversationRegion[];
}

export interface Layer {
  id: string;
  type: string; // translation | ocr | notes | mask | sfx
  targetLanguage?: string | null;
  // AUDIT-F25. Nullable in the database and `Option<bool>` in the model, so the API really can
  // send `null` and this used to lie about it. A null is *hidden*: that is what the canvas does,
  // what the hidden-count does, and — decisively — what the worker's renderer does
  // (`el.get("visible", True)` returns None for an explicit null, which is falsy), so a null-
  // visible element is absent from the rendered PNG. Read it with a falsy check or `=== true`;
  // never `!== false`.
  visible: boolean | null;
  zOrder: number;
  metadataJson?: Record<string, unknown> | null;
  createdAt: string;
}

export interface LayerElement {
  id: string;
  layerId: string;
  regionId?: string | null;
  region?: OcrRegion | null;
  text?: string | null;
  font?: string | null;
  size?: number | null;
  autoSize: boolean;
  maxWidth?: number | null;
  maxHeight?: number | null;
  wordWrap: boolean;
  rotation: number;
  x: number;
  y: number;
  /** Nullable, and a null is hidden — see the note on {@link Layer.visible}. */
  visible: boolean | null;
  overflow: boolean;
  isManuallyEdited: boolean;
  editedAt?: string | null;
  backgroundColor?: string | null;
  textColor?: string | null;
  fontWeight?: string | null;
  fontStyle?: string | null;
  boxShape?: string | null;
  maskPolygon?: string | null;
  layerType?: string | null;
  layerVisible?: boolean | null;
  layerMetadata?: Record<string, unknown> | null;
}

export interface LayerEditHistory {
  id: string;
  layerElementId: string;
  previousValueJson: string;
  newValueJson: string;
  editedBy?: User | null;
  editedAt: string;
}

export interface CustomModel {
  provider: string;
  /** The catalog's task key: "ocr" | "tl" | "qaLLM" | "qaVLM". */
  task: string;
  id: string;
}

export interface ModelEntry {
  id: string;
  name: string;
  free?: boolean;
  /** A model ID typed in by the owner rather than published in the catalog. */
  custom?: boolean;
  pricing?: {
    currency?: string;
    promptPerMillion?: number;
    completionPerMillion?: number;
    cacheReadPerMillion?: number;
    request?: number;
    image?: number;
    note?: string;
    source?: string;
  };
}

export interface SystemSettingsDto {
  ocrVlmModelList: string[];
  tlLlmModelList: string[];
  qaLlmModelList: string[];
  qaVlmModelList: string[];
  routingStrategy?: string;

  ocrProvider: string;
  ocrModel: string;
  tlProvider: string;
  tlModel: string;
  qaProvider: string;
  qaLlmModel: string;
  qaVlmModel: string;

  disableLocalOcr?: boolean;
  localOcrModel?: string;
  disableLocalLlm?: boolean;
  qaMode?: string;
  useFallbackModels?: boolean;

  activeProviders?: string[];
  activeOcrProviders?: string[];
  providerModelsMap?: Record<string, Record<string, ModelEntry[]>>;

  /** AUDIT-R1/F16: inset on each edge, as a percentage of the box's shorter side (0 = none)… */
  textBoxPaddingPercent?: number;
  /** …raised to at least this many px (0 = no floor; at most a quarter of the box)… */
  textBoxPaddingMinPx?: number;
  /** …capped at this many px (0 = none). */
  textBoxPaddingMaxPx?: number;
  /** Percent of what remains that text may use (100 = all of it). */
  textBoxSafetyPercent?: number;
  /** Global cleanup reconstruction mode; see `utils/cleanupModes`. */
  cleanupMode?: string;
  /** Global OCR grouping threshold, in characters of white space. */
  ocrMergeThreshold?: number;
  /** Model IDs typed in rather than picked; replaced via PUT /api/settings/custom-models. */
  customModels?: CustomModel[];
}
