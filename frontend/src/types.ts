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
}

export interface Chapter {
  id: string;
  seriesId: string;
  chapterNumber: number;
  title: string;
  coverImageUrl?: string | null;
}

export interface Page {
  id: string;
  pageNumber: number;
  imageId: string;
  filename: string;
  url: string;
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
}
