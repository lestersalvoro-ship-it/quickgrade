import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BookOpenCheck, Plus, Search } from 'lucide-react';
import { get } from '../lib/api';
import { fmtDate } from '../lib/format';
import type { Quiz } from '../lib/types';
import { Badge, Card, EmptyState, ErrorState, LinkButton, PageHeader, Select, Spinner, TextInput } from '../components/ui';

export function QuizzesPage() {
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState<'0' | '1'>('0');
  const query = useQuery({
    queryKey: ['quizzes', q, archived],
    queryFn: () => get<{ quizzes: Omit<Quiz, 'questions'>[] }>(`/quizzes?archived=${archived}&q=${encodeURIComponent(q)}`),
  });
  return (
    <>
      <PageHeader
        title="Quizzes"
        subtitle="Create assessments, set answer keys and print answer sheets."
        actions={
          <>
            <LinkButton to="/ai" variant="subtle">
              Draft with AI
            </LinkButton>
            <LinkButton to="/quizzes/new" variant="primary" icon={<Plus className="size-4" />}>
              New quiz
            </LinkButton>
          </>
        }
      />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <TextInput aria-label="Search quizzes" placeholder="Search by title or subject" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select aria-label="Show" className="w-auto" value={archived} onChange={(e) => setArchived(e.target.value as '0' | '1')}>
            <option value="0">Active</option>
            <option value="1">Archived</option>
          </Select>
        </div>
        {query.isLoading ? (
          <Spinner />
        ) : query.error ? (
          <div className="p-4">
            <ErrorState error={query.error} onRetry={() => query.refetch()} />
          </div>
        ) : query.data!.quizzes.length === 0 ? (
          <EmptyState icon={<BookOpenCheck className="size-6" />} title={q ? 'No quizzes match your search' : archived === '1' ? 'No archived quizzes' : 'No quizzes yet'} action={!q && archived === '0' && <LinkButton to="/quizzes/new" variant="primary">Create your first quiz</LinkButton>}>
            {!q && archived === '0' && 'A quiz holds the answer key and generates matching printable answer sheets (20, 50 or 100 items).'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {query.data!.quizzes.map((z) => (
              <li key={z.id}>
                <Link to={`/quizzes/${z.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{z.title}</span>
                      {z.keyComplete ? <Badge tone="good">Key ready</Badge> : <Badge tone="warn">Key incomplete ({z.answeredCount}/{z.questionCount})</Badge>}
                      {z.source === 'ai_assisted' && <Badge tone="primary">AI-assisted</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-3">
                      {[z.subject, `${z.questionCount} items`, `A–${'ABCDE'[z.choiceCount - 1]}`, `${z.totalPoints} pts`, `Sheet #${z.sheetCode}`].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="text-right text-xs text-ink-3">
                    <div>
                      {z.sessionCount} session{z.sessionCount === 1 ? '' : 's'} · {z.submissionCount} result{z.submissionCount === 1 ? '' : 's'}
                    </div>
                    <div>Updated {fmtDate(z.updatedAt)}</div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
