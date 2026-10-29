import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Measures the rendered width of a container so charts draw crisply at any size. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface BarDatum {
  key: string | number;
  label: string;
  value: number | null;
  /** Tooltip body. */
  detail?: ReactNode;
  /** Optional emphasis (e.g. question with a reference line breach). */
  muted?: boolean;
}

/** Rounded top corners (4px data-end) with a square baseline. */
function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

function niceMax(v: number) {
  if (v <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / p) * p;
}

export function ColumnChart({
  data,
  height = 220,
  yMax,
  yLabel,
  formatValue = (v) => String(v),
  reference,
  ariaLabel,
  labelEvery = 1,
  integer = false,
}: {
  data: BarDatum[];
  height?: number;
  yMax?: number;
  yLabel?: string;
  formatValue?: (v: number) => string;
  reference?: { value: number; label: string };
  ariaLabel: string;
  labelEvery?: number;
  /** Counts: use whole-number ticks. */
  integer?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 36;
  const padR = reference ? 40 : 8;
  const padT = 12;
  const padB = 28;
  const innerW = Math.max(0, width - padL - padR);
  const innerH = height - padT - padB;
  const rawMax = Math.max(1, ...data.map((d) => d.value ?? 0));
  const intStep = Math.max(1, Math.ceil(rawMax / 5));
  const max = yMax ?? (integer ? intStep * Math.max(1, Math.ceil(rawMax / intStep)) : niceMax(rawMax));
  const band = data.length ? innerW / data.length : 0;
  const barW = Math.max(2, Math.min(24, band - 4));
  const y = (v: number) => padT + innerH - (Math.max(0, v) / max) * innerH;
  const ticks = integer && !yMax ? Array.from({ length: Math.round(max / intStep) + 1 }, (_, i) => i * intStep) : [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth={1} />
              <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--text-3)" className="tabular">
                {formatValue(Math.round(t * 10) / 10)}
              </text>
            </g>
          ))}
          {yLabel && (
            <text x={10} y={padT + innerH / 2} transform={`rotate(-90 10 ${padT + innerH / 2})`} textAnchor="middle" fontSize={11} fill="var(--text-3)">
              {yLabel}
            </text>
          )}
          {reference && (
            <g>
              <line x1={padL} x2={width - padR} y1={y(reference.value)} y2={y(reference.value)} stroke="var(--text-2)" strokeDasharray="4 3" strokeWidth={1} />
              <text x={width - padR + 4} y={y(reference.value) + 4} textAnchor="start" fontSize={11} fill="var(--text-2)">
                {reference.label}
              </text>
            </g>
          )}
          {data.map((d, i) => {
            const cx = padL + band * i + band / 2;
            const v = d.value ?? 0;
            return (
              <g key={d.key}>
                {d.value !== null && (
                  <path d={barPath(cx - barW / 2, y(v), barW, padT + innerH - y(v))} fill="var(--series-1)" opacity={hover === null || hover === i ? (d.muted ? 0.45 : 1) : 0.35} />
                )}
                {(i % labelEvery === 0 || data.length <= 12) && (
                  <text x={cx} y={height - 10} textAnchor="middle" fontSize={11} fill="var(--text-3)">
                    {d.label}
                  </text>
                )}
                {/* Hit target taller and wider than the mark. */}
                <rect x={padL + band * i} y={padT} width={band} height={innerH + 4} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1} />
              </g>
            );
          })}
          <line x1={padL} x2={width - padR} y1={padT + innerH} y2={padT + innerH} stroke="var(--border-strong)" />
        </svg>
      )}
      {hover !== null && data[hover] && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: Math.min(Math.max(0, padL + band * hover + band / 2 - 70), Math.max(0, width - 150)), top: 0, width: 150 }}
        >
          <div className="font-semibold text-ink">{data[hover].label}</div>
          <div className="text-ink-2">{data[hover].detail ?? (data[hover].value === null ? 'No data' : formatValue(data[hover].value!))}</div>
        </div>
      )}
    </div>
  );
}

export interface TrendPoint {
  key: string | number;
  label: string;
  value: number;
  detail?: ReactNode;
}

/** Single-series line chart (percent scale) with crosshair tooltip. */
export function TrendChart({ points, height = 200, reference, ariaLabel }: { points: TrendPoint[]; height?: number; reference?: { value: number; label: string }; ariaLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 36;
  const padR = 16;
  const padT = 12;
  const padB = 28;
  const innerW = Math.max(0, width - padL - padR);
  const innerH = height - padT - padB;
  const x = (i: number) => padL + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - (Math.max(0, Math.min(100, v)) / 100) * innerH;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join(' ');
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const mx = e.clientX - rect.left;
            let best = 0;
            points.forEach((_, i) => {
              if (Math.abs(x(i) - mx) < Math.abs(x(best) - mx)) best = i;
            });
            setHover(points.length ? best : null);
          }}
        >
          {[0, 25, 50, 75, 100].map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" />
              <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--text-3)">
                {t}%
              </text>
            </g>
          ))}
          {reference && (
            <g>
              <line x1={padL} x2={width - padR} y1={y(reference.value)} y2={y(reference.value)} stroke="var(--text-2)" strokeDasharray="4 3" />
              <text x={width - padR} y={y(reference.value) - 4} textAnchor="end" fontSize={11} fill="var(--text-2)">
                {reference.label}
              </text>
            </g>
          )}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} stroke="var(--border-strong)" />}
          <path d={path} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {points.map((p, i) => (
            <circle key={p.key} cx={x(i)} cy={y(p.value)} r={hover === i ? 5 : 4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
          ))}
          {points.map((p, i) =>
            points.length <= 8 || i === 0 || i === points.length - 1 ? (
              <text key={`l${p.key}`} x={x(i)} y={height - 10} textAnchor={points.length > 1 && i === 0 ? 'start' : points.length > 1 && i === points.length - 1 ? 'end' : 'middle'} fontSize={11} fill="var(--text-3)">
                {p.label}
              </text>
            ) : null,
          )}
        </svg>
      )}
      {hover !== null && points[hover] && (
        <div className="pointer-events-none absolute z-10 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-md" style={{ left: Math.min(Math.max(0, x(hover) - 80), Math.max(0, width - 170)), top: 0, width: 170 }}>
          <div className="font-semibold text-ink">{points[hover].label}</div>
          <div className="text-ink-2">{points[hover].detail ?? `${points[hover].value}%`}</div>
        </div>
      )}
    </div>
  );
}

/** Wraps a chart with a "view as table" toggle for screen readers and exact values. */
export function ChartWithTable({ chart, table, title, subtitle }: { chart: ReactNode; table?: ReactNode; title: string; subtitle?: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {subtitle && <p className="text-xs text-ink-3">{subtitle}</p>}
        </div>
        {table ? (
          <button className="text-xs font-medium text-primary hover:underline" onClick={() => setAsTable((v) => !v)}>
            {asTable ? 'Show chart' : 'Show as table'}
          </button>
        ) : null}
      </div>
      {asTable && table ? <div className="max-h-72 overflow-auto">{table}</div> : chart}
    </div>
  );
}
