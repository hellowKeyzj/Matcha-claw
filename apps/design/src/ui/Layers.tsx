import { ArrowDown, ArrowUp, Eye, EyeOff, Image, LockKeyhole, LockKeyholeOpen, Type, Video } from 'lucide-react';
import type { Edit, Layer } from '../document';
import { useTranslation } from './i18n';

interface Props {
  layers: Layer[];
  selected: string[];
  busy: boolean;
  onSelect(ids: string[]): void;
  onEdit(edits: Edit[]): Promise<boolean>;
}

export function Layers({ layers, selected, busy, onSelect, onEdit }: Props) {
  const { t } = useTranslation();
  function move(id: string, delta: number) {
    const ids = layers.map((layer) => layer.id);
    const index = ids.indexOf(id);
    const next = index + delta;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    void onEdit([{ type: 'reorder', ids }]);
  }

  return <section className="layers-panel" aria-labelledby="layers-heading">
    <div className="section-heading"><h2 id="layers-heading">{t('图层')}</h2><span>{layers.length}</span></div>
    {layers.length === 0 && <p className="empty-hint">{t('拖入图片或添加文字开始设计。')}</p>}
    <div className="layer-list" role="list" aria-label={t('图层，从上到下')}>
      {[...layers].reverse().map((layer) => <div
        className={`layer-row${selected.includes(layer.id) ? ' selected' : ''}${!layer.visible ? ' hidden-layer' : ''}`}
        key={layer.id} role="listitem" draggable={!busy}
        onDragStart={(event) => { event.dataTransfer.setData('application/x-matcha-layer', layer.id); event.dataTransfer.effectAllowed = 'move'; }}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-matcha-layer')) event.preventDefault(); }}
        onDrop={(event) => {
          event.preventDefault();
          const id = event.dataTransfer.getData('application/x-matcha-layer');
          if (!id || id === layer.id || busy) return;
          const ids = layers.map((entry) => entry.id).filter((entry) => entry !== id);
          ids.splice(ids.indexOf(layer.id) + 1, 0, id);
          void onEdit([{ type: 'reorder', ids }]);
        }}
      >
        <button className="layer-select" aria-pressed={selected.includes(layer.id)} title={layer.name} onClick={(event) => {
          onSelect(event.shiftKey || event.metaKey || event.ctrlKey
            ? selected.includes(layer.id) ? selected.filter((id) => id !== layer.id) : [...selected, layer.id]
            : [layer.id]);
        }}>
          {layer.type === 'image' ? <Image size={15} /> : layer.type === 'video' ? <Video size={15} /> : <Type size={15} />}<span>{layer.name}</span>
        </button>
        <button className="icon small" title={t(layer.visible ? '隐藏图层' : '显示图层')} aria-label={t(layer.visible ? '隐藏 {name}' : '显示 {name}', { name: layer.name })} disabled={busy} onClick={() => void onEdit([{ type: 'patch', id: layer.id, changes: { visible: !layer.visible } }])}>{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
        <button className="icon small" title={t(layer.locked ? '解锁图层' : '锁定图层')} aria-label={t(layer.locked ? '解锁 {name}' : '锁定 {name}', { name: layer.name })} disabled={busy} onClick={() => void onEdit([{ type: 'patch', id: layer.id, changes: { locked: !layer.locked } }])}>{layer.locked ? <LockKeyhole size={13} /> : <LockKeyholeOpen size={13} />}</button>
      </div>)}
    </div>
    {selected.length === 1 && <div className="layer-order button-row">
      <button disabled={busy || layers.at(-1)?.id === selected[0]} onClick={() => move(selected[0], 1)}><ArrowUp size={14} />{t('上移')}</button>
      <button disabled={busy || layers[0]?.id === selected[0]} onClick={() => move(selected[0], -1)}><ArrowDown size={14} />{t('下移')}</button>
    </div>}
  </section>;
}
