import { anglePresets, type AnglePreset } from '../document';
import { useTranslation } from './i18n';

const labels: Record<AnglePreset, string> = {
  front: '正面', back: '背面', god: '俯视', side: '侧面',
  'three-quarter-left': '左前方 45°', 'three-quarter-right': '右前方 45°',
  'low-angle': '低角度仰视', 'face-closeup': '面部特写', environment: '环境视角',
};

export function AnglePresets({ selected, disabled, onSelect }: { selected: AnglePreset; disabled: boolean; onSelect(preset: AnglePreset): void }) {
  const { t } = useTranslation();
  return <div className="ic-angle-presets" role="group" aria-label={t('生成视角')}>
    <p className="quiet">{t('选择视角后确认生成新图层，不旋转原图。')}</p>
    <div className="ic-language-list">{anglePresets.map((preset) => <button type="button" key={preset} disabled={disabled} aria-pressed={selected === preset} onClick={() => onSelect(preset)}>{t(labels[preset])}</button>)}</div>
  </div>;
}
