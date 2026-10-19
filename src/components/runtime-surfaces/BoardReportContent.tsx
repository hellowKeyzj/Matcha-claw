import { useId, useMemo, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardWidget } from '@/types/board';
import { parseBoardReport, type BoardReportBlock } from './board-report-model';

type OpenLink = (url: string) => void | Promise<void>;
const headingClass = 'mb-2.5 text-left text-sm font-semibold text-foreground';

// Layout and zero-based SVG geometry follow OpenClaw ui/src/lib/board/widgets/report.ts (MIT).
function ReportChart({ block }: { block: Extract<BoardReportBlock, { type: 'chart' }> }) {
  const { t } = useTranslation('chat');
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const tooltipId = useId();
  const values = block.points.map((point) => point.value);
  const minimum = Math.min(0, ...values);
  const span = Math.max(0, ...values) - minimum || 1;
  const y = (value: number) => 164 - ((value - minimum) / span) * 148;
  const baseline = y(0);
  const line = block.style === 'line';
  const slotWidth = 608 / values.length;
  const barWidth = Math.min(24, slotWidth * 0.7);
  const coordinates = values.map((value, index) => ({
    x: line ? values.length === 1 ? 320 : 16 + (index / (values.length - 1)) * 608 : 16 + (index + 0.5) * slotWidth,
    y: y(value),
  }));
  const activePoint = activeIndex === null ? undefined : block.points[activeIndex];
  const activeCoordinate = activeIndex === null ? undefined : coordinates[activeIndex];
  const trackPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (!line) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    const x = ((event.clientX - bounds.left) / bounds.width) * 640;
    setActiveIndex(Math.max(0, Math.min(values.length - 1, Math.round(((x - 16) / 608) * (values.length - 1)))));
  };

  return <figure className="min-w-0 [--report-series:#2a78d6] dark:[--report-series:#3987e5] forced-colors:[--report-series:CanvasText]">
    {block.title && <figcaption className={headingClass}>{block.title}</figcaption>}
    <div className="relative">
      <svg viewBox="0 0 640 180" className="block h-auto w-full" role="group" aria-label={block.title ?? t('board.report.chartLabel', { defaultValue: 'Chart; data is available in the table below.' })} onPointerMove={trackPointer} onPointerLeave={() => setActiveIndex(null)}>
        <line x1={16} x2={624} y1={baseline} y2={baseline} stroke="hsl(var(--border))" strokeWidth={1} />
        {line && <polyline points={coordinates.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="var(--report-series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {line && activeCoordinate && <line x1={activeCoordinate.x} x2={activeCoordinate.x} y1={8} y2={172} stroke="hsl(var(--muted-foreground))" strokeWidth={1} pointerEvents="none" />}
        {coordinates.map((point, index) => {
          const item = block.points[index];
          const left = point.x - barWidth / 2;
          const end = baseline + (item.value < 0 ? 1 : -1) * Math.max(1, Math.abs(point.y - baseline));
          const radius = Math.min(4, barWidth / 2, Math.abs(end - baseline));
          const cornerY = end + (item.value < 0 ? -radius : radius);
          return <g key={index} tabIndex={0} role="img" aria-label={`${item.label}: ${item.value}`} aria-describedby={activeIndex === index ? tooltipId : undefined} className="outline-none" onPointerEnter={() => setActiveIndex(index)} onFocus={() => setActiveIndex(index)} onBlur={() => setActiveIndex(null)}>
            {line ? <circle cx={point.x} cy={point.y} r={activeIndex === index ? 5 : 4} fill="var(--report-series)" stroke="hsl(var(--card))" strokeWidth={2} />
              : <path d={`M ${left} ${baseline} V ${cornerY} Q ${left} ${end} ${left + radius} ${end} H ${left + barWidth - radius} Q ${left + barWidth} ${end} ${left + barWidth} ${cornerY} V ${baseline} Z`} fill="var(--report-series)" opacity={activeIndex !== null && activeIndex !== index ? 0.65 : 1} />}
            <rect x={point.x - (line ? slotWidth : Math.max(24, barWidth + 4)) / 2} y={line ? 0 : Math.min(end, baseline) - 12} width={line ? slotWidth : Math.max(24, barWidth + 4)} height={line ? 180 : Math.abs(end - baseline) + 24} fill="transparent" />
          </g>;
        })}
      </svg>
      {activePoint && <div id={tooltipId} role="tooltip" className="pointer-events-none absolute left-1/2 top-0 z-10 max-w-full -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-whisper">
        <strong className="block font-semibold">{activePoint.value}</strong><span className="block break-words text-muted-foreground">{activePoint.label}</span>
      </div>}
    </div>
    <table className="mt-2.5 w-full border-collapse text-xs tabular-nums">
      <tbody>{block.points.map((point, index) => <tr key={index}>
        <th scope="row" className="break-words border-b border-border/50 py-1 pr-3 text-left font-normal text-muted-foreground [overflow-wrap:anywhere]">{point.label}</th>
        <td className="border-b border-border/50 py-1 text-right text-foreground">{point.value}</td>
      </tr>)}</tbody>
    </table>
  </figure>;
}

function ReportBlock({ block, onOpenLink }: { block: BoardReportBlock; onOpenLink?: OpenLink }) {
  switch (block.type) {
    case 'text':
      return <section>
        {block.title && <h3 className={headingClass}>{block.title}</h3>}
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{block.text}</p>
      </section>;
    case 'metrics':
      return <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,120px),1fr))] gap-3">
        {block.items.map((item, index) => <div key={index} className="rounded-md border border-border bg-card p-3 [overflow-wrap:anywhere]">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="my-1 text-2xl font-semibold text-foreground">{item.value}</dd>
          {item.detail && <dd className="text-xs text-muted-foreground">{item.detail}</dd>}
        </div>)}
      </dl>;
    case 'table':
      return <div className="min-w-0 overflow-x-auto">
        <table className="w-full border-collapse tabular-nums [&_td]:border-b [&_td]:border-border [&_td]:px-2.5 [&_td]:py-2 [&_td]:text-left [&_td]:[overflow-wrap:anywhere] [&_th]:border-b [&_th]:border-border [&_th]:px-2.5 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:[overflow-wrap:anywhere]">
          {block.title && <caption className={headingClass}>{block.title}</caption>}
          <thead><tr>{block.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
          <tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>;
    case 'chart':
      return <ReportChart block={block} />;
    case 'links':
      return <section>
        {block.title && <h3 className={headingClass}>{block.title}</h3>}
        <ul className="grid list-none gap-2.5 p-0">
          {block.items.map((item, index) => <li key={index} className="[overflow-wrap:anywhere]">
            <button type="button" role="link" disabled={!onOpenLink} className="text-left text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:text-muted-foreground" onClick={() => { void onOpenLink?.(item.url); }}>{item.label}</button>
            {item.detail && <span className="block text-muted-foreground">{item.detail}</span>}
          </li>)}
        </ul>
      </section>;
  }
  return block satisfies never;
}

export function BoardReportContent({ widget, onOpenLink }: {
  widget: BoardWidget;
  onOpenLink?: (url: string) => void | Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const content = useMemo(() => parseBoardReport(widget.props), [widget.props]);
  if ('error' in content) return <div role="alert" className="space-y-2 p-4 text-xs text-muted-foreground">
    <p className="font-medium text-foreground">{t('board.report.invalid', { defaultValue: 'Report data is invalid. Update the widget content.' })}</p>
    <details><summary className="cursor-pointer">{t('board.report.errorDetails', { defaultValue: 'Show error' })}</summary><code className="mt-2 block whitespace-pre-wrap [overflow-wrap:anywhere]">{content.error}</code></details>
  </div>;
  return <article aria-label={widget.title ?? t('board.widget.kindReport', { defaultValue: 'Report' })} className="grid min-w-0 gap-5 p-[18px] text-[13px] leading-normal text-foreground">
    {content.report.blocks.map((block, index) => <ReportBlock key={index} block={block} onOpenLink={onOpenLink} />)}
  </article>;
}
