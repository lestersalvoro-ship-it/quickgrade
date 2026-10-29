import { cx } from './ui';

export interface GridAnswer {
  number: number;
  status: 'answered' | 'blank' | 'multiple';
  choice: number | null;
  marked?: number[];
}

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

/** Compact editable answer grid used for manual entry and result corrections. */
export function AnswerGrid({
  answers,
  choiceCount,
  onChange,
  keyChoices,
  changed,
}: {
  answers: GridAnswer[];
  choiceCount: number;
  onChange: (a: GridAnswer) => void;
  keyChoices?: Map<number, { correct: number | null; excluded: boolean }>;
  changed?: Set<number>;
}) {
  return (
    <ol className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
      {answers.map((a) => {
        const k = keyChoices?.get(a.number);
        return (
          <li key={a.number} className={cx('flex items-center gap-2 rounded px-1 py-0.5', changed?.has(a.number) && 'bg-primary-soft')}>
            <span className="w-7 text-right text-sm font-semibold tabular">{a.number}</span>
            <div className="flex gap-1" role="radiogroup" aria-label={`Answer for question ${a.number}`}>
              {LETTERS.slice(0, choiceCount).map((l, i) => {
                const on = a.status === 'answered' && a.choice === i;
                const multi = a.status === 'multiple' && (a.marked ?? []).includes(i);
                return (
                  <button
                    key={l}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => onChange(on ? { ...a, status: 'blank', choice: null } : { ...a, status: 'answered', choice: i })}
                    className={cx('size-8 rounded-full border text-xs font-semibold', on ? 'border-primary bg-primary text-primary-fg' : multi ? 'border-warn bg-warn-soft text-warn' : 'border-line-strong text-ink-2 hover:border-primary')}
                  >
                    {l}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className={cx('rounded px-1.5 py-0.5 text-[11px]', a.status === 'multiple' ? 'bg-warn-soft text-warn' : 'text-ink-3 hover:bg-surface-2')}
              onClick={() => onChange(a.status === 'multiple' ? { ...a, status: 'blank', choice: null, marked: [] } : { ...a, status: 'multiple', choice: null, marked: a.choice !== null ? [a.choice] : (a.marked ?? []) })}
              aria-pressed={a.status === 'multiple'}
              title="Mark as multiple answers (no credit)"
            >
              multi
            </button>
            {k && (
              <span className={cx('ml-auto text-xs', k.excluded ? 'text-ink-3' : a.status === 'answered' && a.choice === k.correct ? 'text-good' : 'text-ink-3')}>
                {k.excluded ? 'excl.' : `key ${LETTERS[k.correct ?? 0]}`}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
