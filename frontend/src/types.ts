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
}

export interface Page {
  id: string;
  pageNumber: number;
  imageId: string;
  filename: string;
  url: string;
  thumbnailUrl?: string;
  chapterId?: string;
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
  qaStatus?: "passed" | "failed" | "direct_fix" | null;
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
  visible: boolean;
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
  visible: boolean;
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

export interface SystemSettingsDto {
  ocrProvider: string;
  ocrVlmModelList: string[];
  tlProvider: string;
  tlLlmModelList: string[];
  qaProvider: string;
  qaLlmModelList: string[];
  qaVlmModelList: string[];
}
