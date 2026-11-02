// Accio icon-BTLzGaB7 paths used by the download history rows.
const ICONS: Record<'description' | 'folder' | 'close', {
  paths: string[]; viewBox?: string; strokeWidth?: number; filled?: boolean;
}> = {
  description: { paths: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z', 'M14 3v5h5', 'M9 13h6', 'M9 16.5h3'] },
  folder: { strokeWidth: 1.6, paths: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z', 'M2 10h20'] },
  close: { viewBox: '0 0 42 42', filled: true, paths: ['M33.2256 10.4766L22.7017 21.0005L33.2256 31.5244L31.5234 33.2266L20.9995 22.7026L10.4756 33.2266L8.77344 31.5244L19.2974 21.0005L8.77344 10.4766L10.4756 8.77441L20.9995 19.2983L31.5234 8.77441L33.2256 10.4766Z'] },
};

export function DownloadIcon({ name, size }: { name: keyof typeof ICONS; size: number }) {
  const icon = ICONS[name];
  return <svg aria-hidden="true" viewBox={icon.viewBox ?? '0 0 24 24'} style={{ width: size, height: size,
    fill: icon.filled ? 'currentColor' : 'none', stroke: icon.filled ? 'none' : 'currentColor',
    strokeWidth: icon.strokeWidth ?? 1.5, verticalAlign: 'middle', display: 'block' }}>
    {icon.paths.map((path) => <path key={path} d={path} />)}
  </svg>;
}
