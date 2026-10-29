import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { FileText, Sparkles, Trash2, Upload } from 'lucide-react';
import { errorMessage, get, post } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { Alert, Badge, Button, Card, PageHeader, Select, Spinner, Tabs, TextArea, TextInput, cx, useToast } from '../components/ui';

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

interface GenQ {
  prompt: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  topic: string;
}

interface AiStatus {
  enabled: boolean;
  provider: string;
  model: string;
  message: string;
  usage: { today: number; dailyLimit: number; monthCostUsd: number; monthBudgetUsd: number; recent: { feature: string; status: string; createdAt: string; costUsd: number }[] };
}

/** Editable review list for AI-generated questions. Nothing is saved until the teacher creates a quiz. */
function ReviewList({ items, setItems, choiceCount }: { items: GenQ[]; setItems: (q: GenQ[]) => void; choiceCount: number }) {
  const update = (i: number, patch: Partial<GenQ>) => setItems(items.map((q, k) => (k === i ? { ...q, ...patch } : q)));
  return (
    <ol className="space-y-4">
      {items.map((q, i) => (
        <li key={i} className="rounded-lg border border-line p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">Question {i + 1}</span>
            <button className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-bad" aria-label={`Remove question ${i + 1}`} onClick={() => setItems(items.filter((_, k) => k !== i))}>
              <Trash2 className="size-4" />
            </button>
          </div>
          <TextArea aria-label={`Question ${i + 1} text`} rows={2} value={q.prompt} onChange={(e) => update(i, { prompt: e.target.value })} />
          <div className="mt-2 space-y-1.5">
            {q.choices.slice(0, choiceCount).map((c, k) => (
              <div key={k} className="flex items-center gap-2">
                <button
                  className={cx('size-8 shrink-0 rounded-full border text-xs font-semibold', q.correctIndex === k ? 'border-primary bg-primary text-primary-fg' : 'border-line-strong text-ink-2')}
                  aria-label={`Mark ${LETTERS[k]} as correct`}
                  aria-pressed={q.correctIndex === k}
                  onClick={() => update(i, { correctIndex: k })}
                >
                  {LETTERS[k]}
                </button>
                <input className="input min-h-8 py-1 text-sm" value={c} aria-label={`Choice ${LETTERS[k]}`} onChange={(e) => update(i, { choices: q.choices.map((x, j) => (j === k ? e.target.value : x)) })} />
              </div>
            ))}
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <input className="input min-h-8 py-1 text-sm" placeholder="Topic" aria-label="Topic" value={q.topic} onChange={(e) => update(i, { topic: e.target.value })} />
            <input className="input min-h-8 py-1 text-sm sm:col-span-2" placeholder="Explanation" aria-label="Explanation" value={q.explanation} onChange={(e) => update(i, { explanation: e.target.value })} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function toDraft(title: string, subject: string, choiceCount: number, items: GenQ[]) {
  return {
    title: title.slice(0, 160),
    subject: subject.slice(0, 100),
    description: 'Created from an AI-assisted draft and reviewed by the teacher.',
    instructions: '',
    questionCount: items.length,
    choiceCount,
    source: 'ai_assisted' as const,
    rules: { passPercent: null, wrongPenalty: 0, penalizeBlank: false, multiplePolicy: 'incorrect' as const, floorAtZero: true },
    questions: items.map((q, i) => ({
      number: i + 1,
      correctChoice: q.correctIndex,
      points: 1,
      excluded: false,
      topic: q.topic.trim() || null,
      prompt: q.prompt.trim(),
      choices: q.choices.map((c) => c.trim()),
      explanation: q.explanation.trim() || null,
    })),
  };
}

function GeneratorPanel({ mode, enabled }: { mode: 'questions' | 'quiz'; enabled: boolean }) {
  const nav = useNavigate();
  const toast = useToast();
  const [f, setF] = useState({ subject: '', topic: '', gradeLevel: '', difficulty: 'mixed', count: 10, choiceCount: 4, objectives: '', material: '', title: '', language: '' });
  const [items, setItems] = useState<GenQ[] | null>(null);
  const [meta, setMeta] = useState<{ title: string; subject: string; rejected: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  const canRun = enabled && f.subject.trim() && f.gradeLevel.trim() && (mode === 'questions' ? f.topic.trim() : f.objectives.trim() || f.material.trim());

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'questions') {
        const r = await post<{ questions: GenQ[]; rejected: unknown[] }>('/ai/questions', {
          subject: f.subject,
          topic: f.topic,
          gradeLevel: f.gradeLevel,
          difficulty: f.difficulty,
          count: Math.max(1, Math.min(25, f.count)),
          choiceCount: f.choiceCount,
          objectives: f.objectives || null,
          language: f.language || null,
        });
        setItems(r.questions);
        setMeta({ title: `${f.topic} practice`, subject: f.subject, rejected: r.rejected.length });
      } else {
        const r = await post<{ title: string; subject: string; questions: GenQ[]; rejected: unknown[] }>('/ai/quiz-draft', {
          subject: f.subject,
          gradeLevel: f.gradeLevel,
          title: f.title || null,
          objectives: f.objectives || null,
          material: f.material || null,
          questionCount: Math.max(1, Math.min(30, f.count)),
          choiceCount: f.choiceCount,
          difficulty: f.difficulty,
        });
        setItems(r.questions);
        setMeta({ title: r.title, subject: r.subject, rejected: r.rejected.length });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const valid = (items ?? []).filter((q) => q.prompt.trim() && q.choices.slice(0, f.choiceCount).every((c) => c.trim()));

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-2" title={mode === 'questions' ? 'Generate questions' : 'Draft a whole quiz'}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <TextInput label="Subject" required placeholder="e.g. Science" value={f.subject} onChange={set('subject')} maxLength={100} />
            <TextInput label="Grade level" required placeholder="e.g. Grade 8" value={f.gradeLevel} onChange={set('gradeLevel')} maxLength={60} />
          </div>
          {mode === 'questions' ? <TextInput label="Topic" required placeholder="e.g. Newton’s laws of motion" value={f.topic} onChange={set('topic')} maxLength={200} /> : <TextInput label="Working title" placeholder="Optional" value={f.title} onChange={set('title')} maxLength={160} />}
          <div className="grid grid-cols-3 gap-3">
            <TextInput label="How many" type="number" min={1} max={mode === 'questions' ? 25 : 30} value={f.count} onChange={set('count')} />
            <Select label="Choices" value={f.choiceCount} onChange={set('choiceCount')}>
              {[2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
            <Select label="Difficulty" value={f.difficulty} onChange={set('difficulty')}>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
              <option value="mixed">Mixed</option>
            </Select>
          </div>
          <TextArea label="Learning objectives" hint={mode === 'quiz' ? 'Provide objectives, teaching material, or both.' : 'Optional'} rows={3} maxLength={3000} value={f.objectives} onChange={set('objectives')} />
          {mode === 'quiz' && (
            <div className="space-y-2">
              <TextArea label="Teaching material" hint="Paste lesson notes or upload a .txt / .md file (up to 30,000 characters). PDF and Word files are not supported — copy the text instead. Remove student names before pasting." rows={6} maxLength={30000} value={f.material} onChange={set('material')} />
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-primary hover:underline">
                <Upload className="size-4" aria-hidden /> Load a text file
                <input
                  type="file"
                  accept=".txt,.md,text/plain,text/markdown"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > 200_000) return toast('That file is too large (200 KB max).', 'bad');
                    const text = await file.text();
                    if (text.length > 30000) toast('The file was longer than 30,000 characters and was shortened.', 'neutral');
                    setF((prev) => ({ ...prev, material: text.slice(0, 30000) }));
                  }}
                />
              </label>
            </div>
          )}
          {mode === 'questions' && <TextInput label="Language" placeholder="Optional, e.g. Filipino" value={f.language} onChange={set('language')} maxLength={40} />}
          {error && <Alert tone="bad">{error}</Alert>}
          <Button variant="primary" icon={<Sparkles className="size-4" />} loading={busy} disabled={!canRun} onClick={run}>
            {mode === 'questions' ? 'Generate questions' : 'Draft quiz'}
          </Button>
          {busy && <p className="text-xs text-ink-3">This can take up to a minute.</p>}
        </div>
      </Card>

      <Card
        className="lg:col-span-3"
        title="Review before saving"
        actions={
          items && items.length > 0 && (
            <Button variant="primary" size="sm" disabled={!valid.length} onClick={() => nav('/quizzes/new', { state: { draft: toDraft(meta?.title ?? 'AI draft', meta?.subject ?? f.subject, f.choiceCount, valid) } })}>
              Open in quiz editor ({valid.length})
            </Button>
          )
        }
      >
        {busy ? (
          <Spinner label="Generating…" />
        ) : !items ? (
          <div className="py-10 text-center text-sm text-ink-3">
            <FileText className="mx-auto mb-2 size-8" aria-hidden />
            Generated questions appear here for you to edit. Nothing becomes part of a quiz until you open it in the quiz editor and save it.
          </div>
        ) : items.length === 0 ? (
          <Alert tone="warn">No usable questions were returned{meta?.rejected ? ` (${meta.rejected} failed validation)` : ''}. Try again with a more specific topic.</Alert>
        ) : (
          <div className="space-y-3">
            <Alert tone="neutral">
              AI-generated content can contain mistakes. Check every question, the marked correct answer, and that the content suits your learners.
              {meta?.rejected ? ` ${meta.rejected} malformed item(s) were removed automatically.` : ''}
            </Alert>
            <ReviewList items={items} setItems={setItems} choiceCount={f.choiceCount} />
          </div>
        )}
      </Card>
    </div>
  );
}

export function AiPage() {
  const [tab, setTab] = useState<'questions' | 'quiz' | 'insights' | 'usage'>('questions');
  const status = useQuery({ queryKey: ['ai-status'], queryFn: () => get<AiStatus>('/ai/status') });
  if (status.isLoading) return <Spinner />;
  const st = status.data;
  return (
    <>
      <PageHeader title="AI Assistant" subtitle="Generate questions, draft quizzes and get insights from class results. You review everything before it is used." />
      {!st?.enabled && (
        <Alert tone="warn" title="AI is pending configuration" className="mb-4">
          {st?.message} Everything else in QuickGrade — scanning, grading, analytics — works without it.
        </Alert>
      )}
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'questions', label: 'Question generator' },
            { id: 'quiz', label: 'Quiz from material' },
            { id: 'insights', label: 'Performance insights' },
            { id: 'usage', label: 'Usage' },
          ]}
        />
      </div>
      {tab === 'questions' && <GeneratorPanel mode="questions" enabled={!!st?.enabled} />}
      {tab === 'quiz' && <GeneratorPanel mode="quiz" enabled={!!st?.enabled} />}
      {tab === 'insights' && (
        <Card>
          <p className="text-sm text-ink-2">
            Performance insights, practice recommendations and practice questions are generated per grading session from its saved results. Open a session in <a className="text-primary hover:underline" href="/results">Results</a> and choose the <strong>AI insights</strong> tab. Explanations for individual questions are available in the quiz editor (expand a question with text and choices).
          </p>
        </Card>
      )}
      {tab === 'usage' && st && (
        <Card title="Usage and limits">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-ink-3">Provider / model</dt>
              <dd className="font-medium">{st.enabled ? `${st.provider} · ${st.model}` : 'Not configured'}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Your requests today</dt>
              <dd className="font-medium tabular">
                {st.usage.today} / {st.usage.dailyLimit}
              </dd>
            </div>
            <div>
              <dt className="text-ink-3">Estimated server cost this month</dt>
              <dd className="font-medium tabular">
                ${st.usage.monthCostUsd.toFixed(2)} {st.usage.monthBudgetUsd ? `of $${st.usage.monthBudgetUsd}` : ''}
              </dd>
            </div>
          </dl>
          {st.usage.recent.length > 0 && (
            <table className="mt-5 w-full text-sm">
              <thead className="text-left text-xs text-ink-3">
                <tr>
                  <th className="py-1 font-medium">When</th>
                  <th className="py-1 font-medium">Feature</th>
                  <th className="py-1 font-medium">Status</th>
                  <th className="py-1 text-right font-medium">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {st.usage.recent.map((r, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="py-1.5">{fmtDateTime(r.createdAt)}</td>
                    <td className="py-1.5">{r.feature}</td>
                    <td className="py-1.5">
                      <Badge tone={r.status === 'ok' ? 'good' : r.status === 'error' ? 'bad' : 'warn'}>{r.status}</Badge>
                    </td>
                    <td className="py-1.5 text-right tabular">${r.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-4 text-xs text-ink-3">Costs are estimates from token counts and the configured per-token prices.</p>
        </Card>
      )}
    </>
  );
}
