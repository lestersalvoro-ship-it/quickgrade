export interface User {
  id: number;
  email: string;
  fullName: string;
  schoolName: string | null;
  defaultPassPercent: number;
  imageRetentionDays: number;
}

export interface Question {
  number: number;
  correctChoice: number | null;
  points: number;
  excluded: boolean;
  topic: string | null;
  prompt: string | null;
  choices: string[] | null;
  explanation: string | null;
}

export interface QuizRules {
  passPercent: number | null;
  wrongPenalty: number;
  penalizeBlank: boolean;
  multiplePolicy: 'incorrect' | 'blank';
  floorAtZero: boolean;
}

export interface Quiz {
  id: number;
  title: string;
  subject: string | null;
  description: string | null;
  instructions: string | null;
  questionCount: number;
  choiceCount: number;
  sheetCode: number;
  rules: QuizRules;
  source: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  keyComplete: boolean;
  keyIssues: { number?: number; message: string }[];
  answeredCount: number;
  totalPoints: number;
  sessionCount: number;
  submissionCount: number;
  questions: Question[];
}

export interface ClassItem {
  id: number;
  name: string;
  section: string | null;
  subject: string | null;
  schoolYear: string | null;
  archived: boolean;
  studentCount: number;
  sessionCount: number;
  createdAt: string;
}

export interface Student {
  id: number;
  studentNumber: string;
  firstName: string;
  lastName: string;
  externalId: string | null;
  email: string | null;
  archived: boolean;
  classNames: string[];
  createdAt: string;
}

export interface SessionItem {
  id: number;
  name: string;
  heldOn: string | null;
  archived: boolean;
  createdAt: string;
  quiz: { id: number; title: string; questionCount: number; choiceCount: number };
  class: { id: number; name: string; section: string | null };
  submissionCount: number;
  meanPercent: number | null;
  passRate: number | null;
  passPercent: number;
  pendingScans: number;
}

export const className = (c: { name: string; section: string | null }) => (c.section ? `${c.name} – ${c.section}` : c.name);
export const fullName = (s: { firstName: string; lastName: string }) => `${s.lastName}, ${s.firstName}`;
