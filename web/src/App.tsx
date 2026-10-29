import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { AppLayout } from './components/Layout';
import { Spinner } from './components/ui';
import { LoginPage, RegisterPage, ForgotPasswordPage, ResetPasswordPage } from './pages/Auth';
import { DashboardPage } from './pages/Dashboard';
import { QuizzesPage } from './pages/Quizzes';
import { QuizEditorPage } from './pages/QuizEditor';
import { ClassesPage, ClassDetailPage } from './pages/Classes';
import { StudentsPage, StudentDetailPage } from './pages/Students';
import { ScanPage } from './pages/Scan';
import { ScanReviewPage } from './pages/ScanReview';
import { ResultsPage, ComparePage } from './pages/Results';
import { SessionPage } from './pages/Session';
import { SubmissionPage } from './pages/Submission';
import { AiPage } from './pages/Ai';
import { SettingsPage } from './pages/Settings';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner label="Starting QuickGrade…" />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
      <Route path="/register" element={<PublicOnly><RegisterPage /></PublicOnly>} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
        <Route path="quizzes" element={<QuizzesPage />} />
        <Route path="quizzes/new" element={<QuizEditorPage />} />
        <Route path="quizzes/:id" element={<QuizEditorPage />} />
        <Route path="classes" element={<ClassesPage />} />
        <Route path="classes/:id" element={<ClassDetailPage />} />
        <Route path="students" element={<StudentsPage />} />
        <Route path="students/:id" element={<StudentDetailPage />} />
        <Route path="scan" element={<ScanPage />} />
        <Route path="scans/:id" element={<ScanReviewPage />} />
        <Route path="results" element={<ResultsPage />} />
        <Route path="results/compare" element={<ComparePage />} />
        <Route path="sessions/:id" element={<SessionPage />} />
        <Route path="submissions/:id" element={<SubmissionPage />} />
        <Route path="ai" element={<AiPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
