/** Assessment statistics computed from saved, teacher-confirmed results. */

export interface SummaryStats {
  count: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  /** Population standard deviation. */
  stdDev: number | null;
}

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export function summarize(values: number[]): SummaryStats {
  const n = values.length;
  if (!n) return { count: 0, mean: null, median: null, min: null, max: null, stdDev: null };
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const variance = s.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  return { count: n, mean: round2(mean), median: round2(median), min: round2(s[0]), max: round2(s[n - 1]), stdDev: round2(Math.sqrt(variance)) };
}

export interface Bin {
  label: string;
  from: number;
  to: number;
  count: number;
}

/** Ten 10-point bins; the last bin includes 100. Negative scores (penalties) fall in the first bin. */
export function scoreDistribution(percents: number[]): Bin[] {
  const bins: Bin[] = Array.from({ length: 10 }, (_, i) => ({ label: i === 9 ? '90–100' : `${i * 10}–${i * 10 + 9}`, from: i * 10, to: i === 9 ? 100 : i * 10 + 10, count: 0 }));
  for (const p of percents) {
    const idx = Math.min(9, Math.max(0, Math.floor(p / 10)));
    bins[idx].count++;
  }
  return bins;
}

export function passRate(percents: number[], threshold: number): number | null {
  if (!percents.length) return null;
  return round2((percents.filter((p) => p >= threshold).length / percents.length) * 100);
}

export interface ItemResponse {
  number: number;
  status: 'answered' | 'blank' | 'multiple';
  choice: number | null;
  isCorrect: boolean;
}

export interface ItemSubmission {
  percent: number;
  responses: ItemResponse[];
}

export interface ItemStat {
  number: number;
  correctChoice: number | null;
  excluded: boolean;
  topic: string | null;
  /** Share of students answering correctly (difficulty index p), 0–100. */
  percentCorrect: number | null;
  /** Count of each choice picked, plus blanks and multiple marks. */
  choiceCounts: number[];
  blankCount: number;
  multipleCount: number;
  /** Most common wrong choice, if any student picked one. */
  topDistractor: number | null;
  /**
   * Discrimination index D = p(upper 27%) − p(lower 27%), −1…1. Only reported
   * with at least 10 submissions; small classes make it meaningless.
   */
  discrimination: number | null;
  responses: number;
}

export function itemAnalysis(
  key: { number: number; correctChoice: number | null; excluded: boolean; topic?: string | null }[],
  choiceCount: number,
  submissions: ItemSubmission[],
): ItemStat[] {
  const n = submissions.length;
  const ranked = [...submissions].sort((a, b) => b.percent - a.percent);
  const g = n >= 10 ? Math.max(1, Math.round(n * 0.27)) : 0;
  const upper = ranked.slice(0, g);
  const lower = ranked.slice(n - g);
  const pCorrect = (group: ItemSubmission[], q: number) => group.filter((s) => s.responses.find((r) => r.number === q)?.isCorrect).length / group.length;

  return key.map((k) => {
    const choiceCounts = new Array<number>(choiceCount).fill(0);
    let blank = 0;
    let multiple = 0;
    let correct = 0;
    for (const s of submissions) {
      const r = s.responses.find((x) => x.number === k.number);
      if (!r || r.status === 'blank') blank++;
      else if (r.status === 'multiple') multiple++;
      else if (r.choice !== null && r.choice < choiceCount) choiceCounts[r.choice]++;
      if (r?.isCorrect) correct++;
    }
    let topDistractor: number | null = null;
    let best = 0;
    choiceCounts.forEach((c, i) => {
      if (i !== k.correctChoice && c > best) {
        best = c;
        topDistractor = i;
      }
    });
    return {
      number: k.number,
      correctChoice: k.correctChoice,
      excluded: k.excluded,
      topic: k.topic ?? null,
      percentCorrect: n && !k.excluded ? round2((correct / n) * 100) : null,
      choiceCounts,
      blankCount: blank,
      multipleCount: multiple,
      topDistractor,
      discrimination: g && !k.excluded ? round2(pCorrect(upper, k.number) - pCorrect(lower, k.number)) : null,
      responses: n,
    };
  });
}

export interface TopicStat {
  topic: string;
  questions: number[];
  percentCorrect: number | null;
}

export function topicBreakdown(items: ItemStat[]): TopicStat[] {
  const map = new Map<string, ItemStat[]>();
  for (const it of items) {
    if (!it.topic || it.excluded) continue;
    const list = map.get(it.topic) ?? [];
    list.push(it);
    map.set(it.topic, list);
  }
  return [...map.entries()]
    .map(([topic, list]) => {
      const vals = list.map((i) => i.percentCorrect).filter((v): v is number => v !== null);
      return { topic, questions: list.map((i) => i.number), percentCorrect: vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null };
    })
    .sort((a, b) => (a.percentCorrect ?? 0) - (b.percentCorrect ?? 0));
}
