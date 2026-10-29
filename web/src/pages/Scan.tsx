import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Camera, CheckCircle2, ImageUp, Loader2, Plus, ScanLine, XCircle } from 'lucide-react';
import { ApiError, api, errorMessage, get, post } from '../lib/api';
import { fmtDate, todayIso } from '../lib/format';
import { className, type ClassItem, type Quiz, type SessionItem } from '../lib/types';
import { Alert, Badge, Button, Card, EmptyState, LinkButton, PageHeader, Select, Spinner, TextInput } from '../components/ui';
import { CameraCapture } from '../components/Camera';

interface SessionDetail {
  session: SessionItem;
  submissions: { id: number; student: { id: number; firstName: string; lastName: string; studentNumber: string } }[];
  missingStudents: { id: number; firstName: string; lastName: string; studentNumber: string }[];
  pendingScans: { id: number; createdAt: string; detectedStudentNumber: string | null; flaggedCount: number }[];
}

function NewSessionForm({ onCreated, initialQuizId, initialClassId }: { onCreated: (id: number) => void; initialQuizId?: number; initialClassId?: number }) {
  const quizzes = useQuery({ queryKey: ['quizzes', '', '0'], queryFn: () => get<{ quizzes: Quiz[] }>('/quizzes?archived=0') });
  const classes = useQuery({ queryKey: ['classes', '0'], queryFn: () => get<{ classes: ClassItem[] }>('/classes') });
  const [quizId, setQuizId] = useState<number | ''>(initialQuizId ?? '');
  const [classId, setClassId] = useState<number | ''>(initialClassId ?? '');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [heldOn, setHeldOn] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const quiz = quizzes.data?.quizzes.find((q) => q.id === quizId);
  const cls = classes.data?.classes.find((c) => c.id === classId);
  useEffect(() => {
    if (!nameTouched && quiz && cls) setName(`${quiz.title} – ${className(cls)}`.slice(0, 160));
  }, [quiz, cls, nameTouched]);
  if (quizzes.isLoading || classes.isLoading) return <Spinner />;
  const ready = quizzes.data!.quizzes.filter((q) => q.keyComplete);
  const notReady = quizzes.data!.quizzes.filter((q) => !q.keyComplete);
  if (!quizzes.data!.quizzes.length || !classes.data!.classes.length) {
    return (
      <EmptyState icon={<ScanLine className="size-6" />} title="You need a quiz and a class first">
        <div className="mt-3 flex justify-center gap-2">
          {!classes.data!.classes.length && <LinkButton to="/classes">Create a class</LinkButton>}
          {!quizzes.data!.quizzes.length && <LinkButton to="/quizzes/new">Create a quiz</LinkButton>}
        </div>
      </EmptyState>
    );
  }
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await post<{ session: SessionItem }>('/sessions', { quizId, classId, name, heldOn: heldOn || null });
          onCreated(r.session.id);
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && (
        <Alert tone="bad" className="sm:col-span-2">
          {error}
        </Alert>
      )}
      <Select label="Quiz" required value={quizId} onChange={(e) => setQuizId(e.target.value ? Number(e.target.value) : '')} hint={notReady.length ? `${notReady.length} quiz(zes) hidden because their answer key is incomplete.` : undefined}>
        <option value="">Choose a quiz…</option>
        {ready.map((q) => (
          <option key={q.id} value={q.id}>
            {q.title} ({q.questionCount} items)
          </option>
        ))}
      </Select>
      <Select label="Class" required value={classId} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : '')}>
        <option value="">Choose a class…</option>
        {classes.data!.classes.map((c) => (
          <option key={c.id} value={c.id}>
            {className(c)} ({c.studentCount})
          </option>
        ))}
      </Select>
      <TextInput label="Session name" required maxLength={160} value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} />
      <TextInput label="Date given" type="date" value={heldOn} onChange={(e) => setHeldOn(e.target.value)} />
      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" loading={busy} disabled={!quizId || !classId || !name.trim()}>
          Start grading session
        </Button>
      </div>
    </form>
  );
}

type UploadItem = { key: number; name: string; state: 'uploading' | 'ok' | 'failed'; message?: string; scanId?: number; flagged?: number };

function sessionLabel(s: SessionItem) {
  return `${s.name} · ${fmtDate(s.heldOn ?? s.createdAt)}`;
}

export function ScanPage() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const sessionId = params.get('sessionId') ? Number(params.get('sessionId')) : null;
  const sessions = useQuery({ queryKey: ['sessions', 'active'], queryFn: () => get<{ sessions: SessionItem[] }>('/sessions?pageSize=50') });
  const detail = useQuery({ queryKey: ['session', sessionId], queryFn: () => get<SessionDetail>(`/sessions/${sessionId}`), enabled: !!sessionId });
  const [showNew, setShowNew] = useState(!!params.get('quizId') || !!params.get('classId'));
  const [camera, setCamera] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);

  const choose = (id: number) => {
    setParams({ sessionId: String(id) });
    setShowNew(false);
    setUploads([]);
  };

  const uploadOne = async (file: Blob, name: string, openReview: boolean) => {
    const key = Date.now() + Math.random();
    setUploads((u) => [{ key, name, state: 'uploading' }, ...u]);
    const patch = (p: Partial<UploadItem>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
    try {
      const fd = new FormData();
      fd.append('file', file, name);
      const r = await api<{ scan: { id: number }; result: { ok: boolean; flaggedCount?: number } }>(`/sessions/${sessionId}/scans`, { method: 'POST', form: fd });
      patch({ state: 'ok', scanId: r.scan.id, flagged: r.result.flaggedCount ?? 0 });
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      if (openReview) nav(`/scans/${r.scan.id}`);
    } catch (e) {
      let message = errorMessage(e);
      if (e instanceof ApiError && e.body?.result?.error) message = `${e.body.result.error.message} ${e.body.result.error.hint}`;
      if (e instanceof ApiError && e.status === 409 && e.body?.error?.details?.scanId) message += ` (scan #${e.body.error.details.scanId})`;
      patch({ state: 'failed', message });
    }
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const list = Array.from(files).slice(0, 60);
    for (const f of list) await uploadOne(f, f.name, list.length === 1);
    setBusy(false);
  };

  const active = useMemo(() => (sessions.data?.sessions ?? []).filter((s) => !s.archived), [sessions.data]);
  const d = detail.data;

  return (
    <>
      <PageHeader title="Scan & Grade" subtitle="Photograph filled answer sheets. Every result is reviewed by you before it is saved." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card
            title="1 · Grading session"
            actions={
              !showNew && (
                <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setShowNew(true)}>
                  New session
                </Button>
              )
            }
          >
            {showNew ? (
              <div className="space-y-3">
                <NewSessionForm initialQuizId={params.get('quizId') ? Number(params.get('quizId')) : undefined} initialClassId={params.get('classId') ? Number(params.get('classId')) : undefined} onCreated={(id) => { qc.invalidateQueries({ queryKey: ['sessions'] }); choose(id); }} />
                {active.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setShowNew(false)}>
                    Use an existing session instead
                  </Button>
                )}
              </div>
            ) : sessions.isLoading ? (
              <Spinner />
            ) : active.length === 0 ? (
              <EmptyState title="No grading sessions yet" action={<Button variant="primary" onClick={() => setShowNew(true)}>Start a grading session</Button>}>
                A grading session links one quiz to one class (for example “Quiz 3 – Grade 8 Rizal”).
              </EmptyState>
            ) : (
              <Select label="Session" value={sessionId ?? ''} onChange={(e) => e.target.value && choose(Number(e.target.value))}>
                <option value="">Choose a session…</option>
                {active.map((s) => (
                  <option key={s.id} value={s.id}>
                    {sessionLabel(s)}
                  </option>
                ))}
              </Select>
            )}
          </Card>

          {sessionId && d && (
            <Card title="2 · Capture answer sheets">
              <p className="mb-4 text-sm text-ink-2">
                Quiz <strong>{d.session.quiz.title}</strong> ({d.session.quiz.questionCount} items) · Class <strong>{className(d.session.class)}</strong>
              </p>
              {camera ? (
                <CameraCapture busy={busy} onClose={() => setCamera(false)} onCapture={async (blob) => { setBusy(true); await uploadOne(blob, `camera-${Date.now()}.jpg`, true); setBusy(false); }} />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <button className="card flex flex-col items-center gap-2 p-6 text-center hover:border-primary" onClick={() => setCamera(true)}>
                    <Camera className="size-8 text-primary" aria-hidden />
                    <span className="font-semibold">Use camera</span>
                    <span className="text-xs text-ink-3">Live preview with alignment guide</span>
                  </button>
                  <label className="card flex cursor-pointer flex-col items-center gap-2 p-6 text-center hover:border-primary">
                    {busy ? <Loader2 className="size-8 animate-spin text-primary" aria-hidden /> : <ImageUp className="size-8 text-primary" aria-hidden />}
                    <span className="font-semibold">Upload photos</span>
                    <span className="text-xs text-ink-3">JPEG, PNG or WebP · select several at once</span>
                    <input type="file" accept="image/*" multiple className="sr-only" disabled={busy} onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
                  </label>
                </div>
              )}
              <details className="mt-4 text-sm text-ink-2">
                <summary className="cursor-pointer font-medium text-ink">Tips for a reliable scan</summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>Lay the sheet flat on a darker, plain surface with even light; avoid shadows from your phone or hand.</li>
                  <li>Include all four black corner squares and the code strip at the top; fill most of the frame.</li>
                  <li>Hold the phone parallel to the paper. Slight tilt and rotation (even upside-down) are corrected automatically.</li>
                  <li>Tap to focus. Blurry photos are rejected rather than guessed.</li>
                </ul>
              </details>
              {uploads.length > 0 && (
                <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
                  {uploads.map((u) => (
                    <li key={u.key} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                      {u.state === 'uploading' ? (
                        <Loader2 className="mt-0.5 size-4 animate-spin text-ink-3" aria-hidden />
                      ) : u.state === 'ok' ? (
                        <CheckCircle2 className="mt-0.5 size-4 text-good" aria-hidden />
                      ) : (
                        <XCircle className="mt-0.5 size-4 text-bad" aria-hidden />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{u.name}</div>
                        {u.state === 'uploading' && <div className="text-ink-3">Reading sheet…</div>}
                        {u.state === 'ok' && <div className="text-ink-3">{u.flagged ? `${u.flagged} answer(s) need your review` : 'Read cleanly — ready to confirm'}</div>}
                        {u.state === 'failed' && <div className="text-bad">{u.message}</div>}
                      </div>
                      {u.scanId && (
                        <LinkButton size="sm" to={`/scans/${u.scanId}`} variant={u.state === 'ok' ? 'primary' : 'secondary'}>
                          Review
                        </LinkButton>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        {sessionId && d && (
          <div className="space-y-6">
            <Card title="Progress">
              <div className="text-3xl font-semibold tabular">
                {d.submissions.length}
                <span className="text-base font-normal text-ink-3"> / {d.submissions.length + d.missingStudents.length} graded</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <LinkButton size="sm" to={`/sessions/${sessionId}`}>
                  Results &amp; analytics
                </LinkButton>
              </div>
            </Card>
            {d.pendingScans.length > 0 && (
              <Card title={`Waiting for review (${d.pendingScans.length})`} padded={false}>
                <ul className="divide-y divide-line">
                  {d.pendingScans.map((p) => (
                    <li key={p.id}>
                      <Link to={`/scans/${p.id}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-surface-2">
                        <span>
                          Scan #{p.id} {p.detectedStudentNumber ? `· ID ${p.detectedStudentNumber}` : '· no ID read'}
                        </span>
                        {p.flaggedCount > 0 ? <Badge tone="warn">{p.flaggedCount} flagged</Badge> : <Badge tone="good">Clean</Badge>}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {d.missingStudents.length > 0 && (
              <Card title={`Not yet graded (${d.missingStudents.length})`} padded={false}>
                <ul className="max-h-80 divide-y divide-line overflow-auto">
                  {d.missingStudents.map((m) => (
                    <li key={m.id} className="flex justify-between px-4 py-2 text-sm">
                      <span>
                        {m.lastName}, {m.firstName}
                      </span>
                      <span className="tabular text-ink-3">#{m.studentNumber}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}
      </div>
    </>
  );
}
