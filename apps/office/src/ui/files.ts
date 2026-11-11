export function pickFiles(accept: string, multiple = false): Promise<readonly File[]> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.multiple = multiple;
  return new Promise((resolve) => {
    input.onchange = () => resolve([...input.files ?? []]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export function downloadFile(name: string, bytes: Uint8Array, mimeType: string): { ok: true; path: string } {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { ok: true, path: name };
}
