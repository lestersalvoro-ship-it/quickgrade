import { parse as parseCsv } from 'csv-parse/sync';
import { STUDENT_ID_DIGITS } from '../../../shared/sheet/layout';

/** Canonical form of a bubbled student number: digits only, no leading zeros. */
export function normalizeStudentNumber(raw: string): string | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = t.replace(/^0+(?=\d)/, '');
  if (n.length > STUDENT_ID_DIGITS) return null;
  return n;
}

export interface CsvStudentRow {
  line: number;
  studentNumber: string | null;
  firstName: string;
  lastName: string;
  externalId: string | null;
  email: string | null;
}

export interface CsvRowError {
  line: number;
  message: string;
}

const HEADER_ALIASES: Record<string, keyof Omit<CsvStudentRow, 'line'> | 'fullName'> = {
  student_number: 'studentNumber',
  studentnumber: 'studentNumber',
  student_no: 'studentNumber',
  student_id: 'studentNumber',
  studentid: 'studentNumber',
  id_number: 'studentNumber',
  number: 'studentNumber',
  id: 'studentNumber',
  first_name: 'firstName',
  firstname: 'firstName',
  given_name: 'firstName',
  first: 'firstName',
  last_name: 'lastName',
  lastname: 'lastName',
  surname: 'lastName',
  family_name: 'lastName',
  last: 'lastName',
  name: 'fullName',
  full_name: 'fullName',
  student_name: 'fullName',
  lrn: 'externalId',
  external_id: 'externalId',
  school_id: 'externalId',
  email: 'email',
  email_address: 'email',
};

const MAX_ROWS = 2000;

function splitFullName(full: string): { firstName: string; lastName: string } | null {
  const t = full.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  if (t.includes(',')) {
    const [last, ...rest] = t.split(',');
    const first = rest.join(',').trim();
    if (last.trim() && first) return { firstName: first, lastName: last.trim() };
  }
  const parts = t.split(' ');
  if (parts.length < 2) return null;
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

/** Parses a roster CSV with flexible headers. Never throws on bad rows; reports them instead. */
export function parseStudentCsv(text: string): { rows: CsvStudentRow[]; errors: CsvRowError[] } {
  const errors: CsvRowError[] = [];
  let records: string[][];
  try {
    records = parseCsv(text.replace(/^﻿/, ''), { relax_column_count: true, skip_empty_lines: true, trim: true, bom: true }) as string[][];
  } catch (e) {
    return { rows: [], errors: [{ line: 0, message: `The file is not valid CSV: ${(e as Error).message}` }] };
  }
  if (!records.length) return { rows: [], errors: [{ line: 0, message: 'The file is empty.' }] };
  const header = records[0].map((h) => h.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
  const map = header.map((h) => HEADER_ALIASES[h]);
  const has = (k: string) => map.includes(k as never);
  if (!(has('firstName') && has('lastName')) && !has('fullName')) {
    return {
      rows: [],
      errors: [{ line: 1, message: 'Missing name columns. Include "first_name" and "last_name" (or a single "name" column). Optional: "student_number", "lrn", "email".' }],
    };
  }
  if (records.length - 1 > MAX_ROWS) return { rows: [], errors: [{ line: 0, message: `Import at most ${MAX_ROWS} students at a time.` }] };

  const rows: CsvStudentRow[] = [];
  const seenNumbers = new Map<string, number>();
  records.slice(1).forEach((rec, idx) => {
    const line = idx + 2;
    const get = (k: string) => {
      const i = map.indexOf(k as never);
      return i >= 0 ? (rec[i] ?? '').trim() : '';
    };
    let firstName = get('firstName');
    let lastName = get('lastName');
    if ((!firstName || !lastName) && get('fullName')) {
      const split = splitFullName(get('fullName'));
      if (split) ({ firstName, lastName } = split);
    }
    if (!firstName || !lastName) return errors.push({ line, message: 'First and last name are required.' });
    if (firstName.length > 80 || lastName.length > 80) return errors.push({ line, message: 'Name is too long (80 characters max).' });
    const rawNumber = get('studentNumber');
    let studentNumber: string | null = null;
    if (rawNumber) {
      studentNumber = normalizeStudentNumber(rawNumber);
      if (!studentNumber) return errors.push({ line, message: `Student number "${rawNumber}" must be 1–${STUDENT_ID_DIGITS} digits.` });
      const prev = seenNumbers.get(studentNumber);
      if (prev) return errors.push({ line, message: `Student number ${studentNumber} is also used on line ${prev}.` });
      seenNumbers.set(studentNumber, line);
    }
    const email = get('email') || null;
    if (email && (email.length > 200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) return errors.push({ line, message: `"${email}" is not a valid email.` });
    const externalId = get('externalId') || null;
    if (externalId && externalId.length > 40) return errors.push({ line, message: 'LRN / external ID is too long.' });
    rows.push({ line, studentNumber, firstName, lastName, externalId, email });
  });
  return { rows, errors };
}
