/**
 * Machine-readable sheet code printed along the top edge of every answer sheet.
 *
 * Bit layout (44 cells, left to right, 1 = black cell):
 *   4  sentinel bits (1101) — also disambiguates sheet orientation
 *   2  template version (1–3)
 *   3  choice count − 2 (choices 2–9)
 *   7  question count (1–127)
 *   20 quiz sheet code (a random per-quiz identifier, 1–1,048,575)
 *   8  CRC-8 (poly 0x07) over the 32 payload bits
 *
 * The scanner reads the code to identify the quiz, confirm the layout and pick
 * the correct orientation; a corrupted code fails the CRC rather than silently
 * matching the wrong quiz.
 */
import { CODE_BITS, CODE_SENTINEL } from './layout';

export const MAX_QUIZ_SHEET_CODE = (1 << 20) - 1;

export interface SheetCodePayload {
  version: number;
  choiceCount: number;
  questionCount: number;
  quizCode: number;
}

export function crc8(bytes: number[]): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b & 0xff;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function pushBits(out: number[], value: number, width: number) {
  for (let i = width - 1; i >= 0; i--) out.push((value >>> i) & 1);
}

function readBits(bits: number[], start: number, width: number): number {
  let v = 0;
  for (let i = 0; i < width; i++) v = (v << 1) | (bits[start + i] ? 1 : 0);
  return v >>> 0;
}

function payloadBytes(bits32: number[]): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < 4; i++) bytes.push(readBits(bits32, i * 8, 8));
  return bytes;
}

export function encodeSheetCode(p: SheetCodePayload): number[] {
  if (p.version < 1 || p.version > 3) throw new Error('version out of range');
  if (p.choiceCount < 2 || p.choiceCount > 9) throw new Error('choiceCount out of range');
  if (p.questionCount < 1 || p.questionCount > 127) throw new Error('questionCount out of range');
  if (p.quizCode < 1 || p.quizCode > MAX_QUIZ_SHEET_CODE) throw new Error('quizCode out of range');
  const payload: number[] = [];
  pushBits(payload, p.version, 2);
  pushBits(payload, p.choiceCount - 2, 3);
  pushBits(payload, p.questionCount, 7);
  pushBits(payload, p.quizCode, 20);
  const bits = [...CODE_SENTINEL, ...payload];
  pushBits(bits, crc8(payloadBytes(payload)), 8);
  if (bits.length !== CODE_BITS) throw new Error('internal: bad code length');
  return bits;
}

export type DecodeResult = { ok: true; payload: SheetCodePayload } | { ok: false; reason: 'sentinel' | 'crc' | 'range' };

export function decodeSheetCode(bits: number[]): DecodeResult {
  if (bits.length !== CODE_BITS) return { ok: false, reason: 'range' };
  for (let i = 0; i < CODE_SENTINEL.length; i++) if (bits[i] !== CODE_SENTINEL[i]) return { ok: false, reason: 'sentinel' };
  const payload = bits.slice(4, 36);
  const crc = readBits(bits, 36, 8);
  if (crc8(payloadBytes(payload)) !== crc) return { ok: false, reason: 'crc' };
  const version = readBits(payload, 0, 2);
  const choiceCount = readBits(payload, 2, 3) + 2;
  const questionCount = readBits(payload, 5, 7);
  const quizCode = readBits(payload, 12, 20);
  if (version < 1 || questionCount < 1 || quizCode < 1) return { ok: false, reason: 'range' };
  return { ok: true, payload: { version, choiceCount, questionCount, quizCode } };
}
