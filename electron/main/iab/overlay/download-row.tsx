import { memo, useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';

import type { IabDownload, IabDownloadCommand } from '../../../../src/types/desktop/iab';
import type { Labels } from './labels';

// Accio icon-BTLzGaB7: only the six icons used by download rows, panel and notice.
const ICONS: Record<'description' | 'folder' | 'folder_open' | 'more_horiz' | 'close' | 'check_circle', {
  paths: string[]; viewBox?: string; strokeWidth?: number; filled?: boolean;
}> = {
  description: { paths: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z', 'M14 3v5h5', 'M9 13h6', 'M9 16.5h3'] },
  folder: { strokeWidth: 1.6, paths: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z', 'M2 10h20'] },
  folder_open: { strokeWidth: 1.6, paths: ['m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'] },
  more_horiz: { paths: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z', 'M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z', 'M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z'] },
  close: { viewBox: '0 0 42 42', filled: true, paths: ['M33.2256 10.4766L22.7017 21.0005L33.2256 31.5244L31.5234 33.2266L20.9995 22.7026L10.4756 33.2266L8.77344 31.5244L19.2974 21.0005L8.77344 10.4766L10.4756 8.77441L20.9995 19.2983L31.5234 8.77441L33.2256 10.4766Z'] },
  check_circle: { paths: ['M22 11.08V12a10 10 0 1 1-5.93-9.14', 'M22 4L12 14.01l-3-3'] },
};

export function DownloadIcon({ name, size }: { name: keyof typeof ICONS; size: number }) {
  const icon = ICONS[name];
  return <span className="download-icon" aria-hidden="true">
    <svg viewBox={icon.viewBox ?? '0 0 24 24'} style={{ width: size, height: size,
      fill: icon.filled ? 'currentColor' : 'none', stroke: icon.filled ? 'none' : 'currentColor',
      strokeWidth: icon.strokeWidth ?? 1.5, verticalAlign: 'middle', display: 'block' }}>
      {icon.paths.map((path) => <path key={path} d={path} />)}
    </svg>
  </span>;
}

type DownloadAction = Exclude<IabDownloadCommand, { action: 'open-directory' }>['action'];
type Props = IabDownload & {
  locale: string;
  labels: Labels;
  busy: boolean;
  onAction(action: IabDownloadCommand): void;
};

function bytes(value: number, locale: string): string {
  const unit = Math.min(3, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)));
  return new Intl.NumberFormat(locale, {
    style: 'unit', unit: ['byte', 'kilobyte', 'megabyte', 'gigabyte'][unit],
    unitDisplay: unit ? 'short' : 'long', maximumFractionDigits: unit ? 1 : 0,
  }).format(value / 1024 ** unit);
}

export const DownloadRow = memo(function DownloadRow({
  id, filename, status, fileMissing, canResume, receivedBytes, totalBytes, startedAt, locale, labels, busy, onAction,
}: Props) {
  const [open, setOpen] = useState(false);
  const active = status === 'progressing' || status === 'paused' || canResume === true;
  const detail = useMemo(() => {
    const size = active && totalBytes > 0
      ? `${bytes(receivedBytes, locale)} / ${bytes(totalBytes, locale)}` : bytes(receivedBytes, locale);
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(startedAt);
    return `${fileMissing ? labels.missing : labels[status === 'completed' ? 'downloaded' : status]} · ${size} · ${time}`;
  }, [active, totalBytes, receivedBytes, startedAt, locale, labels, status, fileMissing]);
  const perform = (action: DownloadAction): void => { setOpen(false); onAction({ action, id }); };

  return <li className="download-row">
    <span className="file-icon" aria-hidden="true"><DownloadIcon name="description" size={21} /></span>
    <div className="grow">
      <button type="button" className={`filename truncate${fileMissing ? ' missing' : ''}`}
        title={filename} disabled={status !== 'completed' || fileMissing || busy} onClick={() => perform('open')}>
        {filename}
      </button>
      <p className="download-detail truncate" title={fileMissing ? labels.missingDescription : detail}>{detail}</p>
    </div>
    {status === 'completed' && !fileMissing && <button type="button" className="icon-button" disabled={busy}
      aria-label={`${labels.showInFolder}: ${filename}`} title={labels.showInFolder} onClick={() => perform('show-in-folder')}>
      <DownloadIcon name="folder" size={18} />
    </button>}
    {!active && fileMissing ? <button type="button" className="icon-button" disabled={busy}
      aria-label={`${labels.remove}: ${filename}`} title={labels.remove} onClick={() => perform('remove')}>
      <DownloadIcon name="close" size={18} />
    </button> : <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="icon-button" disabled={busy}
          aria-label={`${labels.more}: ${filename}`} title={labels.more}>
          <DownloadIcon name="more_horiz" size={18} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="panel row-menu" aria-label={`${labels.more}: ${filename}`} aria-describedby={undefined}
          side="bottom" align="end" sideOffset={4} collisionPadding={12}>
          {status === 'completed' && !fileMissing && <>
            <button type="button" onClick={() => perform('open')}>{labels.open}</button>
            <button type="button" onClick={() => perform('show-in-folder')}>{labels.showInFolder}</button>
          </>}
          {active ? <>
            <button type="button" onClick={() => perform(status === 'progressing' ? 'pause' : 'resume')}>
              {status === 'progressing' ? labels.pause : labels.resume}
            </button>
            <button type="button" onClick={() => perform('cancel')}>{labels.cancel}</button>
          </> : <button type="button" onClick={() => perform('remove')}>{labels.remove}</button>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>}
  </li>;
});
