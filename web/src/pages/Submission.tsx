import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Pencil, Trash2 } from 'lucide-react';
import { del, errorMessage, get, put } from '../lib/api';
import { fmtDateTime, fmtPct } from '../lib/format';
import { Alert, Badge, Button, Card, ConfirmDialog, ErrorState, PageHeader, PassBadge, Spinner, StatTile, TextInput, cx, useToast } from '../components/ui';
import { AnswerGrid, type GridAnswer } from '../components/AnswerGrid';

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

interface Detail {
  submission: { id: number; source: string; rawScore: number; totalPoints: number; percent: number; correct: number; incorrect: number; blank: number; multiple: number; passed: boolean; passPercent: number; teacherEdits: number; gradedAt: string; updatedAt: string };
  student: { id: number; firstName: string; lastName: string; studentNumber: string };
  session: { id: number; name: string; heldOn: string | null };
  quiz: { id: number; title: string; questionCount: number; choiceCount: number };
  questions: {
    number: number;
    correctChoice: number | null;
    points: number;
    excluded: boolean;
    topic: string | null;
    status: 'answered' | 'blank' | 'multiple';
    choice: number | null;
    marked: number[];
    isCorrect: boolean;
    pointsAwarded: number;
    scannerStatus: string | null;
    scannerConfidence: number | null;
    teacherOverride: boolean;
  }[];
  scan: { id: number; hasRectifiedImage: boolean; hasOriginalImage: boolean } | null;
  history: { action: string; summary: string; at: string }[];
}

export function SubmissionPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['submission', id], queryFn: () => get<Detail>(`/submissions/${id}`) });
  const [editing, setEditing] = useState(false);
  const [answers, setAnswers] = useState<GridAnswer[]>([]);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const d = q.data;
  const keyMap = useMemo(() => new Map((d?.questions ?? []).map((x) => [x.number, { correct: x.correctChoice, excluded: x.excluded }])), [d]);
  const changed = useMemo(() => {
    const set = new Set<number>();
    if (!d) return set;
    for (const a of answers) {
      const o = d.questions.find((x) => x.number === a.number)!;
      if (o.status !== a.status || o.choice !== a.choice || (a.status === 'multiple' && (a.marked ?? []).join() !== o.marked.join())) set.add(a.number);
    }
    return set;
  }, [answers, d]);

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = d!.submission;

  const startEdit = () => {
    setAnswers(d!.questions.map((x) => ({ number: x.number, status: x.status, choice: x.choice, marked: x.marked })));
    setReason('');
    setEditing(true);
  };
  const saveEdit = async () => {
    setSaving(true);
    try {
      const r = await put<{ grade: { rawScore: number; percent: number } }>(`/submissions/${id}`, { responses: answers.map((a) => ({ number: a.number, status: a.status, choice: a.status === 'answered' ? a.choice : null, marked: a.marked })), reason: reason || undefined });
      toast(`Corrected — new score ${r.grade.rawScore} (${fmtPct(r.grade.percent)})`);
      setEditing(false);
      q.refetch();
      qc.invalidateQueries({ queryKey: ['session', d!.session.id] });
      qc.invalidateQueries({ queryKey: ['analytics', d!.session.id] });
    } catch (e) {
      toast(errorMessage(e), 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        back={{ to: `/sessions/${d!.session.id}`, label: d!.session.name }}
        title={`${d!.student.firstName} ${d!.student.lastName}`}
        subtitle={`#${d!.student.studentNumber} · ${d!.quiz.title} · graded ${fmtDateTime(s.gradedAt)}`}
        actions={
          !editing && (
            <>
              <Button icon={<Pencil className="size-4" />} onClick={startEdit}>
                Correct answers
              </Button>
              <Button variant="ghost" className="text-bad" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>
                Delete result
              </Button>
            </>
          )
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Score" value={`${s.rawScore} / ${s.totalPoints}`} />
        <StatTile label="Percent" value={fmtPct(s.percent)} hint={<PassBadge passed={s.passed} />} />
        <StatTile label="Correct · Incorrect" value={`${s.correct} · ${s.incorrect}`} />
        <StatTile label="Blank · Multiple" value={`${s.blank} · ${s.multiple}`} hint={s.teacherEdits ? `${s.teacherEdits} teacher correction(s)` : s.source === 'manual' ? 'Entered manually' : 'From scan'} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={editing ? 'Correct answers' : 'Answers'}>
          {editing ? (
            <div className="space-y-4">
              <Alert tone="neutral">Click a bubble to change a student’s answer (click it again for blank). Changes are scored with the answer key and recorded in the audit history.</Alert>
              <AnswerGrid answers={answers} choiceCount={d!.quiz.choiceCount} onChange={(a) => setAnswers(answers.map((x) => (x.number === a.number ? a : x)))} keyChoices={keyMap} changed={changed} />
              <TextInput label="Reason (optional)" maxLength={300} placeholder="e.g. Scanner missed a light mark on item 12" value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="flex gap-2">
                <Button variant="primary" loading={saving} disabled={!changed.size} onClick={saveEdit}>
                  Save {changed.size} change{changed.size === 1 ? '' : 's'}
                </Button>
                <Button onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <ol className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {d!.questions.map((x) => (
                <li key={x.number} className="flex items-center gap-2 py-0.5 text-sm">
                  <span className="w-7 text-right font-semibold tabular">{x.number}</span>
                  <span className={cx('w-16 font-medium', x.excluded ? 'text-ink-3' : x.isCorrect ? 'text-good' : 'text-bad')}>
                    {x.status === 'answered' ? LETTERS[x.choice!] : x.status === 'multiple' ? `Multi${x.marked.length ? ` (${x.marked.map((m) => LETTERS[m]).join('')})` : ''}` : 'Blank'}
                  </span>
                  <span className="text-xs text-ink-3">{x.excluded ? 'excluded' : `key ${LETTERS[x.correctChoice ?? 0]}`}</span>
                  {x.isCorrect ? <span className="sr-only">correct</span> : !x.excluded && <span className="sr-only">incorrect</span>}
                  {x.teacherOverride && <Badge tone="primary">edited</Badge>}
                  {x.scannerStatus === 'ambiguous' && !x.teacherOverride && <Badge tone="warn">reviewed</Badge>}
                  <span className="ml-auto text-xs tabular text-ink-3">{x.excluded ? '' : `${x.pointsAwarded}/${x.points}`}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <div className="space-y-6">
          {d!.scan?.hasRectifiedImage && (
            <Card title="Scanned sheet" padded={false}>
              <a href={`/api/scans/${d!.scan.id}/image`} target="_blank" rel="noreferrer">
                <img src={`/api/scans/${d!.scan.id}/image`} alt="Scanned answer sheet" className="w-full rounded-b-xl" />
              </a>
            </Card>
          )}
          {d!.scan && !d!.scan.hasRectifiedImage && <p className="text-xs text-ink-3">The scan image was removed by your image retention setting.</p>}
          <Card title="History">
            <ul className="space-y-3 text-sm">
              {d!.history.map((h, i) => (
                <li key={i}>
                  <div>{h.summary}</div>
                  <div className="text-xs text-ink-3">{fmtDateTime(h.at)}</div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        danger
        title="Delete this result?"
        confirmLabel="Delete result"
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          try {
            await del(`/submissions/${id}`);
            toast('Result deleted');
            qc.invalidateQueries({ queryKey: ['session', d!.session.id] });
            nav(`/sessions/${d!.session.id}`);
          } catch (e) {
            toast(errorMessage(e), 'bad');
          }
        }}
      >
        The student will appear as “not yet graded” again and can be rescanned. The deletion is recorded in your activity log.
      </ConfirmDialog>
    </>
  );
}
