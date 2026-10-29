import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, GitCompare, Search } from 'lucide-react';
import { get } from '../lib/api';
import { fmtDate, fmtPct } from '../lib/format';
import { className, type ClassItem, type SessionItem } from '../lib/types';
import { Badge, Button, Card, EmptyState, ErrorState, LinkButton, PageHeader, Pagination, Select, Spinner, TextInput } from '../components/ui';
import { ChartWithTable, ColumnChart } from '../components/charts';

export function ResultsPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [classId, setClassId] = useState('');
  const [sort, setSort] = useState<'recent' | 'oldest' | 'name'>('recent');
  const [archived, setArchived] = useState<'0' | '1'>('0');
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<number[]>([]);
  const classes = useQuery({ queryKey: ['classes', '0'], queryFn: () => get<{ classes: ClassItem[] }>('/classes') });
  const q = useQuery({
    queryKey: ['sessions', search, classId, sort, archived, page],
    queryFn: () => get<{ sessions: SessionItem[]; total: number; page: number; pageSize: number }>(`/sessions?q=${encodeURIComponent(search)}&classId=${classId}&sort=${sort}&archived=${archived}&page=${page}&pageSize=20`),
  });
  return (
    <>
      <PageHeader
        title="Results"
        subtitle="Grading sessions with their saved results and analytics."
        actions={
          <Button icon={<GitCompare className="size-4" />} disabled={picked.length < 2} onClick={() => nav(`/results/compare?ids=${picked.join(',')}`)}>
            Compare {picked.length >= 2 ? `(${picked.length})` : ''}
          </Button>
        }
      />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <TextInput aria-label="Search sessions" placeholder="Search session, quiz or class" className="pl-9" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <Select aria-label="Filter by class" className="w-auto" value={classId} onChange={(e) => { setClassId(e.target.value); setPage(1); }}>
            <option value="">All classes</option>
            {classes.data?.classes.map((c) => (
              <option key={c.id} value={c.id}>
                {className(c)}
              </option>
            ))}
          </Select>
          <Select aria-label="Sort" className="w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="recent">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name</option>
          </Select>
          <Select aria-label="Show" className="w-auto" value={archived} onChange={(e) => { setArchived(e.target.value as '0' | '1'); setPage(1); }}>
            <option value="0">Active</option>
            <option value="1">Archived</option>
          </Select>
        </div>
        {q.isLoading ? (
          <Spinner />
        ) : q.error ? (
          <div className="p-4">
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          </div>
        ) : q.data!.sessions.length === 0 ? (
          <EmptyState icon={<BarChart3 className="size-6" />} title="No grading sessions found" action={<LinkButton to="/scan" variant="primary">Start grading</LinkButton>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs text-ink-3">
                <tr>
                  <th className="w-10 px-4 py-2">
                    <span className="sr-only">Select to compare</span>
                  </th>
                  <th className="px-2 py-2 font-medium">Session</th>
                  <th className="hidden px-4 py-2 font-medium md:table-cell">Class</th>
                  <th className="px-4 py-2 text-right font-medium">Results</th>
                  <th className="px-4 py-2 text-right font-medium">Average</th>
                  <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Pass rate</th>
                </tr>
              </thead>
              <tbody>
                {q.data!.sessions.map((s) => (
                  <tr key={s.id} className="border-t border-line hover:bg-surface-2">
                    <td className="px-4 py-2">
                      <input type="checkbox" aria-label={`Compare ${s.name}`} checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id].slice(-12) : picked.filter((x) => x !== s.id))} />
                    </td>
                    <td className="px-2 py-2">
                      <Link to={`/sessions/${s.id}`} className="font-medium text-ink hover:underline">
                        {s.name}
                      </Link>
                      <div className="text-xs text-ink-3">
                        {s.quiz.title} · {fmtDate(s.heldOn ?? s.createdAt)}
                        {s.pendingScans > 0 && (
                          <Badge tone="warn" className="ml-2">
                            {s.pendingScans} to review
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="hidden px-4 py-2 text-ink-2 md:table-cell">{className(s.class)}</td>
                    <td className="px-4 py-2 text-right tabular">{s.submissionCount}</td>
                    <td className="px-4 py-2 text-right tabular">{fmtPct(s.meanPercent)}</td>
                    <td className="hidden px-4 py-2 text-right tabular sm:table-cell">{fmtPct(s.passRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {q.data && (
          <div className="px-4 pb-3">
            <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
          </div>
        )}
      </Card>
    </>
  );
}

interface CompareRow {
  id: number;
  name: string;
  heldOn: string | null;
  createdAt: string;
  quizTitle: string;
  className: string;
  passPercent: number;
  stats: { count: number; mean: number | null; median: number | null; min: number | null; max: number | null; stdDev: number | null };
  passRate: number | null;
}

export function ComparePage() {
  const [params] = useSearchParams();
  const ids = params.get('ids') ?? '';
  const q = useQuery({ queryKey: ['compare', ids], queryFn: () => get<{ sessions: CompareRow[] }>(`/analytics/compare?ids=${ids}`), enabled: !!ids });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} />;
  const rows = q.data?.sessions ?? [];
  const differentQuizzes = new Set(rows.map((r) => r.quizTitle)).size > 1;
  return (
    <>
      <PageHeader back={{ to: '/results', label: 'Results' }} title="Compare assessments" subtitle={`${rows.length} grading sessions`} />
      {differentQuizzes && (
        <p className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">
          These sessions use different quizzes. Percent scores are comparable in scale, but the quizzes may differ in difficulty and content.
        </p>
      )}
      <Card>
        <ChartWithTable
          title="Average score (mean percent)"
          subtitle="Hover a bar for median, range and pass rate; exact values are in the table below"
          chart={
            <ColumnChart
              ariaLabel="Average score per session"
              yMax={100}
              formatValue={(v) => `${v}%`}
              data={rows.map((r) => ({
                key: r.id,
                label: r.name.length > 12 ? r.name.slice(0, 11) + '…' : r.name,
                value: r.stats.mean,
                detail: `${r.name}: mean ${fmtPct(r.stats.mean)}, median ${fmtPct(r.stats.median)}, range ${fmtPct(r.stats.min)}–${fmtPct(r.stats.max)}, pass rate ${fmtPct(r.passRate)} (n=${r.stats.count})`,
              }))}
            />
          }
        />
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-3">
              <tr>
                <th className="py-2 font-medium">Session</th>
                <th className="py-2 text-right font-medium">n</th>
                <th className="py-2 text-right font-medium">Mean</th>
                <th className="py-2 text-right font-medium">Median</th>
                <th className="py-2 text-right font-medium">Lowest</th>
                <th className="py-2 text-right font-medium">Highest</th>
                <th className="py-2 text-right font-medium">Std. dev.</th>
                <th className="py-2 text-right font-medium">Pass rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-2">
                    <Link to={`/sessions/${r.id}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                    <div className="text-xs text-ink-3">
                      {r.quizTitle} · {r.className} · {fmtDate(r.heldOn ?? r.createdAt)}
                    </div>
                  </td>
                  <td className="py-2 text-right tabular">{r.stats.count}</td>
                  <td className="py-2 text-right tabular">{fmtPct(r.stats.mean)}</td>
                  <td className="py-2 text-right tabular">{fmtPct(r.stats.median)}</td>
                  <td className="py-2 text-right tabular">{fmtPct(r.stats.min)}</td>
                  <td className="py-2 text-right tabular">{fmtPct(r.stats.max)}</td>
                  <td className="py-2 text-right tabular">{r.stats.stdDev ?? '—'}</td>
                  <td className="py-2 text-right tabular">
                    {fmtPct(r.passRate)} <span className="text-xs text-ink-3">(≥{r.passPercent}%)</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
