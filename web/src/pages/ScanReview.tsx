import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Check, CheckCircle2, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { ApiError, errorMessage, get, post } from '../lib/api';
import { fmtPct } from '../lib/format';
import type { ScanResult } from '../../../shared/scan-types';
import { computeSheetLayout } from '../../../shared/sheet/layout';
import { gradeSubmission, type GradingRules } from '../../../shared/grading';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, ErrorState, PageHeader, Select, Spinner, cx, useToast } from '../components/ui';

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

interface ScanView {
  scan: { id: number; sessionId: number; status: 'pending' | 'confirmed' | 'discarded' | 'failed'; submissionId: number | null; hasRectifiedImage: boolean; hasOriginalImage: boolean };
  result: ScanResult | null;
  matchedStudent: { id: number; firstName: string; lastName: string; studentNumber: string; enrolled: boolean } | null;
  existingSubmission: { id: number; percent: number } | null;
  key: { number: number; correctChoice: number | null; points: number; excluded: boolean }[];
  quiz: { id: number; title: string; questionCount: number; choiceCount: number; sheetCode: number };
  rules: GradingRules;
  session: { id: number; name: string; classId: number };
}

interface Answer {
  number: number;
  status: 'answered' | 'blank' | 'multiple';
  choice: number | null;
  marked: number[];
  flagged: boolean;
  reviewed: boolean;
  scannerStatus: string;
  note?: string;
  confidence: number;
  fills: number[];
}

/** Crop of one question row from the rectified sheet image, so teachers see exactly what the scanner saw. */
function RowStrip({ scanId, rect, question, layout }: { scanId: number; rect: { pxPerMm: number; marginMm: number; width: number; height: number }; question: number; layout: ReturnType<typeof computeSheetLayout> }) {
  const q = layout.questions[question - 1];
  const first = q.bubbles[0];
  const last = q.bubbles[q.bubbles.length - 1];
  const x0 = (first.x - 11 + rect.marginMm) * rect.pxPerMm;
  const x1 = (last.x + 4 + rect.marginMm) * rect.pxPerMm;
  const y0 = (q.label.y - 3.6 + rect.marginMm) * rect.pxPerMm;
  const h = 7.2 * rect.pxPerMm;
  const w = x1 - x0;
  const scale = 1.4;
  return (
    <div
      role="img"
      aria-label={`Photo of question ${question} on the sheet`}
      className="rounded border border-line bg-white"
      style={{
        width: w * scale,
        height: h * scale,
        maxWidth: '100%',
        backgroundImage: `url(/api/scans/${scanId}/image)`,
        backgroundSize: `${rect.width * scale}px ${rect.height * scale}px`,
        backgroundPosition: `-${x0 * scale}px -${y0 * scale}px`,
        backgroundRepeat: 'no-repeat',
      }}
    />
  );
}

export function ScanReviewPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['scan', id], queryFn: () => get<ScanView>(`/scans/${id}`) });
  const roster = useQuery({
    queryKey: ['class', String(q.data?.session.classId)],
    queryFn: () => get<{ students: { id: number; firstName: string; lastName: string; studentNumber: string; archived: boolean }[] }>(`/classes/${q.data!.session.classId}`),
    enabled: !!q.data,
  });
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [studentId, setStudentId] = useState<number | ''>('');
  const [replace, setReplace] = useState(false);
  const [sheetConfirmed, setSheetConfirmed] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);

  const view = q.data;
  const result = view?.result?.ok ? view.result : null;

  useEffect(() => {
    if (!result || !view) return;
    setAnswers(
      result.answers.map((a) => ({
        number: a.question,
        status: a.status === 'blank' ? 'blank' : a.status === 'multiple' ? 'multiple' : 'answered',
        choice: a.status === 'ok' || a.status === 'ambiguous' ? a.choice : null,
        marked: a.marked,
        flagged: a.status === 'ambiguous' || a.status === 'multiple',
        reviewed: false,
        scannerStatus: a.status,
        note: a.note,
        confidence: a.confidence,
        fills: a.fills,
      })),
    );
    setStudentId(view.matchedStudent?.enrolled ? view.matchedStudent.id : '');
    setOnlyFlagged(result.flaggedCount > 0);
  }, [view, result]);

  const layout = useMemo(() => (view ? computeSheetLayout({ questionCount: view.quiz.questionCount, choiceCount: view.quiz.choiceCount }) : null), [view]);

  const preview = useMemo(() => {
    if (!view || !answers.length) return null;
    try {
      return gradeSubmission(
        view.key.map((k) => ({ number: k.number, correctChoice: k.correctChoice, points: k.points, excluded: k.excluded })),
        view.rules,
        answers.map((a) => ({ number: a.number, status: a.status, choice: a.status === 'answered' ? a.choice : null, marked: a.marked })),
      );
    } catch {
      return null;
    }
  }, [view, answers]);

  if (q.isLoading) return <Spinner label="Loading scan…" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const v = view!;
  const back = `/scan?sessionId=${v.scan.sessionId}`;

  if (v.result && !v.result.ok) {
    return (
      <>
        <PageHeader back={{ to: back, label: 'Scan & Grade' }} title="This photo could not be graded" subtitle={`${v.quiz.title} · ${v.session.name}`} />
        <Alert tone="bad" title={v.result.error.message}>
          <p>{v.result.error.hint}</p>
        </Alert>
        <div className="mt-4 flex gap-2">
          <Button variant="primary" icon={<RotateCcw className="size-4" />} onClick={() => nav(back)}>
            Retake photo
          </Button>
        </div>
      </>
    );
  }
  if (!result || !layout) return <ErrorState error={new Error('Scan data is unavailable.')} />;

  const unresolved = answers.filter((a) => a.flagged && !a.reviewed);
  const shown = onlyFlagged ? answers.filter((a) => a.flagged) : answers;
  const keyByQ = new Map(v.key.map((k) => [k.number, k]));
  const confirmed = v.scan.status === 'confirmed';
  const selectedStudent = roster.data?.students.find((s) => s.id === studentId);
  const needsReplace = !!v.existingSubmission && v.matchedStudent?.id === studentId;

  const setAnswer = (n: number, patch: Partial<Answer>) => setAnswers((list) => list.map((a) => (a.number === n ? { ...a, ...patch, reviewed: true } : a)));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await post<{ grade: { rawScore: number; totalPoints: number; percent: number } }>(`/scans/${v.scan.id}/confirm`, {
        studentId,
        replaceExisting: replace,
        confirmSheetMatches: sheetConfirmed,
        answers: answers.map((a) => ({ number: a.number, status: a.status, choice: a.status === 'answered' ? a.choice : null, marked: a.status === 'multiple' ? a.marked : undefined, reviewed: a.reviewed })),
      });
      toast(`Saved: ${r.grade.rawScore}/${r.grade.totalPoints} (${fmtPct(r.grade.percent)}) for ${selectedStudent ? `${selectedStudent.firstName} ${selectedStudent.lastName}` : 'student'}`);
      qc.invalidateQueries({ queryKey: ['session', v.scan.sessionId] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      const pending = await get<{ pendingScans: { id: number }[] }>(`/sessions/${v.scan.sessionId}`).catch(() => null);
      const next = pending?.pendingScans.find((p) => p.id !== v.scan.id);
      nav(next ? `/scans/${next.id}` : back);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT' && (e.details as { existingSubmissionId?: number })?.existingSubmissionId) {
        setError('This student already has a saved result in this session. Tick “Replace the existing result” to overwrite it, or pick a different student.');
      } else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        back={{ to: back, label: 'Scan & Grade' }}
        title="Review scanned sheet"
        subtitle={`${v.quiz.title} · ${v.session.name} · scanned in ${Math.round(result.timingMs)} ms`}
        actions={
          !confirmed && (
            <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setDiscardOpen(true)}>
              Discard scan
            </Button>
          )
        }
      />
      {confirmed && (
        <Alert tone="good" title="This scan was already confirmed" className="mb-4">
          <a href={`/submissions/${v.scan.submissionId}`}>Open the saved result</a>.
        </Alert>
      )}
      {result.warnings.map((w) => (
        <Alert key={w} tone="warn" className="mb-3">
          {w}
        </Alert>
      ))}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Student" padded>
            {v.matchedStudent ? (
              v.matchedStudent.enrolled ? (
                <Alert tone="good" className="mb-3">
                  ID {result.studentId.value} matched <strong>{v.matchedStudent.firstName} {v.matchedStudent.lastName}</strong>.
                </Alert>
              ) : (
                <Alert tone="warn" className="mb-3">
                  ID {result.studentId.value} belongs to {v.matchedStudent.firstName} {v.matchedStudent.lastName}, who is not enrolled in this class. Enroll them first or choose the correct student.
                </Alert>
              )
            ) : (
              <Alert tone="warn" className="mb-3">
                {result.studentId.status === 'blank'
                  ? 'No student ID was bubbled on this sheet.'
                  : result.studentId.status === 'ambiguous'
                    ? `The student ID could not be read reliably (${result.studentId.note ?? 'unclear digits'}).`
                    : `ID ${result.studentId.value} does not match any student.`}{' '}
                Choose the student below — check the name written on the sheet.
              </Alert>
            )}
            <Select label="Save result for" value={studentId} onChange={(e) => setStudentId(e.target.value ? Number(e.target.value) : '')} disabled={confirmed}>
              <option value="">Choose a student…</option>
              {roster.data?.students
                .filter((s) => !s.archived)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.lastName}, {s.firstName} (#{s.studentNumber})
                  </option>
                ))}
            </Select>
            {needsReplace && (
              <div className="mt-3 space-y-2">
                <Alert tone="warn">This student already has a saved result ({fmtPct(v.existingSubmission!.percent)}) in this session.</Alert>
                <Checkbox label="Replace the existing result" checked={replace} onChange={setReplace} />
              </div>
            )}
          </Card>

          {!result.codeVerified && (
            <Card title="Confirm the quiz">
              <Checkbox label={`This sheet is for “${v.quiz.title}” (sheet #${v.quiz.sheetCode})`} hint="The code strip was unreadable, so the scanner could not verify it automatically." checked={sheetConfirmed} onChange={setSheetConfirmed} />
            </Card>
          )}

          <Card title="Score preview">
            {preview ? (
              <div className="space-y-2">
                <div className="text-3xl font-semibold tabular">
                  {preview.rawScore}
                  <span className="text-lg text-ink-3"> / {preview.totalPoints}</span>
                  <span className="ml-2 text-lg">{fmtPct(preview.percent)}</span>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge tone="good">{preview.correctCount} correct</Badge>
                  <Badge tone="bad">{preview.incorrectCount} incorrect</Badge>
                  <Badge>{preview.blankCount} blank</Badge>
                  {preview.multipleCount > 0 && <Badge tone="warn">{preview.multipleCount} multiple</Badge>}
                  {preview.excludedCount > 0 && <Badge>{preview.excludedCount} excluded</Badge>}
                </div>
                <p className="text-xs text-ink-3">The official score is recalculated on the server from the answer key when you save.</p>
              </div>
            ) : (
              <p className="text-sm text-ink-3">Preview unavailable.</p>
            )}
            {error && (
              <Alert tone="bad" className="mt-3">
                {error}
              </Alert>
            )}
            {!confirmed && (
              <div className="mt-4 space-y-2">
                {unresolved.length > 0 && (
                  <p className="flex items-center gap-1.5 text-sm text-warn">
                    <AlertTriangle className="size-4" aria-hidden /> Review {unresolved.length} flagged question{unresolved.length === 1 ? '' : 's'} before saving.
                  </p>
                )}
                <Button variant="primary" size="lg" className="w-full" loading={saving} disabled={!studentId || unresolved.length > 0 || (!result.codeVerified && !sheetConfirmed) || (needsReplace && !replace)} onClick={save}>
                  Confirm &amp; save result
                </Button>
              </div>
            )}
          </Card>

          {v.scan.hasRectifiedImage && (
            <Card title="Scanned sheet" padded={false}>
              <img src={`/api/scans/${v.scan.id}/image`} alt="Rectified photo of the answer sheet" className="w-full rounded-b-xl" />
            </Card>
          )}
        </div>

        <Card
          className="lg:col-span-3"
          padded={false}
          title={`Answers · ${result.flaggedCount} flagged`}
          actions={
            <Checkbox label="Flagged only" checked={onlyFlagged} onChange={setOnlyFlagged} />
          }
        >
          {shown.length === 0 ? (
            <div className="flex items-center gap-2 p-5 text-sm text-good">
              <CheckCircle2 className="size-5" aria-hidden /> Every answer was read with high confidence. Turn off “Flagged only” to check them all.
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {shown.map((a) => {
                const k = keyByQ.get(a.number);
                const correct = !k?.excluded && a.status === 'answered' && a.choice === k?.correctChoice;
                return (
                  <li key={a.number} className={cx('px-4 py-3', a.flagged && !a.reviewed && 'bg-warn-soft/60')}>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="w-8 text-sm font-semibold tabular">{a.number}</span>
                      <div className="flex gap-1" role="radiogroup" aria-label={`Answer for question ${a.number}`}>
                        {LETTERS.slice(0, v.quiz.choiceCount).map((l, i) => {
                          const on = a.status === 'answered' && a.choice === i;
                          const multi = a.status === 'multiple' && a.marked.includes(i);
                          return (
                            <button
                              key={l}
                              role="radio"
                              aria-checked={on}
                              disabled={confirmed}
                              title={`Fill ${Math.round(a.fills[i] * 100)}%`}
                              onClick={() => setAnswer(a.number, on ? { status: 'blank', choice: null } : { status: 'answered', choice: i })}
                              className={cx(
                                'size-9 rounded-full border text-sm font-semibold',
                                on ? 'border-primary bg-primary text-primary-fg' : multi ? 'border-warn bg-warn-soft text-warn' : 'border-line-strong bg-surface text-ink-2 hover:border-primary',
                              )}
                            >
                              {l}
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        {a.status === 'blank' && <Badge>Blank</Badge>}
                        {a.status === 'multiple' && <Badge tone="warn">Multiple marks</Badge>}
                        {k?.excluded ? (
                          <Badge>Excluded</Badge>
                        ) : a.status === 'answered' ? (
                          correct ? (
                            <Badge tone="good" icon={<Check className="size-3" />}>
                              Correct
                            </Badge>
                          ) : (
                            <Badge tone="bad" icon={<XCircle className="size-3" />}>
                              Key {LETTERS[k?.correctChoice ?? 0]}
                            </Badge>
                          )
                        ) : (
                          <span className="text-ink-3">Key {LETTERS[k?.correctChoice ?? 0]}</span>
                        )}
                      </div>
                      {a.flagged && !confirmed && (
                        <div className="ml-auto flex gap-1">
                          {!a.reviewed ? (
                            <Button size="sm" variant="subtle" onClick={() => setAnswer(a.number, {})}>
                              Keep as shown
                            </Button>
                          ) : (
                            <Badge tone="good" icon={<Check className="size-3" />}>
                              Reviewed
                            </Badge>
                          )}
                          {a.status !== 'multiple' && a.scannerStatus === 'multiple' && (
                            <Button size="sm" variant="ghost" onClick={() => setAnswer(a.number, { status: 'multiple', choice: null })}>
                              Mark multiple
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                    {a.flagged && (
                      <div className="mt-2 space-y-2 pl-11">
                        <p className="text-xs text-warn">
                          {a.note ?? 'Needs review'} · scanner confidence {Math.round(a.confidence * 100)}%
                        </p>
                        {v.scan.hasRectifiedImage && <RowStrip scanId={v.scan.id} rect={result.rectified} question={a.number} layout={layout} />}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
      <ConfirmDialog
        open={discardOpen}
        title="Discard this scan?"
        confirmLabel="Discard"
        danger
        onClose={() => setDiscardOpen(false)}
        onConfirm={async () => {
          try {
            await post(`/scans/${v.scan.id}/discard`);
            qc.invalidateQueries({ queryKey: ['session', v.scan.sessionId] });
            toast('Scan discarded', 'neutral');
            nav(back);
          } catch (e) {
            toast(errorMessage(e), 'bad');
          }
        }}
      >
        Nothing is saved and the photo is deleted. You can rescan the sheet afterwards.
      </ConfirmDialog>
    </>
  );
}
