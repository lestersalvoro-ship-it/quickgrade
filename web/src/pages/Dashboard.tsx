import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BookOpenCheck, ClipboardCheck, GraduationCap, Inbox, Percent, ScanLine, Users } from 'lucide-react';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtPct, relativeTime } from '../lib/format';
import { Card, EmptyState, ErrorState, LinkButton, PageHeader, Spinner, StatTile, Alert } from '../components/ui';
import { ChartWithTable, ColumnChart } from '../components/charts';

interface DashboardData {
  counts: { quizzes: number; classes: number; students: number; sessions: number; results: number; pending: number };
  overall: { results: number; meanPercent: number | null; passRate: number | null };
  recentSessions: { id: number; name: string; heldOn: string | null; createdAt: string; quizTitle: string; className: string; submissionCount: number; meanPercent: number | null; passRate: number | null }[];
  activity: { entityType: string; action: string; summary: string; at: string }[];
}

function GettingStarted({ counts }: { counts: DashboardData['counts'] }) {
  const steps = [
    { done: counts.classes > 0, label: 'Create a class and add students', to: '/classes', cta: 'Add a class' },
    { done: counts.quizzes > 0, label: 'Create a quiz and its answer key', to: '/quizzes/new', cta: 'New quiz' },
    { done: counts.sessions > 0, label: 'Print answer sheets and start a grading session', to: '/scan', cta: 'Start grading' },
    { done: counts.results > 0, label: 'Scan the filled sheets and confirm results', to: '/scan', cta: 'Scan sheets' },
  ];
  const next = steps.find((s) => !s.done);
  if (!next) return null;
  return (
    <Card title="Get started with QuickGrade" className="mb-6">
      <ol className="space-y-2.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2.5">
              <span className={`flex size-6 items-center justify-center rounded-full text-xs font-semibold ${s.done ? 'bg-good-soft text-good' : 'bg-surface-2 text-ink-3'}`} aria-hidden>
                {s.done ? '✓' : i + 1}
              </span>
              <span className={s.done ? 'text-ink-3 line-through' : 'text-ink'}>{s.label}</span>
              {s.done && <span className="sr-only">(done)</span>}
            </span>
            {s === next && (
              <LinkButton to={s.to} variant="primary" size="sm">
                {s.cta}
              </LinkButton>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => get<DashboardData>('/dashboard') });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const chartSessions = [...d.recentSessions].filter((s) => s.submissionCount > 0).reverse();

  return (
    <>
      <PageHeader
        title={`Hello, ${user?.fullName.split(' ')[0] ?? 'teacher'}`}
        subtitle={user?.schoolName ?? 'Here is how your classes are doing.'}
        actions={
          <>
            <LinkButton to="/quizzes/new" icon={<BookOpenCheck className="size-4" />}>
              New quiz
            </LinkButton>
            <LinkButton to="/classes" icon={<GraduationCap className="size-4" />}>
              Classes
            </LinkButton>
            <LinkButton to="/scan" variant="primary" icon={<ScanLine className="size-4" />}>
              Scan sheets
            </LinkButton>
          </>
        }
      />
      <GettingStarted counts={d.counts} />
      {d.counts.pending > 0 && (
        <Alert tone="warn" title={`${d.counts.pending} scanned sheet${d.counts.pending === 1 ? '' : 's'} waiting for review`} className="mb-5">
          Open the grading session from <Link to="/results">Results</Link> to review and confirm them.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Quizzes" value={d.counts.quizzes} icon={<BookOpenCheck className="size-4" aria-hidden />} />
        <StatTile label="Classes · Students" value={`${d.counts.classes} · ${d.counts.students}`} icon={<Users className="size-4" aria-hidden />} />
        <StatTile label="Results graded" value={d.counts.results} hint={`${d.counts.sessions} grading session${d.counts.sessions === 1 ? '' : 's'}`} icon={<ClipboardCheck className="size-4" aria-hidden />} />
        <StatTile
          label="Average score"
          value={fmtPct(d.overall.meanPercent)}
          hint={d.overall.passRate === null ? 'No results yet' : `${fmtPct(d.overall.passRate)} passed (each quiz’s threshold)`}
          icon={<Percent className="size-4" aria-hidden />}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Card title="Recent grading sessions" className="lg:col-span-3" actions={<LinkButton to="/results" size="sm" variant="ghost">View all</LinkButton>}>
          {d.recentSessions.length === 0 ? (
            <EmptyState icon={<Inbox className="size-6" />} title="No grading sessions yet">
              Start a session from Scan &amp; Grade once you have a class and a quiz.
            </EmptyState>
          ) : (
            <>
              {chartSessions.length > 1 && (
                <div className="mb-5">
                  <ChartWithTable
                    title="Average score by session"
                    subtitle="Mean percent of saved results, oldest to newest"
                    chart={
                      <ColumnChart
                        ariaLabel="Average score by grading session"
                        data={chartSessions.map((s) => ({ key: s.id, label: s.name.length > 10 ? s.name.slice(0, 9) + '…' : s.name, value: s.meanPercent, detail: `${s.name}: ${fmtPct(s.meanPercent)} average, ${s.submissionCount} result(s)` }))}
                        yMax={100}
                        formatValue={(v) => `${v}%`}
                        height={180}
                      />
                    }
                    table={
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-ink-3">
                            <th className="py-1">Session</th>
                            <th className="py-1 text-right">Average</th>
                            <th className="py-1 text-right">Results</th>
                          </tr>
                        </thead>
                        <tbody>
                          {chartSessions.map((s) => (
                            <tr key={s.id} className="border-t border-line">
                              <td className="py-1">{s.name}</td>
                              <td className="py-1 text-right tabular">{fmtPct(s.meanPercent)}</td>
                              <td className="py-1 text-right tabular">{s.submissionCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    }
                  />
                </div>
              )}
              <ul className="divide-y divide-line">
                {d.recentSessions.map((s) => (
                  <li key={s.id}>
                    <Link to={`/sessions/${s.id}`} className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-ink">{s.name}</div>
                        <div className="truncate text-xs text-ink-3">
                          {s.className} · {s.quizTitle} · {fmtDate(s.heldOn ?? s.createdAt)}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-semibold tabular">{fmtPct(s.meanPercent)}</div>
                        <div className="text-xs text-ink-3">{s.submissionCount} result{s.submissionCount === 1 ? '' : 's'}</div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card title="Recent activity" className="lg:col-span-2">
          {d.activity.length === 0 ? (
            <p className="text-sm text-ink-3">Your actions (created quizzes, saved results, corrections) will show up here.</p>
          ) : (
            <ul className="space-y-3">
              {d.activity.map((a, i) => (
                <li key={i} className="text-sm">
                  <div className="text-ink">{a.summary}</div>
                  <div className="text-xs text-ink-3">{relativeTime(a.at)}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
