/** Decode the selected Blob without copying its media bytes or exposing a native path. */
export async function videoPosterBase64(file: Blob, ext: string): Promise<string | undefined> {
  const mime = ext === 'webm' ? 'video/webm' : ['mp4', 'm4v', 'mov'].includes(ext) ? 'video/mp4' : undefined;
  if (!mime) return undefined;
  // Chromium demuxes MOV through ISO-BMFF, but rejects video/quicktime.
  const url = URL.createObjectURL(file.slice(0, file.size, mime));
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  try {
    return await new Promise<string | undefined>((resolve) => {
      const unavailable = (reason: string) => {
        console.warn(`Slides video poster unavailable: ${reason}`);
        resolve(undefined);
      };
      cancel = () => unavailable('page closed');
      window.addEventListener('pagehide', cancel, { once: true });
      timer = setTimeout(() => unavailable('decode timed out'), 5_000);
      video.onerror = () => unavailable(`decode error ${video.error?.code ?? 'unknown'}`);
      video.onloadeddata = () => {
        if (!video.videoWidth || !video.videoHeight) { unavailable('empty frame'); return; }
        try {
          const scale = Math.min(1, 960 / video.videoWidth, 540 / video.videoHeight);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const context = canvas.getContext('2d');
          if (!context) { unavailable('canvas unavailable'); return; }
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png').split(',')[1]);
        } catch { unavailable('frame capture failed'); }
      };
      video.src = url;
      video.load();
    });
  } finally {
    clearTimeout(timer);
    window.removeEventListener('pagehide', cancel);
    video.onloadeddata = null;
    video.onerror = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
