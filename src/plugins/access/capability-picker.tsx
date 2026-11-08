import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Search, Zap } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { SharedCapability } from '@/types/desktop/interconnect';
import { capabilityName, capabilityOperation, groupCapabilities } from './model';

export function CapabilityPicker({ capabilities, value, disabled, onChange }: {
  capabilities: SharedCapability[]; value: string; disabled: boolean; onChange: (sourceId: string) => void;
}) {
  const { t } = useTranslation('access');
  const id = useId();
  const [query, setQuery] = useState('');
  const search = query.trim().toLocaleLowerCase();
  const visible = capabilities.filter((capability) => `${capability.name} ${capability.description} ${capability.presentation?.targetName ?? ''} ${capabilityName(capability, t)}`.toLocaleLowerCase().includes(search));
  const selected = capabilities.find((capability) => capability.sourceId === value);

  return <section className="access-capability-picker" aria-label={t('interop.selectCapability')}>
    <div className="access-picker-heading"><h3>{t('interop.selectCapability')}</h3><span>{t('interop.capabilityCount', { count: capabilities.length })}</span></div>
    <div className="access-picker-search"><Search aria-hidden="true" /><Input type="search" value={query} disabled={disabled} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} placeholder={t('interop.searchCapabilities')} aria-label={t('interop.searchCapabilities')} /></div>
    <fieldset className="access-picker-options" disabled={disabled}>
      <legend className="sr-only">{t('interop.selectCapability')}</legend>
      {groupCapabilities(visible).map((group) => <div className="access-picker-group" key={group[0].sourceId}>
        {group[0].presentation && <div className="access-capability-group"><strong>{group[0].presentation.targetName}</strong><span>{t(`interop.kinds.${group[0].presentation.kind}`)}</span></div>}
        {group.map((capability) => <label key={capability.sourceId} className="access-picker-option">
          <input type="radio" className="sr-only" name={id} value={capability.sourceId} checked={value === capability.sourceId} aria-label={capabilityName(capability, t)} aria-describedby={`${id}-${capability.sourceId}`} onChange={() => onChange(capability.sourceId)} />
          <span className="access-picker-option-content">
            <span className="access-picker-icon"><Zap aria-hidden="true" /></span>
            <span className="access-picker-copy"><strong>{capabilityOperation(capability, t)}</strong><span id={`${id}-${capability.sourceId}`}>{capability.description}</span></span>
            <span className="access-picker-check"><Check aria-hidden="true" /></span>
          </span>
        </label>)}
      </div>)}
      {!visible.length && <div className="access-picker-empty"><Search aria-hidden="true" /><p>{t(capabilities.length ? 'noResults' : 'interop.noCandidates')}</p></div>}
    </fieldset>
    <div className="access-picker-selection" aria-live="polite">
      {selected ? <><span className="access-picker-selection-label"><Check aria-hidden="true" />{t('interop.selectedCapability')}</span><strong>{capabilityName(selected, t)}</strong><p>{selected.description}</p>{selected.presentation?.kind === 'agent' && <p>{t('interop.agentNote')}</p>}</> : <p>{t('interop.chooseCapabilityNote')}</p>}
    </div>
  </section>;
}
