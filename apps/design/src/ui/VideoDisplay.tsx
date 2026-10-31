import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, Pause, Play, X } from 'lucide-react';
import { download, errorMessage } from './api';
import type { LoadedAsset } from './useAssets';
import { useTranslation } from './i18n';

interface Props {
  entry: LoadedAsset;
  player: HTMLVideoElement;
  loadAsset(assetId: string): Promise<LoadedAsset>;
  name: string;
  width: number;
  height: number;
  transform: string;
  interactive: boolean;
  onWheel(event: WheelEvent): void;
  onClose(): void;
}

export function VideoDisplay({ entry, player, loadAsset, name, width, height, transform, interactive, onWheel, onClose }: Props) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const decoder = useRef<HTMLVideoElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);
  const mounted = useRef(false);
  const [failed, setFailed] = useState(false);
  const [playError, setPlayError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [playback, setPlayback] = useState({ paused: true, time: 0, duration: 0, volume: 1 });

  useEffect(() => {
    const element = root.current!;
    mounted.current = true;
    // Only Konva draws video pixels; attach its same decoder as our mutable DOM ref.
    element.append(player);
    decoder.current = player;
    decoder.current.hidden = true;
    decoder.current.src = entry.url;
    const video = decoder.current;
    const update = () => {
      setPlayback({ paused: video.paused, time: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : 0, volume: video.volume });
      if (!video.paused) setPlayError('');
    };
    const fail = () => setFailed(true);
    const ended = () => close.current();
    const events = ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'volumechange'] as const;
    for (const event of events) video.addEventListener(event, update);
    video.addEventListener('error', fail);
    video.addEventListener('ended', ended);
    void video.play().catch((cause) => {
      if (mounted.current && !(cause instanceof DOMException && cause.name === 'AbortError')) setPlayError(errorMessage(cause));
    });
    const pauseHidden = () => { if (document.hidden) video.pause(); };
    const observer = new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) video.pause(); });
    observer.observe(element);
    document.addEventListener('visibilitychange', pauseHidden);
    return () => {
      mounted.current = false;
      observer.disconnect();
      document.removeEventListener('visibilitychange', pauseHidden);
      for (const event of events) video.removeEventListener(event, update);
      video.removeEventListener('error', fail);
      video.removeEventListener('ended', ended);
      video.pause();
      video.remove();
      decoder.current = null;
    };
  }, [entry.url, player]);

  useEffect(() => {
    const element = root.current!;
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  async function downloadVideo() {
    setDownloadError('');
    try {
      const loaded = await loadAsset(entry.asset.id);
      if (!mounted.current) { loaded.release(); return; }
      download(loaded.url, name, loaded.release);
    } catch (cause) { if (mounted.current) setDownloadError(errorMessage(cause)); }
  }

  return <div ref={root} className="ic-inline-video" style={{ width, height, transform }} onMouseDown={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    else event.stopPropagation();
  }}>
    <div className="ic-inline-video-controls" role="group" aria-label={t('视频预览：{name}', { name })} inert={!interactive} style={{ pointerEvents: interactive ? 'auto' : 'none' }}>
      <button type="button" className="icon small" aria-label={t(playback.paused ? '播放视频' : '暂停视频')} title={t(playback.paused ? '播放视频' : '暂停视频')} disabled={failed} onClick={() => {
        const video = decoder.current;
        if (!video) return;
        if (!video.paused) video.pause();
        else void video.play().catch((cause) => { if (mounted.current) setPlayError(errorMessage(cause)); });
      }}>{playback.paused ? <Play size={16} /> : <Pause size={16} />}</button>
      <input className="ic-inline-video-seek" type="range" min={0} max={playback.duration || 1} step="any" value={playback.time} disabled={failed || !playback.duration} aria-label={t('视频播放进度')} onChange={(event) => { if (decoder.current) decoder.current.currentTime = Number(event.target.value); }} />
      <input className="ic-inline-video-volume" type="range" min={0} max={1} step={0.05} value={playback.volume} aria-label={t('视频音量')} onChange={(event) => { if (decoder.current) decoder.current.volume = Number(event.target.value); }} />
      <button type="button" className="icon small" aria-label={t('下载 {name}', { name })} title={t('下载结果')} onClick={() => void downloadVideo()}><Download size={16} /></button>
      <button type="button" className="icon small" aria-label={t('关闭视频预览')} title={t('关闭视频预览')} onClick={onClose}><X size={16} /></button>
    </div>
    {(failed || playError || downloadError) && <p className="ic-inline-video-error" role="alert">{downloadError || (failed ? t('视频无法播放，请下载后使用其他播放器打开。') : t('点击播放按钮继续播放。'))}</p>}
  </div>;
}
