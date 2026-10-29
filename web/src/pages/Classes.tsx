import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Archive, Download, GraduationCap, Pencil, Plus, Upload, UserMinus, UserPlus } from 'lucide-react';
import { del, errorMessage, get, post, put } from '../lib/api';
import { fmtDate, fmtPct } from '../lib/format';
import { className, type ClassItem, type Student } from '../lib/types';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, LinkButton, Modal, PageHeader, Select, Spinner, TextInput, useToast } from '../components/ui';
import { ImportDialog, StudentFormDialog } from '../components/StudentDialogs';

function ClassFormDialog({ open, onClose, cls, onSaved }: { open: boolean; onClose: () => void; cls?: ClassItem | null; onSaved: (c: ClassItem) => void }) {
  const [form, setForm] = useState({ name: '', section: '', subject: '', schoolYear: '' });
  const [init, setInit] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (open && init !== (cls?.id ?? null)) {
    setInit(cls?.id ?? null);
    setForm({ name: cls?.name ?? '', section: cls?.section ?? '', subject: cls?.subject ?? '', schoolYear: cls?.schoolYear ?? '' });
    setError(null);
  }
  const close = () => {
    setInit(undefined);
    onClose();
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = cls ? await put<{ class: ClassItem }>(`/classes/${cls.id}`, form) : await post<{ class: ClassItem }>('/classes', form);
      onSaved(r.class);
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal
      open={open}
      onClose={close}
      title={cls ? 'Edit class' : 'New class'}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={submit}>
            {cls ? 'Save' : 'Create class'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {error && <Alert tone="bad">{error}</Alert>}
        <TextInput label="Class name" required placeholder="e.g. Grade 8 Science" maxLength={100} value={form.name} onChange={set('name')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput label="Section" placeholder="e.g. Rizal" maxLength={60} value={form.section} onChange={set('section')} />
          <TextInput label="School year" placeholder="2026–2027" maxLength={20} value={form.schoolYear} onChange={set('schoolYear')} />
        </div>
        <TextInput label="Subject" maxLength={100} value={form.subject} onChange={set('subject')} />
      </form>
    </Modal>
  );
}

export function ClassesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [archived, setArchived] = useState<'0' | '1'>('0');
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['classes', archived], queryFn: () => get<{ classes: ClassItem[] }>(`/classes?archived=${archived}`) });
  return (
    <>
      <PageHeader
        title="Classes"
        subtitle="Group students into classes and sections to grade them together."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            New class
          </Button>
        }
      />
      <div className="mb-3 flex justify-end">
        <Select aria-label="Show" className="w-auto" value={archived} onChange={(e) => setArchived(e.target.value as '0' | '1')}>
          <option value="0">Active classes</option>
          <option value="1">Archived classes</option>
        </Select>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data!.classes.length === 0 ? (
        <Card>
          <EmptyState icon={<GraduationCap className="size-6" />} title={archived === '1' ? 'No archived classes' : 'No classes yet'} action={archived === '0' && <Button variant="primary" onClick={() => setOpen(true)}>Create a class</Button>}>
            {archived === '0' && 'Create a class, then add students one by one or import a CSV roster.'}
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {q.data!.classes.map((c) => (
            <Link key={c.id} to={`/classes/${c.id}`} className="card block p-4 hover:border-primary">
              <div className="font-semibold text-ink">{className(c)}</div>
              <div className="mt-0.5 text-sm text-ink-3">{[c.subject, c.schoolYear].filter(Boolean).join(' · ') || '—'}</div>
              <div className="mt-3 flex gap-2 text-xs">
                <Badge>{c.studentCount} students</Badge>
                <Badge>{c.sessionCount} sessions</Badge>
                {c.archived && <Badge tone="warn">Archived</Badge>}
              </div>
            </Link>
          ))}
        </div>
      )}
      <ClassFormDialog
        open={open}
        onClose={() => setOpen(false)}
        onSaved={(c) => {
          qc.invalidateQueries({ queryKey: ['classes'] });
          qc.invalidateQueries({ queryKey: ['dashboard'] });
          toast(`Class “${className(c)}” created`);
        }}
      />
    </>
  );
}

interface ClassDetail {
  class: ClassItem;
  students: (Pick<Student, 'id' | 'studentNumber' | 'firstName' | 'lastName' | 'externalId' | 'archived'> & { enrolledAt: string })[];
  sessions: { id: number; name: string; heldOn: string | null; createdAt: string; quizTitle: string; submissionCount: number; meanPercent: number | null }[];
}

function EnrollDialog({ open, onClose, classId, enrolledIds, onDone }: { open: boolean; onClose: () => void; classId: number; enrolledIds: number[]; onDone: () => void }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const q = useQuery({ queryKey: ['students', 'enroll', search], queryFn: () => get<{ students: Student[] }>(`/students?pageSize=100&q=${encodeURIComponent(search)}`), enabled: open });
  const options = (q.data?.students ?? []).filter((s) => !enrolledIds.includes(s.id));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add existing students"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!picked.length}
            onClick={async () => {
              try {
                await post(`/classes/${classId}/enroll`, { studentIds: picked });
                toast(`Enrolled ${picked.length} student(s)`);
                setPicked([]);
                onDone();
                onClose();
              } catch (e) {
                toast(errorMessage(e), 'bad');
              }
            }}
          >
            Enroll {picked.length || ''}
          </Button>
        </>
      }
    >
      <TextInput aria-label="Search students" placeholder="Search by name or number" value={search} onChange={(e) => setSearch(e.target.value)} />
      <ul className="mt-3 max-h-80 divide-y divide-line overflow-auto">
        {options.map((s) => (
          <li key={s.id}>
            <label className="flex items-center gap-3 px-1 py-2 text-sm">
              <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
              <span className="flex-1">
                {s.lastName}, {s.firstName}
              </span>
              <span className="tabular text-ink-3">#{s.studentNumber}</span>
            </label>
          </li>
        ))}
        {!q.isLoading && options.length === 0 && <li className="py-6 text-center text-sm text-ink-3">No other students found.</li>}
      </ul>
    </Modal>
  );
}

export function ClassDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['class', id], queryFn: () => get<ClassDetail>(`/classes/${id}`) });
  const [edit, setEdit] = useState(false);
  const [addStudent, setAddStudent] = useState(false);
  const [enroll, setEnroll] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [remove, setRemove] = useState<{ id: number; name: string } | null>(null);
  const refresh = () => {
    q.refetch();
    qc.invalidateQueries({ queryKey: ['classes'] });
    qc.invalidateQueries({ queryKey: ['students'] });
  };
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const active = d.students.filter((s) => !s.archived);
  return (
    <>
      <PageHeader
        back={{ to: '/classes', label: 'Classes' }}
        title={className(d.class)}
        subtitle={[d.class.subject, d.class.schoolYear, `${active.length} students`].filter(Boolean).join(' · ')}
        actions={
          <>
            <Button icon={<Pencil className="size-4" />} onClick={() => setEdit(true)}>
              Edit
            </Button>
            <Button
              icon={<Archive className="size-4" />}
              onClick={async () => {
                try {
                  await post(`/classes/${id}/archive`, { archived: !d.class.archived });
                  toast(d.class.archived ? 'Class restored' : 'Class archived');
                  refresh();
                } catch (e) {
                  toast(errorMessage(e), 'bad');
                }
              }}
            >
              {d.class.archived ? 'Restore' : 'Archive'}
            </Button>
            <LinkButton to={`/scan?classId=${d.class.id}`} variant="primary">
              Grade this class
            </LinkButton>
          </>
        }
      />
      {d.class.archived && (
        <Alert tone="warn" className="mb-4">
          This class is archived. Restore it to start new grading sessions.
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title={`Roster (${active.length})`}
          padded={false}
          actions={
            <>
              <Button size="sm" icon={<UserPlus className="size-4" />} onClick={() => setAddStudent(true)}>
                New student
              </Button>
              <Button size="sm" onClick={() => setEnroll(true)}>
                Add existing
              </Button>
              <Button size="sm" icon={<Upload className="size-4" />} onClick={() => setImportOpen(true)}>
                Import CSV
              </Button>
              <a className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-sm font-medium hover:bg-surface-2" href={`/api/classes/${id}/export.csv`}>
                <Download className="size-4" /> Export
              </a>
            </>
          }
        >
          {d.students.length === 0 ? (
            <EmptyState title="No students in this class yet">Add students one at a time or import a CSV roster.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-left text-xs text-ink-3">
                  <tr>
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Student no.</th>
                    <th className="px-4 py-2 font-medium">LRN</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {d.students.map((s) => (
                    <tr key={s.id} className="border-t border-line">
                      <td className="px-4 py-2">
                        <Link to={`/students/${s.id}`} className="font-medium text-ink hover:underline">
                          {s.lastName}, {s.firstName}
                        </Link>
                        {s.archived && (
                          <Badge tone="warn" className="ml-2">
                            Archived
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-2 tabular">{s.studentNumber}</td>
                      <td className="px-4 py-2 tabular text-ink-3">{s.externalId ?? '—'}</td>
                      <td className="px-4 py-2 text-right">
                        <button className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-bad" aria-label={`Remove ${s.firstName} ${s.lastName} from class`} onClick={() => setRemove({ id: s.id, name: `${s.firstName} ${s.lastName}` })}>
                          <UserMinus className="size-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Grading sessions" padded={false}>
          {d.sessions.length === 0 ? (
            <p className="p-4 text-sm text-ink-3">No sessions yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {d.sessions.map((s) => (
                <li key={s.id}>
                  <Link to={`/sessions/${s.id}`} className="flex justify-between gap-2 px-4 py-2.5 hover:bg-surface-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{s.name}</div>
                      <div className="truncate text-xs text-ink-3">
                        {s.quizTitle} · {fmtDate(s.heldOn ?? s.createdAt)}
                      </div>
                    </div>
                    <div className="text-right text-sm tabular">
                      {fmtPct(s.meanPercent)}
                      <div className="text-xs text-ink-3">{s.submissionCount} results</div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <ClassFormDialog open={edit} onClose={() => setEdit(false)} cls={d.class} onSaved={() => { toast('Class updated'); refresh(); }} />
      <StudentFormDialog open={addStudent} onClose={() => setAddStudent(false)} onSaved={refresh} defaultClassId={d.class.id} />
      <EnrollDialog open={enroll} onClose={() => setEnroll(false)} classId={d.class.id} enrolledIds={d.students.map((s) => s.id)} onDone={refresh} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={refresh} classId={d.class.id} />
      <ConfirmDialog
        open={!!remove}
        title="Remove from class?"
        confirmLabel="Remove"
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          try {
            await del(`/classes/${id}/students/${remove!.id}`);
            toast('Removed from class');
            setRemove(null);
            refresh();
          } catch (e) {
            toast(errorMessage(e), 'bad');
          }
        }}
      >
        {remove?.name} will be removed from this class. Their student record and saved results are kept.
      </ConfirmDialog>
    </>
  );
}
