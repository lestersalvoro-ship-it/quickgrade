import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Archive, Download, Pencil, Plus, Search, Trash2, Upload, Users } from 'lucide-react';
import { del, errorMessage, get, post } from '../lib/api';
import { fmtDate, fmtPct } from '../lib/format';
import { className, type ClassItem, type Student } from '../lib/types';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, PageHeader, Pagination, PassBadge, Select, Spinner, TextInput, useToast } from '../components/ui';
import { ImportDialog, StudentFormDialog } from '../components/StudentDialogs';
import { TrendChart } from '../components/charts';

export function StudentsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [classId, setClassId] = useState('');
  const [archived, setArchived] = useState<'0' | '1'>('0');
  const [sort, setSort] = useState<'name' | 'number' | 'created'>('name');
  const [page, setPage] = useState(1);
  const [add, setAdd] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const classes = useQuery({ queryKey: ['classes', '0'], queryFn: () => get<{ classes: ClassItem[] }>('/classes') });
  const q = useQuery({
    queryKey: ['students', search, classId, archived, sort, page],
    queryFn: () => get<{ students: Student[]; total: number; page: number; pageSize: number }>(`/students?q=${encodeURIComponent(search)}&classId=${classId}&archived=${archived}&sort=${sort}&page=${page}&pageSize=50`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['students'] });
  return (
    <>
      <PageHeader
        title="Students"
        subtitle="Everyone you teach, across classes. Student numbers are what learners bubble on the answer sheet."
        actions={
          <>
            <a className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium hover:bg-surface-2" href="/api/students/export.csv">
              <Download className="size-4" /> Export
            </a>
            <Button icon={<Upload className="size-4" />} onClick={() => setImportOpen(true)}>
              Import CSV
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdd(true)}>
              Add student
            </Button>
          </>
        }
      />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <TextInput
              aria-label="Search students"
              placeholder="Search name, student number or LRN"
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
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
            <option value="name">Sort: name</option>
            <option value="number">Sort: student number</option>
            <option value="created">Sort: recently added</option>
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
        ) : q.data!.students.length === 0 ? (
          <EmptyState icon={<Users className="size-6" />} title={search || classId ? 'No students match' : 'No students yet'}>
            {!search && !classId && 'Add students one at a time or import your class list from a CSV file.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs text-ink-3">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Student no.</th>
                  <th className="hidden px-4 py-2 font-medium sm:table-cell">Classes</th>
                  <th className="hidden px-4 py-2 font-medium md:table-cell">Added</th>
                </tr>
              </thead>
              <tbody>
                {q.data!.students.map((s) => (
                  <tr key={s.id} className="border-t border-line hover:bg-surface-2">
                    <td className="px-4 py-2">
                      <Link to={`/students/${s.id}`} className="font-medium text-ink hover:underline">
                        {s.lastName}, {s.firstName}
                      </Link>
                    </td>
                    <td className="px-4 py-2 tabular">{s.studentNumber}</td>
                    <td className="hidden px-4 py-2 text-ink-2 sm:table-cell">{s.classNames.join(', ') || '—'}</td>
                    <td className="hidden px-4 py-2 text-ink-3 md:table-cell">{fmtDate(s.createdAt)}</td>
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
      <StudentFormDialog open={add} onClose={() => setAdd(false)} onSaved={refresh} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={refresh} />
    </>
  );
}

interface StudentDetail {
  student: Student;
  classes: { id: number; name: string; section: string | null; archived: boolean }[];
  history: { submissionId: number; sessionId: number; sessionName: string; heldOn: string | null; quizTitle: string; quizSubject: string | null; percent: number; rawScore: number; totalPoints: number; passed: boolean; gradedAt: string }[];
}

export function StudentDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['student', Number(id)], queryFn: () => get<StudentDetail>(`/students/${id}`) });
  const [edit, setEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const s = d.student;
  const avg = d.history.length ? d.history.reduce((a, h) => a + h.percent, 0) / d.history.length : null;
  return (
    <>
      <PageHeader
        back={{ to: '/students', label: 'Students' }}
        title={`${s.firstName} ${s.lastName}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            Student no. <span className="tabular font-medium">{s.studentNumber}</span>
            {s.externalId && <>· LRN {s.externalId}</>}
            {s.archived && <Badge tone="warn">Archived</Badge>}
          </span>
        }
        actions={
          <>
            <Button icon={<Pencil className="size-4" />} onClick={() => setEdit(true)}>
              Edit
            </Button>
            <Button
              icon={<Archive className="size-4" />}
              onClick={async () => {
                await post(`/students/${s.id}/archive`, { archived: !s.archived }).catch((e) => toast(errorMessage(e), 'bad'));
                q.refetch();
                qc.invalidateQueries({ queryKey: ['students'] });
              }}
            >
              {s.archived ? 'Restore' : 'Archive'}
            </Button>
            <Button variant="ghost" className="text-bad" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Performance over time" className="lg:col-span-2">
          {d.history.length === 0 ? (
            <EmptyState title="No graded assessments yet">Results appear here once this student’s sheets are scanned and confirmed.</EmptyState>
          ) : (
            <>
              <p className="mb-4 text-sm text-ink-2">
                {d.history.length} assessment{d.history.length === 1 ? '' : 's'} · average {fmtPct(avg)}. Scores are percentages of each quiz’s total points, so different quizzes are comparable but not identical in difficulty.
              </p>
              {d.history.length > 1 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Score by assessment, oldest to newest</h3>
                  <TrendChart ariaLabel="Student score trend; exact values are listed in the table below" points={d.history.map((h) => ({ key: h.submissionId, label: fmtDate(h.heldOn ?? h.gradedAt), value: h.percent, detail: `${h.sessionName}: ${fmtPct(h.percent)} (${h.rawScore}/${h.totalPoints})` }))} />
                </div>
              )}
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-ink-3">
                    <tr>
                      <th className="py-2 font-medium">Assessment</th>
                      <th className="py-2 font-medium">Date</th>
                      <th className="py-2 text-right font-medium">Score</th>
                      <th className="py-2 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...d.history].reverse().map((h) => (
                      <tr key={h.submissionId} className="border-t border-line">
                        <td className="py-2">
                          <Link to={`/submissions/${h.submissionId}`} className="font-medium hover:underline">
                            {h.sessionName}
                          </Link>
                          <div className="text-xs text-ink-3">{h.quizTitle}</div>
                        </td>
                        <td className="py-2 text-ink-2">{fmtDate(h.heldOn ?? h.gradedAt)}</td>
                        <td className="py-2 text-right tabular">
                          {h.rawScore}/{h.totalPoints} · {fmtPct(h.percent)}
                        </td>
                        <td className="py-2 text-right">
                          <PassBadge passed={h.passed} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
        <Card title="Classes">
          {d.classes.length === 0 ? (
            <p className="text-sm text-ink-3">Not enrolled in any class.</p>
          ) : (
            <ul className="space-y-2">
              {d.classes.map((c) => (
                <li key={c.id}>
                  <Link to={`/classes/${c.id}`} className="text-sm font-medium hover:underline">
                    {className(c)}
                  </Link>
                  {c.archived && <Badge className="ml-2">Archived</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <StudentFormDialog open={edit} onClose={() => setEdit(false)} student={s} onSaved={() => { q.refetch(); qc.invalidateQueries({ queryKey: ['students'] }); }} />
      <ConfirmDialog
        open={confirmDelete}
        title="Permanently delete this student?"
        danger
        confirmLabel="Delete student and results"
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          try {
            const r = await del<{ deletedResults: number }>(`/students/${s.id}`);
            toast(`Deleted ${s.firstName} ${s.lastName} and ${r.deletedResults} result(s)`);
            qc.invalidateQueries({ queryKey: ['students'] });
            nav('/students');
          } catch (e) {
            toast(errorMessage(e), 'bad');
          }
        }}
      >
        This removes {s.firstName} {s.lastName} and all {d.history.length} of their saved results. It cannot be undone. To keep their history, archive the student instead.
      </ConfirmDialog>
    </>
  );
}
