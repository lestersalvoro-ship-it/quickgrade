/**
 * Bubble classification. Pure functions so thresholds can be unit-tested.
 *
 * Raw fills are mean "darkness" inside each bubble (0 = paper white, 1 = black)
 * after illumination normalisation. They are converted to relative fills using
 * two per-sheet references: the empty-bubble level (paper + faint printed
 * letter) and the printed-ink level (the black cells of the sheet code). The
 * filled threshold then adapts to how dark this student's marks typically are,
 * so light pencil and dark pen both work, while faint, erased or competing
 * marks are flagged for review instead of guessed.
 */
import type { AnswerStatus } from '../../../shared/scan-types';

export interface Calibration {
  empty: number;
  ink: number;
  /** Typical relative darkness of a deliberate mark on this sheet. */
  markLevel: number;
  /** Relative fill at or above which a bubble counts as marked. */
  filled: number;
  /** Relative fill below which a bubble counts as untouched. */
  faint: number;
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function median(values: number[]): number {
  return quantile(values, 0.5);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function calibrate(rawFills: number[][], inkDarkness: number): Calibration {
  const all = rawFills.flat();
  const empty = clamp(quantile(all, 0.2), 0, 0.35);
  const ink = Math.max(empty + 0.3, clamp(inkDarkness, 0.3, 1));
  const span = ink - empty;
  const tops = rawFills.map((f) => (Math.max(...f) - empty) / span).filter((t) => t >= 0.25);
  const markLevel = tops.length >= 3 ? clamp(median(tops), 0.35, 1.2) : 0.85;
  return {
    empty,
    ink,
    markLevel,
    filled: clamp(0.4 * markLevel, 0.22, 0.36),
    faint: clamp(0.2 * markLevel, 0.1, 0.16),
  };
}

export function relativeFills(raw: number[], cal: Calibration): number[] {
  const span = cal.ink - cal.empty;
  return raw.map((v) => Math.round(clamp((v - cal.empty) / span, 0, 1.5) * 1000) / 1000);
}

export interface Classification {
  status: AnswerStatus;
  choice: number | null;
  marked: number[];
  confidence: number;
  note?: string;
}

export function classifyBubbles(rel: number[], cal: Calibration): Classification {
  const order = rel.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const t1 = order[0].v;
  const t2 = order.length > 1 ? order[1].v : 0;
  const top = order[0].i;
  const { filled, faint } = cal;

  if (t1 < faint) {
    return { status: 'blank', choice: null, marked: [], confidence: round(1 - 0.5 * (t1 / faint)) };
  }
  if (t1 < filled) {
    return {
      status: 'ambiguous',
      choice: top,
      marked: [],
      confidence: round(0.25 + 0.25 * ((t1 - faint) / (filled - faint))),
      note: 'Faint or partial mark',
    };
  }
  const marked = order.filter((o) => o.v >= filled).map((o) => o.i).sort((a, b) => a - b);
  if (t2 >= filled) {
    if (t2 >= 0.6 * t1) {
      return { status: 'multiple', choice: null, marked, confidence: round(0.5 + 0.5 * Math.min(1, (t2 - filled) / filled)), note: 'More than one bubble marked' };
    }
    return { status: 'ambiguous', choice: top, marked, confidence: 0.35, note: 'Second mark present (possible erasure)' };
  }
  const secondLimit = Math.max(faint, 0.4 * t1);
  if (t2 >= secondLimit) {
    return { status: 'ambiguous', choice: top, marked: [top], confidence: 0.4, note: 'Possible incomplete erasure' };
  }
  // A light mark (e.g. a tick or a half-filled bubble) is only accepted when it is
  // as dark as this student's other marks; otherwise a teacher should look at it.
  if (t1 < 0.3 && t1 < 0.6 * cal.markLevel) {
    return { status: 'ambiguous', choice: top, marked: [top], confidence: 0.45, note: 'Lighter than the other marks on this sheet' };
  }
  const c1 = clamp((t1 - filled) / filled, 0, 1);
  const c2 = clamp((secondLimit - t2) / secondLimit, 0, 1);
  return { status: 'ok', choice: top, marked: [top], confidence: round(0.6 + 0.4 * Math.min(c1, c2)) };
}

function round(v: number) {
  return Math.round(clamp(v, 0, 1) * 100) / 100;
}
