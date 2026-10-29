import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { errorMessage, get, post, put } from '../lib/api';
import type { ClassItem, Student } from '../lib/types';
import { className } from '../lib/types';
import { Alert, Badge, Button, Modal, Select, TextInput, useToast } from './ui';

export function StudentFormDialog({ open, onClose, onSaved, student, defaultClassId }: { open: boolean; onClose: () => void; onSaved: () => void; student?: Student | null; defaultClassId?: number }) {
  const toast = useToast();
  const [form, setForm] = useState({ studentNumber: '', firstName: '', lastName: '', externalId: '', email: '' });
  const [classIds, setClassIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadedFor, setLoadedFor] = useState<number | null | undefined>(undefined);
  const classes = useQuery({ queryKey: ['classes', '0'], queryFn: () => get<{ classes: ClassItem[] }>('/classes'), enabled: open });
  const detail = useQuery({ queryKey: ['student', student?.id], queryFn: () => get<{ classes: { id: number }[] }>(`/students/${student!.id}`), enabled: open && !!student });

  if (open && loadedFor !== (student?.id ?? null) && (!student || detail.data)) {
    setLoadedFor(student?.id ?? null);
    setForm({
      studentNumber: student?.studentNumber ?? '',
      firstName: student?.firstName ?? '',
      lastName: student?.lastName ?? '',
      externalId: student?.externalId ?? '',
      email: student?.email ?? '',
    });
    setClassIds(student ? detail.data!.classes.map((c) => c.id) : defaultClassId ? [defaultClassId] : []);
    setError(null);
  }
  const close = () => {
    setLoadedFor(undefined);
    onClose();
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, studentNumber: form.studentNumber || null, externalId: form.externalId || null, email: form.email || null, classIds };
      if (student) await put(`/students/${student.id}`, body);
      else await post('/students', body);
      toast(student ? 'Student updated' : 'Student added');
      onSaved();
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={student ? 'Edit student' : 'Add student'}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={submit} disabled={!form.firstName.trim() || !form.lastName.trim()}>
            {student ? 'Save' : 'Add student'}
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
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput label="First name" required value={form.firstName} onChange={set('firstName')} maxLength={80} />
          <TextInput label="Last name" required value={form.lastName} onChange={set('lastName')} maxLength={80} />
        </div>
        <TextInput
          label="Student number"
          inputMode="numeric"
          maxLength={8}
          hint="Up to 8 digits — this is what the student bubbles on the answer sheet. Leave empty to assign the next free number."
          value={form.studentNumber}
          onChange={(e) => setForm({ ...form, studentNumber: e.target.value.replace(/\D/g, '') })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput label="LRN / school ID" hint="Optional" value={form.externalId} onChange={set('externalId')} maxLength={40} />
          <TextInput label="Email" type="email" hint="Optional" value={form.email} onChange={set('email')} maxLength={200} />
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Classes</legend>
          {classes.data?.classes.length ? (
            <div className="flex flex-wrap gap-2">
              {classes.data.classes.map((c) => {
                const on = classIds.includes(c.id);
                return (
                  <button
                    type="button"
                    key={c.id}
                    aria-pressed={on}
                    onClick={() => setClassIds(on ? classIds.filter((x) => x !== c.id) : [...classIds, c.id])}
                    className={`rounded-full border px-3 py-1 text-sm ${on ? 'border-primary bg-primary-soft text-primary-soft-text' : 'border-line-strong text-ink-2'}`}
                  >
                    {className(c)}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-ink-3">No classes yet.</p>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}

interface ImportResult {
  dryRun: boolean;
  created: number;
  updated: number;
  skipped: number;
  enrolled: number;
  errors: { line: number; message: string }[];
  preview: { line: number; action: 'create' | 'update' | 'skip'; studentNumber: string; firstName: string; lastName: string; existingName: string | null }[];
}

export function ImportDialog({ open, onClose, onDone, classId: fixedClassId }: { open: boolean; onClose: () => void; onDone: () => void; classId?: number }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [classId, setClassId] = useState<number | ''>(fixedClassId ?? '');
  const [onExisting, setOnExisting] = useState<'skip' | 'update'>('skip');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const classes = useQuery({ queryKey: ['classes', '0'], queryFn: () => get<{ classes: ClassItem[] }>('/classes'), enabled: open && !fixedClassId });

  const reset = () => {
    setCsv('');
    setFileName('');
    setResult(null);
    setError(null);
  };
  const run = async (dryRun: boolean, text = csv) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<ImportResult>('/students/import', { csv: text, classId: classId || undefined, onExisting, dryRun });
      setResult(r);
      if (!dryRun) {
        toast(`Imported: ${r.created} new, ${r.updated} updated, ${r.skipped} skipped`);
        onDone();
        reset();
        onClose();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Import students from CSV"
      footer={
        <>
          <Button
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!result || result.errors.length > 0 || result.preview.length === 0} onClick={() => run(false)}>
            Import {result ? result.created + result.updated : ''} student(s)
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-2">
          Use a CSV with a header row. Recognised columns: <code>first_name</code>, <code>last_name</code> (or a single <code>name</code> as “Last, First”), and optional <code>student_number</code> (up to 8 digits), <code>lrn</code>, <code>email</code>. Rows without a student number get the next free number.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {!fixedClassId && (
            <Select label="Enroll in class" value={classId} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Don’t enroll</option>
              {classes.data?.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {className(c)}
                </option>
              ))}
            </Select>
          )}
          <Select
            label="If the student number already exists"
            value={onExisting}
            onChange={(e) => {
              setOnExisting(e.target.value as 'skip' | 'update');
              setResult(null);
            }}
          >
            <option value="skip">Keep the existing student (skip)</option>
            <option value="update">Update their name and details</option>
          </Select>
        </div>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line-strong px-4 py-6 text-sm text-ink-2 hover:bg-surface-2">
          <Upload className="size-5" aria-hidden />
          {fileName || 'Choose a .csv file'}
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 1_000_000) return setError('The file is larger than 1 MB.');
              const text = await f.text();
              setFileName(f.name);
              setCsv(text);
              run(true, text);
            }}
          />
        </label>
        {error && <Alert tone="bad">{error}</Alert>}
        {result && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge tone="good">{result.created} new</Badge>
              <Badge tone="primary">{result.updated} to update</Badge>
              <Badge>{result.skipped} skipped</Badge>
              {result.errors.length > 0 && <Badge tone="bad">{result.errors.length} with errors</Badge>}
            </div>
            {result.errors.length > 0 && (
              <Alert tone="bad" title="Fix these rows in your file, then choose it again">
                <ul className="list-disc pl-4">
                  {result.errors.slice(0, 20).map((er, i) => (
                    <li key={i}>{er.line ? `Line ${er.line}: ` : ''}{er.message}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {result.preview.length > 0 && (
              <div className="max-h-64 overflow-auto rounded-lg border border-line">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface-2 text-left text-xs text-ink-3">
                    <tr>
                      <th className="px-3 py-2">Line</th>
                      <th className="px-3 py-2">Number</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.preview.map((p) => (
                      <tr key={p.line} className="border-t border-line">
                        <td className="px-3 py-1.5 tabular text-ink-3">{p.line}</td>
                        <td className="px-3 py-1.5 tabular">{p.studentNumber}</td>
                        <td className="px-3 py-1.5">
                          {p.lastName}, {p.firstName}
                        </td>
                        <td className="px-3 py-1.5">{p.action === 'create' ? 'Add' : p.action === 'update' ? `Update ${p.existingName}` : `Skip (${p.existingName})`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
