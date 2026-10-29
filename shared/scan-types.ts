/** Types describing a scanner result, shared by the server and the review UI. */

export type AnswerStatus = 'ok' | 'blank' | 'multiple' | 'ambiguous';

export interface DetectedAnswer {
  question: number;
  status: AnswerStatus;
  /** Choice index the scanner believes is marked (null for blank/multiple). */
  choice: number | null;
  /** For 'multiple', every choice index above the filled threshold. */
  marked: number[];
  /** Relative fill (0 = empty paper, 1 = printed black) for each choice. */
  fills: number[];
  /** Scanner confidence in this reading (0–1). Not the same as correctness. */
  confidence: number;
  /** Human-readable reason for a flag. */
  note?: string;
}

export interface DetectedStudentId {
  /** Digits read, or null when the ID could not be read unambiguously. */
  value: string | null;
  status: 'ok' | 'blank' | 'ambiguous';
  digits: { status: AnswerStatus; digit: number | null; fills: number[] }[];
  note?: string;
}

export type ScanErrorCode =
  | 'IMAGE_UNREADABLE'
  | 'RESOLUTION_TOO_LOW'
  | 'TOO_DARK'
  | 'OVEREXPOSED'
  | 'MARKERS_NOT_FOUND'
  | 'SHEET_CODE_UNREADABLE'
  | 'TOO_BLURRY'
  | 'LAYOUT_UNSUPPORTED';

export interface ScanError {
  code: ScanErrorCode;
  message: string;
  hint: string;
}

export interface ScanQuality {
  brightness: number;
  /** Mean ring contrast of the printed bubbles (focus/print clarity), 0–1. */
  clarity: number;
  /** Darkness of printed black on the sheet (0–1); low values mean washed-out image. */
  inkLevel: number;
  /** Paper darkness of empty bubbles (0–1). */
  emptyLevel: number;
  /** Typical relative fill level of marked bubbles on this sheet. */
  markLevel: number;
}

export interface ScanSuccess {
  ok: true;
  sheet: { version: number; quizCode: number; questionCount: number; choiceCount: number };
  /** True when the sheet code was read; false when the teacher-selected layout was assumed. */
  codeVerified: boolean;
  orientation: 0 | 90 | 180 | 270;
  studentId: DetectedStudentId;
  answers: DetectedAnswer[];
  quality: ScanQuality;
  warnings: string[];
  /** Number of answers that need teacher review before the result can be saved. */
  flaggedCount: number;
  /** Rectified sheet image geometry, for the review overlay (frame mm → image px). */
  rectified: { pxPerMm: number; marginMm: number; width: number; height: number };
  timingMs: number;
}

export interface ScanFailure {
  ok: false;
  error: ScanError;
  warnings: string[];
}

export type ScanResult = ScanSuccess | ScanFailure;
