import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripHorizontal, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from './i18n';

export interface StoryboardScene {
  id: string;
  prompt: string;
  durationSeconds?: number;
}

interface Props {
  scenes: StoryboardScene[];
  durations?: readonly number[];
  disabled: boolean;
  onChange(scenes: StoryboardScene[]): void;
}

export function StoryboardEditor({ scenes, durations, disabled, onChange }: Props) {
  const { t } = useTranslation();
  const dragged = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  function move(id: string, target: number) {
    const from = scenes.findIndex((scene) => scene.id === id);
    if (disabled || from < 0 || target < 0 || target >= scenes.length || from === target) return;
    const next = [...scenes];
    const [scene] = next.splice(from, 1);
    next.splice(target, 0, scene);
    onChange(next);
    setAnnouncement(t('镜头已移至第 {number} 位。', { number: target + 1 }));
  }

  function update(id: string, changes: Partial<Pick<StoryboardScene, 'prompt' | 'durationSeconds'>>) {
    onChange(scenes.map((scene) => scene.id === id ? { ...scene, ...changes } : scene));
  }

  return <div className="ic-storyboard-editor">
    <div className="section-heading"><h3>{t('分镜脚本')}</h3><button type="button" disabled={disabled || scenes.length >= 24} onClick={() => onChange([...scenes, { id: crypto.randomUUID(), prompt: '' }])}><Plus size={14} />{t('添加分镜')}</button></div>
    <ol className="ic-storyboard-scenes">
      {scenes.map((scene, index) => <li className="scene-input" key={scene.id} onDragOver={(event) => {
        if (!disabled && dragged.current) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; }
      }} onDrop={(event) => {
        if (!dragged.current) return;
        event.preventDefault(); event.stopPropagation();
        move(dragged.current, index);
        dragged.current = null;
      }}>
        <div className="scene-title">
          <button type="button" className="ic-scene-handle" draggable={!disabled} disabled={disabled} aria-label={t('移动镜头 {number}，可拖动或按上下方向键', { number: index + 1 })} title={t('拖动或按上下方向键排序')} onDragStart={(event) => {
            dragged.current = scene.id;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-matcha-design-scene', scene.id);
            event.stopPropagation();
          }} onDragEnd={() => { dragged.current = null; }} onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault(); event.stopPropagation();
            move(scene.id, index + (event.key === 'ArrowUp' ? -1 : 1));
          }}><GripHorizontal size={14} /><span>{t('镜头 {number}', { number: index + 1 })}</span></button>
          {!!durations?.length && <select aria-label={t('镜头 {number} 时长', { number: index + 1 })} value={scene.durationSeconds ?? durations[0]} disabled={disabled} onChange={(event) => update(scene.id, { durationSeconds: Number(event.target.value) })}>
            {scene.durationSeconds !== undefined && !durations.includes(scene.durationSeconds) && <option value={scene.durationSeconds} disabled>{t('原时长不可用')}</option>}
            {durations.map((value) => <option key={value} value={value}>{t('{value} 秒', { value })}</option>)}
          </select>}
          <div className="ic-scene-actions">
            <button type="button" className="icon small" disabled={disabled || index === 0} aria-label={t('上移镜头 {number}', { number: index + 1 })} title={t('上移镜头 {number}', { number: index + 1 })} onClick={() => move(scene.id, index - 1)}><ArrowUp size={13} /></button>
            <button type="button" className="icon small" disabled={disabled || index === scenes.length - 1} aria-label={t('下移镜头 {number}', { number: index + 1 })} title={t('下移镜头 {number}', { number: index + 1 })} onClick={() => move(scene.id, index + 1)}><ArrowDown size={13} /></button>
            <button type="button" className="icon small" disabled={disabled || scenes.length === 1} aria-label={t('删除镜头 {number}', { number: index + 1 })} title={t('删除镜头 {number}', { number: index + 1 })} onClick={() => onChange(scenes.filter((entry) => entry.id !== scene.id))}><Trash2 size={13} /></button>
          </div>
        </div>
        <textarea aria-label={t('镜头 {number} 内容', { number: index + 1 })} placeholder={t('主体、场景、景别与动作')} rows={2} value={scene.prompt} required maxLength={20000} disabled={disabled} onChange={(event) => update(scene.id, { prompt: event.target.value })} />
      </li>)}
    </ol>
    {scenes.length >= 24 && <p className="quiet">{t('分镜执行上限为 24 个镜头。')}</p>}
    <span className="visually-hidden" role="status">{announcement}</span>
  </div>;
}
