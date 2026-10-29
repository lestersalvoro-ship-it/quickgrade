import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download } from 'lucide-react';
import { errorMessage, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { User } from '../lib/types';
import { Alert, Button, Card, ConfirmDialog, PageHeader, TextInput, useToast } from '../components/ui';

export function SettingsPage() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [profile, setProfile] = useState({
    fullName: user?.fullName ?? '',
    schoolName: user?.schoolName ?? '',
    defaultPassPercent: user?.defaultPassPercent ?? 75,
    imageRetentionDays: user?.imageRetentionDays ?? 30,
  });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [del, setDel] = useState({ open: false, password: '', confirm: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const [delError, setDelError] = useState<string | null>(null);

  return (
    <>
      <PageHeader title="Settings" subtitle={user?.email} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Profile and grading defaults">
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy('profile');
              try {
                const r = await put<{ user: User }>('/settings/profile', { ...profile, schoolName: profile.schoolName || null });
                setUser({ ...user!, ...r.user });
                toast('Settings saved');
              } catch (err) {
                toast(errorMessage(err), 'bad');
              } finally {
                setBusy(null);
              }
            }}
          >
            <TextInput label="Full name" required value={profile.fullName} maxLength={120} onChange={(e) => setProfile({ ...profile, fullName: e.target.value })} />
            <TextInput label="School or organisation" value={profile.schoolName} maxLength={160} onChange={(e) => setProfile({ ...profile, schoolName: e.target.value })} />
            <TextInput
              label="Default passing score (%)"
              type="number"
              min={0}
              max={100}
              hint="Used by quizzes that don’t set their own passing score. DepEd’s passing grade is 75%."
              value={profile.defaultPassPercent}
              onChange={(e) => setProfile({ ...profile, defaultPassPercent: Math.max(0, Math.min(100, Number(e.target.value))) })}
            />
            <TextInput
              label="Keep scan photos for (days)"
              type="number"
              min={0}
              max={3650}
              hint="Photos of answer sheets are deleted this many days after a result is confirmed. 0 deletes them immediately. Scores are kept."
              value={profile.imageRetentionDays}
              onChange={(e) => setProfile({ ...profile, imageRetentionDays: Math.max(0, Math.min(3650, Math.round(Number(e.target.value)))) })}
            />
            <Button type="submit" variant="primary" loading={busy === 'profile'}>
              Save settings
            </Button>
          </form>
        </Card>

        <div className="space-y-6">
          <Card title="Change password">
            <form
              className="space-y-4"
              onSubmit={async (e) => {
                e.preventDefault();
                setPwError(null);
                if (pw.newPassword !== pw.confirm) return setPwError('The new passwords do not match.');
                setBusy('pw');
                try {
                  await post('/settings/password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword });
                  setPw({ currentPassword: '', newPassword: '', confirm: '' });
                  toast('Password changed. Other devices were signed out.');
                } catch (err) {
                  setPwError(errorMessage(err));
                } finally {
                  setBusy(null);
                }
              }}
            >
              {pwError && <Alert tone="bad">{pwError}</Alert>}
              <TextInput label="Current password" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
              <TextInput label="New password" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
              <TextInput label="Confirm new password" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
              <Button type="submit" loading={busy === 'pw'} disabled={!pw.currentPassword || !pw.newPassword}>
                Change password
              </Button>
            </form>
          </Card>

          <Card title="Your data">
            <div className="space-y-4 text-sm text-ink-2">
              <p>QuickGrade stores student names, student numbers and results only to grade and report for you. Under the Philippine Data Privacy Act (RA 10173), you and your school are responsible for collecting only what is needed and honouring access and erasure requests.</p>
              <a className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 py-2 font-medium text-ink hover:bg-surface-2" href="/api/settings/export">
                <Download className="size-4" /> Export all my data (JSON)
              </a>
              <p>To remove one learner, open the student and choose Delete. To remove everything:</p>
              <Button variant="danger" onClick={() => setDel({ open: true, password: '', confirm: '' })}>
                Delete my account
              </Button>
            </div>
          </Card>
        </div>
      </div>
      <ConfirmDialog
        open={del.open}
        danger
        title="Delete your account permanently?"
        confirmLabel="Delete everything"
        loading={busy === 'del'}
        onClose={() => setDel({ ...del, open: false })}
        onConfirm={async () => {
          setBusy('del');
          setDelError(null);
          try {
            await post('/settings/delete-account', { password: del.password, confirm: del.confirm });
            setUser(null);
            nav('/login');
          } catch (err) {
            setDelError(errorMessage(err));
          } finally {
            setBusy(null);
          }
        }}
      >
        <div className="space-y-3">
          <p>This permanently deletes your account, classes, students, quizzes, results, scan photos and audit history. Export your data first if you need it.</p>
          {delError && <Alert tone="bad">{delError}</Alert>}
          <TextInput label="Password" type="password" value={del.password} onChange={(e) => setDel({ ...del, password: e.target.value })} />
          <TextInput label='Type "DELETE" to confirm' value={del.confirm} onChange={(e) => setDel({ ...del, confirm: e.target.value })} />
        </div>
      </ConfirmDialog>
    </>
  );
}
