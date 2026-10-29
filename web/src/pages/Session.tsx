import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Archive, FileDown, Keyboard, Pencil, ScanLine, Sparkles, Trash2 } from 'lucide-react';
import { del, errorMessage, get, post, put } from '../lib/api';
import { fmtDate, fmtDateTime, fmtPct } from '../lib/format';
import { className, type Quiz, type SessionItem } from '../lib/types';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, LinkButton, Modal, PageHeader, PassBadge, Select, Spinner, StatTile, Tabs, TextInput, useToast } from '../components/ui';
import { ChartWithTable, ColumnChart } from '../components/charts';
import { AnswerGrid, type GridAnswer } from '../components/AnswerGrid';
import type { ItemStat, SummaryStats, Bin, TopicStat } from '../../../shared/analytics';

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

interface SessionDetail {
  session: SessionItem;
  submissions: {
    id: number;
    student: { id: number; firstName: string; lastName: string; studentNumber: string };
    rawScore: number;
    totalPoints: number;
    percent: number;
    correct: number;
    incorrect: number;
    blank: number;
    multiple: number;
    passed: boolean;
    source: string;
    teacherEdits: number;
    gradedAt: string;
  }[];
  missingStudents: { id: number; firstName: string; lastName: string; studentNumber: string }[];
  pendingScans: { id: number; flaggedCount: number; detectedStudentNumber: string | null }[];
}

interface Analytics {
  passPercent: number;
  stats: SummaryStats;
  rawStats: SummaryStats;
  totalPoints: number;
  passRate: number | null;
  passedCount: number;
  distribution: Bin[];
  items: ItemStat[];
  topics: TopicStat[];
  hasTopics: boolean;
}

function ManualEntryDialog({ open, onClose, sessionId, quizId, students, onSaved }: { open: boolean; onClose: () => void; sessionId: number; quizId: number; students: { id: number; firstName: string; lastName: string; studentNumber: string }[]; onSaved: () => void }) {
  const toast = useToast();
  const quiz = useQuery({ queryKey: ['quiz', String(quizId)], queryFn: () => get<{ quiz: Quiz }>(`/quizzes/${quizId}`), enabled: open });
  const [studentId, setStudentId] = useState<number | ''>('');
  const [answers, setAnswers] = useState<GridAnswer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qz = quiz.data?.quiz;
  const grid: GridAnswer[] = answers ?? (qz ? Array.from({ length: qz.questionCount }, (_, i) => ({ number: i + 1, status: 'blank' as const, choice: null })) : []);
  return (
    <Modal
      wide
      open={open}
      onClose={onClose}
      title="Enter answers manually"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!studentId}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await post<{ grade: { rawScore: number; totalPoints: number; percent: number } }>(`/sessions/${sessionId}/manual`, { studentId, responses: grid.map((a) => ({ number: a.number, status: a.status, choice: a.status === 'answered' ? a.choice : null, marked: a.marked })) });
                toast(`Saved ${r.grade.rawScore}/${r.grade.totalPoints} (${fmtPct(r.grade.percent)})`);
                setAnswers(null);
                setStudentId('');
                onSaved();
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Save result
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-2">Use this when a sheet cannot be scanned (damaged, lost, or answered on plain paper). The score is calculated with the same answer key and rules.</p>
        {error && <Alert tone="bad">{error}</Alert>}
        <Select label="Student" value={studentId} onChange={(e) => setStudentId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Choose a student without a result…</option>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.lastName}, {s.firstName} (#{s.studentNumber})
            </option>
          ))}
        </Select>
        {qz ? <AnswerGrid answers={grid} choiceCount={qz.choiceCount} onChange={(a) => setAnswers(grid.map((x) => (x.number === a.number ? a : x)))} /> : <Spinner />}
      </div>
    </Modal>
  );
}

function AnalyticsTab({ a, choiceCount }: { a: Analytics; choiceCount: number }) {
  const [sortBy, setSortBy] = useState<'number' | 'difficulty'>('number');
  const scored = a.items.filter((i) => !i.excluded);
  const missed = [...scored].filter((i) => i.percentCorrect !== null && i.percentCorrect < 50).sort((x, y) => (x.percentCorrect ?? 0) - (y.percentCorrect ?? 0));
  const items = sortBy === 'number' ? a.items : [...a.items].sort((x, y) => (x.percentCorrect ?? 101) - (y.percentCorrect ?? 101));
  if (!a.stats.count) return <EmptyState title="No results yet">Analytics appear once results are saved for this session.</EmptyState>;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Results" value={a.stats.count} />
        <StatTile label="Mean" value={fmtPct(a.stats.mean)} hint={`Median ${fmtPct(a.stats.median)}`} />
        <StatTile label="Range" value={`${fmtPct(a.stats.min, 0)}–${fmtPct(a.stats.max, 0)}`} hint={`Std. deviation ${a.stats.stdDev ?? '—'} pts`} />
        <StatTile label={`Pass rate (≥ ${a.passPercent}%)`} value={fmtPct(a.passRate)} hint={`${a.passedCount} of ${a.stats.count} passed`} />
      </div>

      <Card>
        <ChartWithTable
          title="Score distribution"
          subtitle="Number of students per 10-point band of percent score"
          chart={
            <ColumnChart
              ariaLabel="Score distribution histogram"
              data={a.distribution.map((b) => ({ key: b.label, label: b.label, value: b.count, detail: `${b.count} student${b.count === 1 ? '' : 's'} scored ${b.label}%` }))}
              formatValue={(v) => String(v)}
              integer
              yLabel="Students"
            />
          }
          table={
            <table className="w-full text-sm">
              <tbody>
                {a.distribution.map((b) => (
                  <tr key={b.label} className="border-t border-line">
                    <td className="py-1">{b.label}%</td>
                    <td className="py-1 text-right tabular">{b.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        />
      </Card>

      <Card>
        <ChartWithTable
          title="Percent correct by question"
          subtitle={`Share of the ${a.stats.count} graded students who answered each question correctly (excluded questions omitted)`}
          chart={
            <ColumnChart
              ariaLabel="Percent correct per question"
              yMax={100}
              formatValue={(v) => `${v}%`}
              labelEvery={scored.length > 50 ? 10 : scored.length > 25 ? 5 : 1}
              reference={{ value: 50, label: '50%' }}
              data={scored.map((i) => ({
                key: i.number,
                label: String(i.number),
                value: i.percentCorrect,
                detail: `Q${i.number}: ${fmtPct(i.percentCorrect)} correct · key ${LETTERS[i.correctChoice ?? 0]}${i.topDistractor !== null ? ` · most common wrong answer ${LETTERS[i.topDistractor]}` : ''}`,
              }))}
            />
          }
        />
      </Card>

      {missed.length > 0 && (
        <Card title="Frequently missed questions (under 50% correct)">
          <ul className="space-y-2 text-sm">
            {missed.slice(0, 12).map((i) => (
              <li key={i.number} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold">Q{i.number}</span>
                <span className="tabular">{fmtPct(i.percentCorrect)} correct</span>
                <span className="text-ink-3">
                  · key {LETTERS[i.correctChoice ?? 0]}
                  {i.topDistractor !== null && ` · ${i.choiceCounts[i.topDistractor]} chose ${LETTERS[i.topDistractor]}`}
                  {i.blankCount > 0 && ` · ${i.blankCount} blank`}
                  {i.topic && ` · ${i.topic}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {a.hasTopics && a.topics.length > 0 && (
        <Card title="By topic">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-3">
              <tr>
                <th className="py-1 font-medium">Topic (as tagged in the quiz)</th>
                <th className="py-1 font-medium">Questions</th>
                <th className="py-1 text-right font-medium">Avg. correct</th>
              </tr>
            </thead>
            <tbody>
              {a.topics.map((t) => (
                <tr key={t.topic} className="border-t border-line">
                  <td className="py-1.5">{t.topic}</td>
                  <td className="py-1.5 text-ink-3">{t.questions.join(', ')}</td>
                  <td className="py-1.5 text-right tabular">{fmtPct(t.percentCorrect)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card
        title="Item analysis"
        padded={false}
        actions={
          <Select aria-label="Sort items" className="w-auto min-h-8 py-1 text-sm" value={sortBy} onChange={(e) => setSortBy(e.target.value as 'number' | 'difficulty')}>
            <option value="number">By question number</option>
            <option value="difficulty">Hardest first</option>
          </Select>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-ink-3">
              <tr>
                <th className="px-4 py-2 font-medium">Q</th>
                <th className="px-2 py-2 font-medium">Key</th>
                <th className="px-2 py-2 text-right font-medium">% correct</th>
                {LETTERS.slice(0, choiceCount).map((l) => (
                  <th key={l} className="px-2 py-2 text-right font-medium">
                    {l}
                  </th>
                ))}
                <th className="px-2 py-2 text-right font-medium">Blank</th>
                <th className="px-2 py-2 text-right font-medium">Multi</th>
                <th className="px-4 py-2 text-right font-medium" title="Upper 27% minus lower 27% proportion correct; shown with 10+ results">
                  Discrim.
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.number} className="border-t border-line">
                  <td className="px-4 py-1.5 font-semibold tabular">{i.number}</td>
                  <td className="px-2 py-1.5">{i.excluded ? <Badge>excl.</Badge> : LETTERS[i.correctChoice ?? 0]}</td>
                  <td className="px-2 py-1.5 text-right tabular">{fmtPct(i.percentCorrect, 0)}</td>
                  {i.choiceCounts.map((c, k) => (
                    <td key={k} className={`px-2 py-1.5 text-right tabular ${k === i.correctChoice ? 'font-semibold text-good' : 'text-ink-2'}`}>
                      {c}
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right tabular text-ink-3">{i.blankCount}</td>
                  <td className="px-2 py-1.5 text-right tabular text-ink-3">{i.multipleCount}</td>
                  <td className="px-4 py-1.5 text-right tabular text-ink-2">{i.discrimination ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-xs text-ink-3">Choice columns count how many students picked each option; the correct option is highlighted. The discrimination index needs at least 10 results to be meaningful.</p>
      </Card>
    </div>
  );
}

interface InsightsOut {
  summary: string;
  strengths: { point: string; questions: number[] }[];
  difficulties: { point: string; questions: number[]; evidence: string }[];
  answerPatterns: { question: number; observation: string }[];
  topicsToReview: { topic: string; reason: string }[];
  suggestedActivities: { title: string; description: string }[];
  caveats: string[];
}
interface PracticeOut {
  recommendations: { focus: string; activity: string; rationale: string; questions: number[] }[];
  questions: { prompt: string; choices: string[]; correctIndex: number; explanation: string; topic: string }[];
  rejected: number;
}

function AiTab({ sessionId, hasResults, quizTitle, choiceCount }: { sessionId: number; hasResults: boolean; quizTitle: string; choiceCount: number }) {
  const nav = useNavigate();
  const toast = useToast();
  const status = useQuery({ queryKey: ['ai-status'], queryFn: () => get<{ enabled: boolean; message: string; usage: { today: number; dailyLimit: number } }>('/ai/status') });
  const latest = useQuery({ queryKey: ['ai-latest', sessionId], queryFn: () => get<{ insights: { createdAt: string; output: InsightsOut } | null; practice: { createdAt: string; output: PracticeOut } | null }>(`/ai/sessions/${sessionId}/latest`) });
  const [busy, setBusy] = useState<'insights' | 'practice' | null>(null);
  const run = async (kind: 'insights' | 'practice') => {
    setBusy(kind);
    try {
      await post(`/ai/sessions/${sessionId}/${kind}`);
      await latest.refetch();
      status.refetch();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  if (status.isLoading || latest.isLoading) return <Spinner />;
  const ins = latest.data?.insights;
  const pr = latest.data?.practice;
  const Q = ({ list }: { list: number[] }) => (list.length ? <span className="text-ink-3"> (Q{list.join(', Q')})</span> : null);
  return (
    <div className="space-y-5">
      {!status.data?.enabled ? (
        <Alert tone="warn" title="AI features are not configured">
          {status.data?.message} Scanning, grading and analytics work without AI.
        </Alert>
      ) : (
        <Alert tone="neutral" title="How AI is used here">
          Only anonymised, aggregated statistics (per-question percentages, answer distributions, topics and question text you entered) are sent — never student names or IDs. AI output is advice to review, not a judgement of any student, and never changes scores. Used today: {status.data.usage.today}/{status.data.usage.dailyLimit}.
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Sparkles className="size-4" />} loading={busy === 'insights'} disabled={!status.data?.enabled || !hasResults || !!busy} onClick={() => run('insights')}>
          {ins ? 'Refresh insights' : 'Generate performance insights'}
        </Button>
        <Button icon={<Sparkles className="size-4" />} loading={busy === 'practice'} disabled={!status.data?.enabled || !hasResults || !!busy} onClick={() => run('practice')}>
          {pr ? 'Refresh practice plan' : 'Suggest practice'}
        </Button>
      </div>
      {!hasResults && <p className="text-sm text-ink-3">Save at least one result first.</p>}

      {ins && (
        <Card title={<div><h2 className="text-base font-semibold">Performance insights</h2><p className="text-xs text-ink-3">AI-generated {fmtDateTime(ins.createdAt)} — verify before acting</p></div>}>
          <div className="space-y-4 text-sm">
            <p className="text-ink">{ins.output.summary}</p>
            {ins.output.difficulties.length > 0 && (
              <section>
                <h3 className="mb-1 font-semibold">Where students struggled</h3>
                <ul className="list-disc space-y-1 pl-5">
                  {ins.output.difficulties.map((d, i) => (
                    <li key={i}>
                      {d.point}
                      <Q list={d.questions} /> <span className="text-ink-3">— {d.evidence}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {ins.output.strengths.length > 0 && (
              <section>
                <h3 className="mb-1 font-semibold">Well understood</h3>
                <ul className="list-disc space-y-1 pl-5">
                  {ins.output.strengths.map((d, i) => (
                    <li key={i}>
                      {d.point}
                      <Q list={d.questions} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {ins.output.answerPatterns.length > 0 && (
              <section>
                <h3 className="mb-1 font-semibold">Answer patterns</h3>
                <ul className="list-disc space-y-1 pl-5">
                  {ins.output.answerPatterns.map((p, i) => (
                    <li key={i}>
                      <strong>Q{p.question}:</strong> {p.observation}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {ins.output.topicsToReview.length > 0 && (
              <section>
                <h3 className="mb-1 font-semibold">Topics to review</h3>
                <ul className="list-disc space-y-1 pl-5">
                  {ins.output.topicsToReview.map((t, i) => (
                    <li key={i}>
                      <strong>{t.topic}</strong> — {t.reason}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {ins.output.suggestedActivities.length > 0 && (
              <section>
                <h3 className="mb-1 font-semibold">Suggested follow-up</h3>
                <ul className="list-disc space-y-1 pl-5">
                  {ins.output.suggestedActivities.map((a, i) => (
                    <li key={i}>
                      <strong>{a.title}:</strong> {a.description}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {ins.output.caveats.length > 0 && <p className="text-xs text-ink-3">Caveats: {ins.output.caveats.join(' ')}</p>}
          </div>
        </Card>
      )}

      {pr && (
        <Card
          title={<div><h2 className="text-base font-semibold">Practice recommendations</h2><p className="text-xs text-ink-3">AI-generated {fmtDateTime(pr.createdAt)}</p></div>}
          actions={
            pr.output.questions.length > 0 && (
              <Button
                size="sm"
                variant="subtle"
                onClick={() =>
                  nav('/quizzes/new', {
                    state: {
                      draft: {
                        title: `Practice – ${quizTitle}`.slice(0, 160),
                        subject: '',
                        description: 'AI-suggested practice questions (teacher reviewed).',
                        instructions: '',
                        questionCount: pr.output.questions.length,
                        choiceCount,
                        source: 'ai_assisted',
                        rules: { passPercent: null, wrongPenalty: 0, penalizeBlank: false, multiplePolicy: 'incorrect', floorAtZero: true },
                        questions: pr.output.questions.map((q, i) => ({ number: i + 1, correctChoice: q.correctIndex, points: 1, excluded: false, topic: q.topic || null, prompt: q.prompt, choices: q.choices, explanation: q.explanation || null })),
                      },
                    },
                  })
                }
              >
                Review as a practice quiz
              </Button>
            )
          }
        >
          <div className="space-y-4 text-sm">
            <ul className="space-y-2">
              {pr.output.recommendations.map((r, i) => (
                <li key={i}>
                  <strong>{r.focus}</strong>
                  <Q list={r.questions} />: {r.activity} <span className="text-ink-3">({r.rationale})</span>
                </li>
              ))}
            </ul>
            {pr.output.questions.length > 0 && (
              <section>
                <h3 className="mb-2 font-semibold">Draft practice questions</h3>
                <ol className="list-decimal space-y-3 pl-5">
                  {pr.output.questions.map((q, i) => (
                    <li key={i}>
                      <p>{q.prompt}</p>
                      <ul className="mt-1 space-y-0.5">
                        {q.choices.map((c, k) => (
                          <li key={k} className={k === q.correctIndex ? 'font-semibold text-good' : 'text-ink-2'}>
                            {LETTERS[k]}. {c}
                            {k === q.correctIndex && ' ✓'}
                          </li>
                        ))}
                      </ul>
                      {q.explanation && <p className="mt-1 text-xs text-ink-3">{q.explanation}</p>}
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

export function SessionPage() {
  const { id } = useParams();
  const sid = Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'results' | 'analytics' | 'ai'>('results');
  const [sort, setSort] = useState<'name' | 'score'>('name');
  const [manual, setManual] = useState(false);
  const [rename, setRename] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState('');
  const q = useQuery({ queryKey: ['session', sid], queryFn: () => get<SessionDetail>(`/sessions/${sid}`) });
  const an = useQuery({ queryKey: ['analytics', sid], queryFn: () => get<{ analytics: Analytics; choiceCount: number }>(`/sessions/${sid}/analytics`), enabled: tab === 'analytics' });
  const subs = useMemo(() => {
    const list = [...(q.data?.submissions ?? [])];
    return sort === 'score' ? list.sort((a, b) => b.percent - a.percent) : list;
  }, [q.data, sort]);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const s = d.session;
  const refresh = () => {
    q.refetch();
    qc.invalidateQueries({ queryKey: ['analytics', sid] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const exportLink = (href: string, label: string) => (
    <a className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium hover:bg-surface-2" href={href} target={href.endsWith('.pdf') ? '_blank' : undefined} rel="noreferrer">
      <FileDown className="size-4" /> {label}
    </a>
  );
  return (
    <>
      <PageHeader
        back={{ to: '/results', label: 'Results' }}
        title={s.name}
        subtitle={
          <>
            <Link to={`/quizzes/${s.quiz.id}`} className="hover:underline">
              {s.quiz.title}
            </Link>{' '}
            ·{' '}
            <Link to={`/classes/${s.class.id}`} className="hover:underline">
              {className(s.class)}
            </Link>{' '}
            · {fmtDate(s.heldOn ?? s.createdAt)} · passing ≥ {s.passPercent}%
          </>
        }
        actions={
          <>
            {exportLink(`/api/sessions/${sid}/results.csv`, 'CSV')}
            {exportLink(`/api/sessions/${sid}/report.pdf`, 'PDF report')}
            <LinkButton variant="primary" to={`/scan?sessionId=${sid}`} icon={<ScanLine className="size-4" />}>
              Scan sheets
            </LinkButton>
          </>
        }
      />
      {d.pendingScans.length > 0 && (
        <Alert tone="warn" className="mb-4" title={`${d.pendingScans.length} scan(s) waiting for review`}>
          <Link to={`/scans/${d.pendingScans[0].id}`}>Review the next one</Link>
        </Alert>
      )}
      <div className="mb-4">
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'results', label: `Results (${d.submissions.length})` }, { id: 'analytics', label: 'Analytics' }, { id: 'ai', label: 'AI insights' }]} />
      </div>

      {tab === 'results' && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card
            className="lg:col-span-2"
            padded={false}
            title="Saved results"
            actions={
              <>
                <Select aria-label="Sort results" className="w-auto min-h-8 py-1 text-sm" value={sort} onChange={(e) => setSort(e.target.value as 'name' | 'score')}>
                  <option value="name">By name</option>
                  <option value="score">By score</option>
                </Select>
                <Button size="sm" icon={<Keyboard className="size-4" />} onClick={() => setManual(true)} disabled={!d.missingStudents.length}>
                  Manual entry
                </Button>
              </>
            }
          >
            {subs.length === 0 ? (
              <EmptyState title="No results saved yet" action={<LinkButton to={`/scan?sessionId=${sid}`} variant="primary">Scan answer sheets</LinkButton>} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-left text-xs text-ink-3">
                    <tr>
                      <th className="px-4 py-2 font-medium">Student</th>
                      <th className="px-2 py-2 text-right font-medium">Score</th>
                      <th className="px-2 py-2 text-right font-medium">%</th>
                      <th className="hidden px-2 py-2 text-right font-medium sm:table-cell">✓ / ✗ / blank</th>
                      <th className="px-4 py-2 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subs.map((r) => (
                      <tr key={r.id} className="border-t border-line hover:bg-surface-2">
                        <td className="px-4 py-2">
                          <Link to={`/submissions/${r.id}`} className="font-medium hover:underline">
                            {r.student.lastName}, {r.student.firstName}
                          </Link>
                          <div className="text-xs text-ink-3">
                            #{r.student.studentNumber} · {r.source === 'manual' ? 'manual entry' : 'scanned'}
                            {r.teacherEdits > 0 && ` · ${r.teacherEdits} correction(s)`}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right tabular">
                          {r.rawScore}/{r.totalPoints}
                        </td>
                        <td className="px-2 py-2 text-right font-semibold tabular">{fmtPct(r.percent)}</td>
                        <td className="hidden px-2 py-2 text-right tabular text-ink-2 sm:table-cell">
                          {r.correct} / {r.incorrect} / {r.blank}
                          {r.multiple > 0 && ` / ${r.multiple}m`}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <PassBadge passed={r.passed} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <div className="space-y-6">
            <Card title={`Missing (${d.missingStudents.length})`} padded={false}>
              {d.missingStudents.length === 0 ? (
                <p className="p-4 text-sm text-good">Every enrolled student has a result.</p>
              ) : (
                <ul className="max-h-72 divide-y divide-line overflow-auto">
                  {d.missingStudents.map((m) => (
                    <li key={m.id} className="flex justify-between px-4 py-2 text-sm">
                      <span>
                        {m.lastName}, {m.firstName}
                      </span>
                      <span className="tabular text-ink-3">#{m.studentNumber}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Session">
              <div className="flex flex-col gap-2">
                <Button icon={<Pencil className="size-4" />} onClick={() => { setName(s.name); setRename(true); }}>
                  Rename
                </Button>
                {exportLink(`/api/sessions/${sid}/item-analysis.csv`, 'Item analysis (CSV)')}
                <Button
                  icon={<Archive className="size-4" />}
                  onClick={async () => {
                    await post(`/sessions/${sid}/archive`, { archived: !s.archived }).catch((e) => toast(errorMessage(e), 'bad'));
                    toast(s.archived ? 'Session restored' : 'Session archived');
                    refresh();
                  }}
                >
                  {s.archived ? 'Restore' : 'Archive'}
                </Button>
                <Button variant="ghost" className="text-bad" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>
                  Delete session
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}

      {tab === 'analytics' && (an.isLoading ? <Spinner /> : an.error ? <ErrorState error={an.error} /> : <AnalyticsTab a={an.data!.analytics} choiceCount={an.data!.choiceCount} />)}
      {tab === 'ai' && <AiTab sessionId={sid} hasResults={d.submissions.length > 0} quizTitle={s.quiz.title} choiceCount={s.quiz.choiceCount} />}

      <ManualEntryDialog open={manual} onClose={() => setManual(false)} sessionId={sid} quizId={s.quiz.id} students={d.missingStudents} onSaved={refresh} />
      <Modal
        open={rename}
        onClose={() => setRename(false)}
        title="Rename session"
        footer={
          <>
            <Button onClick={() => setRename(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              onClick={async () => {
                try {
                  await put(`/sessions/${sid}`, { name, heldOn: s.heldOn });
                  setRename(false);
                  refresh();
                } catch (e) {
                  toast(errorMessage(e), 'bad');
                }
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <TextInput label="Name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
      </Modal>
      <ConfirmDialog
        open={confirmDelete}
        danger
        title="Delete grading session?"
        confirmLabel="Delete session and results"
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          try {
            await del(`/sessions/${sid}`);
            qc.invalidateQueries({ queryKey: ['sessions'] });
            toast('Session deleted');
            nav('/results');
          } catch (e) {
            toast(errorMessage(e), 'bad');
          }
        }}
      >
        This permanently deletes the session, its {d.submissions.length} saved result(s) and all scan images. Consider archiving instead.
      </ConfirmDialog>
    </>
  );
}
