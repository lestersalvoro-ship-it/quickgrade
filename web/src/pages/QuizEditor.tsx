import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Archive, ChevronDown, ChevronRight, Copy, FileDown, Printer, ScanLine, Sparkles, Trash2 } from 'lucide-react';
import { del, errorMessage, get, post, put } from '../lib/api';
import type { ClassItem, Question, Quiz, QuizRules } from '../lib/types';
import { className } from '../lib/types';
import { validateAnswerKey } from '../../../shared/grading';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, ErrorState, Modal, PageHeader, Select, Spinner, TextArea, TextInput, cx, useToast } from '../components/ui';

const LETTERS = ['A', 'B', 'C', 'D', 'E'];
const PRESETS = [20, 50, 100];

interface Draft {
  title: string;
  subject: string;
  description: string;
  instructions: string;
  questionCount: number;
  choiceCount: number;
  rules: QuizRules;
  questions: Question[];
  source?: 'manual' | 'ai_assisted';
}

const blankQuestion = (n: number): Question => ({ number: n, correctChoice: null, points: 1, excluded: false, topic: null, prompt: null, choices: null, explanation: null });

function resize(questions: Question[], count: number): Question[] {
  const out: Question[] = [];
  for (let i = 1; i <= count; i++) out.push(questions.find((q) => q.number === i) ?? blankQuestion(i));
  return out;
}

const emptyDraft = (): Draft => ({
  title: '',
  subject: '',
  description: '',
  instructions: '',
  questionCount: 20,
  choiceCount: 4,
  rules: { passPercent: null, wrongPenalty: 0, penalizeBlank: false, multiplePolicy: 'incorrect', floorAtZero: true },
  questions: resize([], 20),
});

function fromQuiz(q: Quiz): Draft {
  return {
    title: q.title,
    subject: q.subject ?? '',
    description: q.description ?? '',
    instructions: q.instructions ?? '',
    questionCount: q.questionCount,
    choiceCount: q.choiceCount,
    rules: q.rules,
    questions: resize(q.questions, q.questionCount),
  };
}

function PrintDialog({ quiz, open, onClose }: { quiz: Quiz; open: boolean; onClose: () => void }) {
  const [paper, setPaper] = useState<'A4' | 'LETTER'>('A4');
  const [mode, setMode] = useState<'blank' | 'class'>('blank');
  const [copies, setCopies] = useState(30);
  const [classId, setClassId] = useState<number | ''>('');
  const classes = useQuery({ queryKey: ['classes', '0'], queryFn: () => get<{ classes: ClassItem[] }>('/classes'), enabled: open });
  const url =
    mode === 'blank' ? `/api/quizzes/${quiz.id}/sheets.pdf?paper=${paper}&copies=${copies}` : classId ? `/api/quizzes/${quiz.id}/sheets.pdf?paper=${paper}&classId=${classId}` : null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Print answer sheets"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <a
            href={url ?? undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!url}
            className={cx('inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-fg hover:bg-primary-hover', !url && 'pointer-events-none opacity-50')}
          >
            <FileDown className="size-4" /> Open PDF
          </a>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-2">
          Sheets are generated for exactly this quiz layout ({quiz.questionCount} items, choices A–{LETTERS[quiz.choiceCount - 1]}) and carry sheet code #{quiz.sheetCode}, so the scanner can tell which quiz a sheet belongs to.
        </p>
        <Select label="Paper size" value={paper} onChange={(e) => setPaper(e.target.value as 'A4' | 'LETTER')}>
          <option value="A4">A4 (210 × 297 mm)</option>
          <option value="LETTER">Letter / short bond (8.5 × 11 in)</option>
        </Select>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Sheets</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={mode === 'blank'} onChange={() => setMode('blank')} /> Blank sheets (students bubble their ID)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={mode === 'class'} onChange={() => setMode('class')} /> One personalised sheet per student (name printed, ID pre-filled)
          </label>
        </fieldset>
        {mode === 'blank' ? (
          <TextInput label="Number of copies" type="number" min={1} max={200} value={copies} onChange={(e) => setCopies(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} />
        ) : (
          <Select label="Class" value={classId} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Choose a class…</option>
            {classes.data?.classes.map((c) => (
              <option key={c.id} value={c.id}>
                {className(c)} ({c.studentCount} students)
              </option>
            ))}
          </Select>
        )}
        <Alert tone="neutral" title="Printing tips">
          Print at 100% / “Actual size” (not “Fit to page”), in black ink, on plain white paper. Do not photocopy at reduced size.
        </Alert>
      </div>
    </Modal>
  );
}

function QuestionRow({ q, choiceCount, onChange, locked, onExplain, explaining }: { q: Question; choiceCount: number; onChange: (q: Question) => void; locked: boolean; onExplain?: () => void; explaining?: boolean }) {
  const [open, setOpen] = useState(false);
  const choices = q.choices ?? Array.from({ length: choiceCount }, () => '');
  return (
    <li className={cx('border-b border-line px-3 py-2 last:border-b-0', q.excluded && 'bg-surface-2')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button className="flex w-12 items-center gap-1 text-sm font-semibold tabular text-ink" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Question ${q.number} details`}>
          {open ? <ChevronDown className="size-4 text-ink-3" /> : <ChevronRight className="size-4 text-ink-3" />}
          {q.number}
        </button>
        <div className="flex gap-1" role="radiogroup" aria-label={`Correct answer for question ${q.number}`}>
          {LETTERS.slice(0, choiceCount).map((l, i) => (
            <button
              key={l}
              role="radio"
              aria-checked={q.correctChoice === i}
              disabled={q.excluded}
              onClick={() => onChange({ ...q, correctChoice: q.correctChoice === i ? null : i })}
              className={cx(
                'size-9 rounded-full border text-sm font-semibold transition-colors disabled:opacity-40',
                q.correctChoice === i ? 'border-primary bg-primary text-primary-fg' : 'border-line-strong bg-surface text-ink-2 hover:border-primary',
              )}
            >
              {l}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-ink-3">
          Pts
          <input
            type="number"
            min={0.25}
            max={100}
            step={0.25}
            className="input w-16 min-h-8 px-2 py-1 text-sm"
            value={q.points}
            onChange={(e) => onChange({ ...q, points: Number(e.target.value) })}
            aria-label={`Points for question ${q.number}`}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          <input type="checkbox" checked={q.excluded} onChange={(e) => onChange({ ...q, excluded: e.target.checked })} /> Exclude
        </label>
        <input
          className="input min-h-8 max-w-44 flex-1 px-2 py-1 text-sm"
          placeholder="Topic (optional)"
          value={q.topic ?? ''}
          maxLength={100}
          onChange={(e) => onChange({ ...q, topic: e.target.value || null })}
          aria-label={`Topic for question ${q.number}`}
        />
        {q.prompt && <Badge tone="neutral">Has text</Badge>}
      </div>
      {open && (
        <div className="mt-3 space-y-3 pl-12">
          <TextArea label="Question text (optional)" hint="Used for printing the key, AI explanations and AI insights. Students never see it in QuickGrade." value={q.prompt ?? ''} maxLength={2000} onChange={(e) => onChange({ ...q, prompt: e.target.value || null })} rows={2} />
          <div className="grid gap-2 sm:grid-cols-2">
            {LETTERS.slice(0, choiceCount).map((l, i) => (
              <TextInput
                key={l}
                aria-label={`Choice ${l} text`}
                placeholder={`Choice ${l}`}
                value={choices[i] ?? ''}
                maxLength={500}
                onChange={(e) => {
                  const next = [...choices];
                  next[i] = e.target.value;
                  onChange({ ...q, choices: next.some((c) => c.trim()) ? next : null });
                }}
              />
            ))}
          </div>
          <TextArea label="Explanation (optional)" value={q.explanation ?? ''} maxLength={4000} onChange={(e) => onChange({ ...q, explanation: e.target.value || null })} rows={2} />
          {onExplain && (
            <Button size="sm" variant="subtle" icon={<Sparkles className="size-4" />} onClick={onExplain} loading={explaining} disabled={!q.prompt || !q.choices || q.correctChoice === null || locked}>
              Explain with AI
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

export function QuizEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const toast = useToast();
  const quizQ = useQuery({ queryKey: ['quiz', id], queryFn: () => get<{ quiz: Quiz }>(`/quizzes/${id}`), enabled: !isNew });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [quick, setQuick] = useState('');
  const [printOpen, setPrintOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [explainFor, setExplainFor] = useState<{ number: number; text: string } | null>(null);
  const [explaining, setExplaining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) {
      const fromAi = (loc.state as { draft?: Draft } | null)?.draft;
      setDraft(fromAi ? { ...emptyDraft(), ...fromAi, questions: resize(fromAi.questions, fromAi.questionCount) } : emptyDraft());
      setDirty(!!fromAi);
    } else if (quizQ.data) {
      setDraft(fromQuiz(quizQ.data.quiz));
      setDirty(false);
    }
  }, [isNew, quizQ.data, loc.state]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const quiz = quizQ.data?.quiz;
  const structureLocked = !!quiz && quiz.submissionCount > 0;
  const issues = useMemo(
    () => (draft ? validateAnswerKey(draft.questions.map((q) => ({ number: q.number, correctChoice: q.correctChoice, points: q.points, excluded: q.excluded })), draft.questionCount, draft.choiceCount) : []),
    [draft],
  );

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) return;
      const body = {
        ...draft,
        subject: draft.subject || null,
        description: draft.description || null,
        instructions: draft.instructions || null,
        questions: draft.questions.map((q) => ({ ...q, choices: q.choices && q.choices.some((c) => c.trim()) ? q.choices.map((c) => c.trim()) : null })),
      };
      return isNew ? post<{ quiz: Quiz }>('/quizzes', body) : put<{ quiz: Quiz; regraded: number; structureChanged: boolean }>(`/quizzes/${id}`, body);
    },
    onSuccess: (r: any) => {
      setDirty(false);
      setError(null);
      qc.invalidateQueries({ queryKey: ['quizzes'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.setQueryData(['quiz', String(r.quiz.id)], { quiz: r.quiz });
      if (r.regraded) toast(`Saved. ${r.regraded} saved result(s) were regraded with the new key.`);
      else if (r.structureChanged) toast('Saved. The layout changed — reprint answer sheets for this quiz.', 'neutral');
      else toast('Quiz saved');
      if (isNew) nav(`/quizzes/${r.quiz.id}`, { replace: true });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const action = async (fn: () => Promise<any>, ok: string) => {
    try {
      const r = await fn();
      qc.invalidateQueries({ queryKey: ['quizzes'] });
      toast(ok);
      return r;
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  if (!isNew && quizQ.isLoading) return <Spinner />;
  if (!isNew && quizQ.error) return <ErrorState error={quizQ.error} onRetry={() => quizQ.refetch()} />;
  if (!draft) return <Spinner />;

  const update = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };
  const setQuestion = (q: Question) => update({ questions: draft.questions.map((x) => (x.number === q.number ? q : x)) });
  const setCount = (n: number) => update({ questionCount: n, questions: resize(draft.questions, n) });

  const applyQuick = () => {
    const letters = quick.toUpperCase().replace(/[^A-E]/g, '');
    if (!letters) return;
    const qs = draft.questions.map((q, i) => (i < letters.length ? { ...q, correctChoice: LETTERS.indexOf(letters[i]) < draft.choiceCount ? LETTERS.indexOf(letters[i]) : null } : q));
    update({ questions: qs });
    toast(`Filled ${Math.min(letters.length, draft.questionCount)} answers`, 'neutral');
  };

  const explain = async (n: number) => {
    setExplaining(n);
    try {
      const r = await post<{ explanation: { correctExplanation: string; distractors: { choiceIndex: number; whyIncorrect: string }[]; teachingTip: string } }>(`/ai/quizzes/${id}/questions/${n}/explain`);
      const e = r.explanation;
      setExplainFor({
        number: n,
        text: [e.correctExplanation, ...e.distractors.map((d) => `${LETTERS[d.choiceIndex]}: ${d.whyIncorrect}`), e.teachingTip ? `Tip: ${e.teachingTip}` : ''].filter(Boolean).join('\n'),
      });
    } catch (err) {
      toast(errorMessage(err), 'bad');
    } finally {
      setExplaining(null);
    }
  };

  const answered = draft.questions.filter((q) => q.correctChoice !== null || q.excluded).length;
  const total = draft.questions.filter((q) => !q.excluded).reduce((a, q) => a + (Number(q.points) || 0), 0);

  return (
    <>
      <PageHeader
        back={{ to: '/quizzes', label: 'Quizzes' }}
        title={isNew ? 'New quiz' : draft.title || 'Untitled quiz'}
        subtitle={
          quiz && (
            <span className="flex flex-wrap items-center gap-2">
              Sheet #{quiz.sheetCode} · {quiz.sessionCount} session(s) · {quiz.submissionCount} result(s)
              {quiz.archived && <Badge tone="warn">Archived</Badge>}
              {quiz.source === 'ai_assisted' && <Badge tone="primary">AI-assisted draft (teacher reviewed)</Badge>}
            </span>
          )
        }
        actions={
          quiz && (
            <>
              <Button icon={<Printer className="size-4" />} onClick={() => setPrintOpen(true)} disabled={dirty} title={dirty ? 'Save changes first' : undefined}>
                Print sheets
              </Button>
              <a className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium hover:bg-surface-2" href={`/api/quizzes/${quiz.id}/key.pdf`} target="_blank" rel="noreferrer">
                <FileDown className="size-4" /> Key PDF
              </a>
              <Button variant="primary" icon={<ScanLine className="size-4" />} disabled={!quiz.keyComplete || dirty} onClick={() => nav(`/scan?quizId=${quiz.id}`)}>
                Grade
              </Button>
            </>
          )
        }
      />

      {error && (
        <Alert tone="bad" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Details">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <TextInput label="Title" required maxLength={160} value={draft.title} onChange={(e) => update({ title: e.target.value })} placeholder="e.g. Science 8 – Quarter 2 Long Test" />
              </div>
              <TextInput label="Subject" maxLength={100} value={draft.subject} onChange={(e) => update({ subject: e.target.value })} />
              <div />
              <div className="sm:col-span-2">
                <TextArea label="Description" hint="Optional, for your reference." maxLength={2000} rows={2} value={draft.description} onChange={(e) => update({ description: e.target.value })} />
              </div>
              <div className="sm:col-span-2">
                <TextArea label="Instructions" hint="Optional notes for proctors / students." maxLength={2000} rows={2} value={draft.instructions} onChange={(e) => update({ instructions: e.target.value })} />
              </div>
            </div>
          </Card>

          <Card title="Answer sheet layout">
            {structureLocked && (
              <Alert tone="neutral" className="mb-4">
                Results have been saved for this quiz, so the number of items and choices is locked. Duplicate the quiz to make a new version.
              </Alert>
            )}
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <span className="mb-1.5 block text-sm font-medium">Number of items</span>
                <div className="flex flex-wrap items-center gap-2">
                  {PRESETS.map((n) => (
                    <Button key={n} variant={draft.questionCount === n ? 'primary' : 'secondary'} disabled={structureLocked} onClick={() => setCount(n)}>
                      {n}
                    </Button>
                  ))}
                  <input
                    type="number"
                    min={1}
                    max={100}
                    aria-label="Custom number of items"
                    className="input w-24"
                    disabled={structureLocked}
                    value={draft.questionCount}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      if (n >= 1 && n <= 100) setCount(n);
                    }}
                  />
                </div>
              </div>
              <Select label="Choices per item" className="w-40" disabled={structureLocked} value={draft.choiceCount} onChange={(e) => update({ choiceCount: Number(e.target.value), questions: draft.questions.map((q) => ({ ...q, correctChoice: q.correctChoice !== null && q.correctChoice >= Number(e.target.value) ? null : q.correctChoice, choices: null })) })}>
                {[2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    A–{LETTERS[n - 1]} ({n})
                  </option>
                ))}
              </Select>
            </div>
            {!isNew && !structureLocked && quiz && (quiz.questionCount !== draft.questionCount || quiz.choiceCount !== draft.choiceCount) && (
              <Alert tone="warn" className="mt-4">
                Changing the layout issues a new sheet code. Sheets already printed for this quiz will no longer be accepted — reprint them.
              </Alert>
            )}
          </Card>

          <Card
            title={`Answer key · ${answered}/${draft.questionCount} set`}
            padded={false}
            actions={
              <div className="flex items-center gap-2">
                <input className="input min-h-8 w-44 px-2 py-1 font-mono text-sm uppercase" placeholder="Quick entry: ABCDA…" value={quick} onChange={(e) => setQuick(e.target.value)} aria-label="Quick key entry" onKeyDown={(e) => e.key === 'Enter' && applyQuick()} />
                <Button size="sm" onClick={applyQuick} disabled={!quick.trim()}>
                  Fill
                </Button>
              </div>
            }
          >
            <ul>
              {draft.questions.map((q) => (
                <QuestionRow key={q.number} q={q} choiceCount={draft.choiceCount} onChange={setQuestion} locked={dirty} onExplain={!isNew ? () => explain(q.number) : undefined} explaining={explaining === q.number} />
              ))}
            </ul>
          </Card>
        </div>

        <div className="space-y-6">
          <div className="lg:sticky lg:top-5 space-y-6">
            <Card title="Grading rules">
              <div className="space-y-4">
                <TextInput
                  label="Passing score (%)"
                  type="number"
                  min={0}
                  max={100}
                  placeholder="Use my default"
                  hint="Leave empty to use the default from Settings."
                  value={draft.rules.passPercent ?? ''}
                  onChange={(e) => update({ rules: { ...draft.rules, passPercent: e.target.value === '' ? null : Math.max(0, Math.min(100, Number(e.target.value))) } })}
                />
                <TextInput
                  label="Penalty per wrong answer (points)"
                  type="number"
                  min={0}
                  max={10}
                  step={0.25}
                  hint="0 = no negative marking."
                  value={draft.rules.wrongPenalty}
                  onChange={(e) => update({ rules: { ...draft.rules, wrongPenalty: Math.max(0, Number(e.target.value) || 0) } })}
                />
                <Checkbox label="Also penalise blank answers" checked={draft.rules.penalizeBlank} disabled={!draft.rules.wrongPenalty} onChange={(v) => update({ rules: { ...draft.rules, penalizeBlank: v } })} />
                <Select label="Multiple marks on one item" value={draft.rules.multiplePolicy} onChange={(e) => update({ rules: { ...draft.rules, multiplePolicy: e.target.value as 'incorrect' | 'blank' } })}>
                  <option value="incorrect">Count as incorrect (no credit)</option>
                  <option value="blank">Count as blank (no credit, no penalty)</option>
                </Select>
                <Checkbox label="Never go below zero" checked={draft.rules.floorAtZero} onChange={(v) => update({ rules: { ...draft.rules, floorAtZero: v } })} />
              </div>
            </Card>

            <Card title="Validation">
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-ink-2">Total points</span>
                  <span className="font-semibold tabular">{total}</span>
                </div>
                {issues.length === 0 ? (
                  <Alert tone="good">The answer key is complete and ready for grading.</Alert>
                ) : (
                  <Alert tone="warn" title={`${issues.length} issue${issues.length === 1 ? '' : 's'} to fix before grading`}>
                    <ul className="list-disc space-y-0.5 pl-4">
                      {issues.slice(0, 6).map((i, k) => (
                        <li key={k}>{i.message}</li>
                      ))}
                      {issues.length > 6 && <li>…and {issues.length - 6} more</li>}
                    </ul>
                    <p className="mt-1">You can save now and finish the key later.</p>
                  </Alert>
                )}
                <Button variant="primary" className="w-full" loading={save.isPending} disabled={!draft.title.trim() || (!dirty && !isNew)} onClick={() => save.mutate()}>
                  {isNew ? 'Create quiz' : dirty ? 'Save changes' : 'Saved'}
                </Button>
                {quiz && quiz.submissionCount > 0 && dirty && <p className="text-xs text-ink-3">Saving re-grades the {quiz.submissionCount} saved result(s) with the updated key and rules.</p>}
              </div>
            </Card>

            {quiz && (
              <Card title="More">
                <div className="flex flex-col gap-2">
                  <Button icon={<Copy className="size-4" />} onClick={() => action(() => post(`/quizzes/${quiz.id}/duplicate`), 'Quiz duplicated').then((r) => r && nav(`/quizzes/${r.quiz.id}`))}>
                    Duplicate
                  </Button>
                  <a className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium hover:bg-surface-2" href={`/api/quizzes/${quiz.id}/key.csv`}>
                    <FileDown className="size-4" /> Export key (CSV)
                  </a>
                  <Button icon={<Archive className="size-4" />} onClick={() => action(() => post(`/quizzes/${quiz.id}/archive`, { archived: !quiz.archived }), quiz.archived ? 'Quiz restored' : 'Quiz archived').then(() => quizQ.refetch())}>
                    {quiz.archived ? 'Restore' : 'Archive'}
                  </Button>
                  <Button variant="ghost" className="text-bad" icon={<Trash2 className="size-4" />} disabled={quiz.sessionCount > 0} onClick={() => setConfirmDelete(true)} title={quiz.sessionCount > 0 ? 'Quizzes with grading sessions can only be archived' : undefined}>
                    Delete
                  </Button>
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>

      {quiz && <PrintDialog quiz={quiz} open={printOpen} onClose={() => setPrintOpen(false)} />}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete quiz?"
        danger
        confirmLabel="Delete quiz"
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => action(() => del(`/quizzes/${id}`), 'Quiz deleted').then(() => nav('/quizzes'))}
      >
        This permanently deletes “{draft.title}” and its answer key. Printed sheets for it will no longer scan.
      </ConfirmDialog>
      <Modal
        open={!!explainFor}
        onClose={() => setExplainFor(null)}
        title={`AI explanation · question ${explainFor?.number}`}
        footer={
          <>
            <Button onClick={() => setExplainFor(null)}>Discard</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!explainFor) return;
                const q = draft.questions.find((x) => x.number === explainFor.number)!;
                setQuestion({ ...q, explanation: explainFor.text });
                setExplainFor(null);
                toast('Explanation added — save the quiz to keep it', 'neutral');
              }}
            >
              Use this explanation
            </Button>
          </>
        }
      >
        <Alert tone="neutral" className="mb-3">
          AI-generated. Check it for accuracy before sharing it with students.
        </Alert>
        <TextArea aria-label="Explanation" rows={10} value={explainFor?.text ?? ''} onChange={(e) => explainFor && setExplainFor({ ...explainFor, text: e.target.value })} />
      </Modal>
    </>
  );
}
