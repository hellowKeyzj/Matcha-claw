import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { FleetRegistrationFieldsProps } from '../extensions';
import { displayNameFromEndpointUrl } from './form';
import type { ContainerAuthMethod, FleetRegistrationFormState, SshAuthMethod, VmAuthMethod } from './form';

const SSH_AUTH_METHOD_OPTIONS: readonly SshAuthMethod[] = ['password', 'private-key'];
const CONTAINER_AUTH_METHOD_OPTIONS: readonly ContainerAuthMethod[] = ['none', 'bearer-token'];
const VM_AUTH_METHOD_OPTIONS: readonly VmAuthMethod[] = ['password', 'private-key'];

export function SshFields({ form, setForm, clearCredentialOperationIds }: FleetRegistrationFieldsProps) {
  const { t } = useTranslation();
  const update = <K extends keyof FleetRegistrationFormState>(key: K, value: FleetRegistrationFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const updateSshHost = (value: string) => {
    setForm((current) => ({
      ...current,
      sshHost: value,
      displayName: current.displayName.trim() ? current.displayName : value.trim(),
    }));
  };

  return (
    <div className="space-y-4 rounded-xl border border-border/70 p-4">
      <p className="text-sm font-medium">{t('remoteFleet.registration.ssh.title')}</p>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div className="space-y-2">
          <Label htmlFor="remote-node-ssh-host">{t('remoteFleet.registration.ssh.fields.host')}</Label>
          <Input id="remote-node-ssh-host" value={form.sshHost} onChange={(event) => updateSshHost(event.target.value)} placeholder={t('remoteFleet.registration.ssh.placeholders.host')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="remote-node-ssh-port">{t('remoteFleet.registration.ssh.fields.port')}</Label>
          <Input id="remote-node-ssh-port" inputMode="numeric" value={form.sshPort} onChange={(event) => update('sshPort', event.target.value)} placeholder={t('remoteFleet.registration.ssh.placeholders.port')} />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="remote-node-ssh-username">{t('remoteFleet.registration.ssh.fields.username')}</Label>
          <Input id="remote-node-ssh-username" value={form.sshUsername} onChange={(event) => update('sshUsername', event.target.value)} placeholder={t('remoteFleet.registration.ssh.placeholders.username')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="remote-node-ssh-auth-method">{t('remoteFleet.registration.ssh.auth.label')}</Label>
          <Select
            id="remote-node-ssh-auth-method"
            value={form.sshAuthMethod}
            onChange={(event) => {
              const method = event.target.value as SshAuthMethod;
              clearCredentialOperationIds();
              setForm((current) => ({ ...current, sshAuthMethod: method, sshPassword: '', sshPrivateKey: '' }));
            }}
          >
            {SSH_AUTH_METHOD_OPTIONS.map((method) => (
              <option key={method} value={method}>{t(`remoteFleet.registration.ssh.auth.methods.${method}`)}</option>
            ))}
          </Select>
        </div>
      </div>
      {form.sshAuthMethod === 'password' ? (
        <div className="space-y-2">
          <Label htmlFor="remote-node-ssh-password">{t('remoteFleet.registration.ssh.auth.fields.password')}</Label>
          <Input id="remote-node-ssh-password" type="password" value={form.sshPassword} onChange={(event) => update('sshPassword', event.target.value)} placeholder={t('remoteFleet.registration.ssh.auth.placeholders.password')} />
        </div>
      ) : null}
      {form.sshAuthMethod === 'private-key' ? (
        <div className="space-y-2">
          <Label htmlFor="remote-node-ssh-private-key">{t('remoteFleet.registration.ssh.auth.fields.privateKey')}</Label>
          <Textarea id="remote-node-ssh-private-key" value={form.sshPrivateKey} onChange={(event) => update('sshPrivateKey', event.target.value)} placeholder={t('remoteFleet.registration.ssh.auth.placeholders.privateKey')} />
        </div>
      ) : null}
    </div>
  );
}

export function ContainerFields({ form, editing, setForm, clearCredentialOperationIds }: FleetRegistrationFieldsProps) {
  const { t } = useTranslation();
  const update = <K extends keyof FleetRegistrationFormState>(key: K, value: FleetRegistrationFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const updateEndpointUrl = (value: string) => {
    setForm((current) => ({
      ...current,
      endpointUrl: value,
      displayName: current.displayName.trim() ? current.displayName : displayNameFromEndpointUrl(value),
    }));
  };

  return (
    <div className="space-y-4 rounded-xl border border-border/70 p-4">
      <p className="text-sm font-medium">{t('remoteFleet.registration.container.title')}</p>
      <div className="space-y-2">
        <Label htmlFor="remote-node-container-auth">{t('remoteFleet.registration.container.fields.authentication')}</Label>
        <Select
          id="remote-node-container-auth"
          value={form.containerAuthMethod}
          onChange={(event) => {
            clearCredentialOperationIds();
            setForm((current) => ({ ...current, containerAuthMethod: event.target.value as ContainerAuthMethod, containerBearerToken: '' }));
          }}
        >
          {CONTAINER_AUTH_METHOD_OPTIONS.map((method) => (
            <option key={method} value={method}>{t(`remoteFleet.registration.container.authMethods.${method}`)}</option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="remote-node-container-endpoint">{t('remoteFleet.registration.fields.dockerEndpoint')}</Label>
        <Input id="remote-node-container-endpoint" value={form.endpointUrl} onChange={(event) => updateEndpointUrl(event.target.value)} placeholder={t('remoteFleet.registration.helpers.container.endpointUrlPlaceholder')} />
        <p className="text-xs leading-5 text-muted-foreground">{t('remoteFleet.registration.container.help.endpoint')}</p>
      </div>
      {!editing ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="remote-node-container-name">{t('remoteFleet.registration.container.fields.containerName')}</Label>
            <Input id="remote-node-container-name" value={form.containerName} onChange={(event) => update('containerName', event.target.value)} placeholder={t('remoteFleet.registration.container.placeholders.containerName')} />
            <p className="text-xs leading-5 text-muted-foreground">{t('remoteFleet.registration.container.help.containerName')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="remote-node-container-image">{t('remoteFleet.registration.container.fields.image')}</Label>
            <Input id="remote-node-container-image" value={form.containerImage} onChange={(event) => update('containerImage', event.target.value)} placeholder={t('remoteFleet.registration.container.placeholders.image')} />
            <p className="text-xs leading-5 text-muted-foreground">{t('remoteFleet.registration.container.help.image')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="remote-node-container-image-candidates">{t('remoteFleet.registration.container.fields.imageCandidates')}</Label>
            <Textarea id="remote-node-container-image-candidates" value={form.containerImageCandidates} onChange={(event) => update('containerImageCandidates', event.target.value)} placeholder={t('remoteFleet.registration.container.placeholders.imageCandidates')} />
            <p className="text-xs leading-5 text-muted-foreground">{t('remoteFleet.registration.container.help.imageCandidates')}</p>
          </div>
        </>
      ) : null}
      {form.containerAuthMethod === 'bearer-token' ? (
        <div className="space-y-2">
          <Label htmlFor="remote-node-container-bearer-token">{t('remoteFleet.registration.container.fields.bearerToken')}</Label>
          <Input id="remote-node-container-bearer-token" type="password" value={form.containerBearerToken} onChange={(event) => update('containerBearerToken', event.target.value)} placeholder={t('remoteFleet.registration.container.placeholders.bearerToken')} />
        </div>
      ) : null}
    </div>
  );
}

export function K8sFields({ form, setForm }: FleetRegistrationFieldsProps) {
  const { t } = useTranslation();
  const update = <K extends keyof FleetRegistrationFormState>(key: K, value: FleetRegistrationFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const updateK8sApiServerUrl = (value: string) => {
    setForm((current) => ({
      ...current,
      k8sApiServerUrl: value,
      displayName: current.displayName.trim() ? current.displayName : displayNameFromEndpointUrl(value),
    }));
  };

  return (
    <div className="space-y-4 rounded-xl border border-border/70 p-4">
      <p className="text-sm font-medium">{t('remoteFleet.registration.k8s.connection.title')}</p>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div className="space-y-2">
          <Label htmlFor="remote-node-k8s-api-server">{t('remoteFleet.registration.k8s.fields.apiServerUrl')}</Label>
          <Input id="remote-node-k8s-api-server" value={form.k8sApiServerUrl} onChange={(event) => updateK8sApiServerUrl(event.target.value)} placeholder={t('remoteFleet.registration.helpers.k8sPod.endpointUrlPlaceholder')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="remote-node-k8s-namespace">{t('remoteFleet.registration.k8s.fields.namespace')}</Label>
          <Input id="remote-node-k8s-namespace" value={form.k8sNamespace} onChange={(event) => update('k8sNamespace', event.target.value)} placeholder={t('remoteFleet.registration.k8s.placeholders.namespace')} />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="remote-node-k8s-token">{t('remoteFleet.registration.k8s.fields.bearerToken')}</Label>
        <Input id="remote-node-k8s-token" type="password" value={form.k8sBearerToken} onChange={(event) => update('k8sBearerToken', event.target.value)} placeholder={t('remoteFleet.registration.k8s.placeholders.bearerToken')} />
      </div>
    </div>
  );
}

export function CustomFields({ form, setForm }: FleetRegistrationFieldsProps) {
  const { t } = useTranslation();
  const updateEndpointUrl = (value: string) => {
    setForm((current) => ({
      ...current,
      endpointUrl: value,
      displayName: current.displayName.trim() ? current.displayName : displayNameFromEndpointUrl(value),
    }));
  };

  return (
    <div className="space-y-4 rounded-xl border border-border/70 p-4">
      <p className="text-sm font-medium">{t('remoteFleet.registration.custom.title')}</p>
      <div className="space-y-2">
        <Label htmlFor="remote-node-custom-endpoint">{t('remoteFleet.registration.custom.fields.endpointUrl')}</Label>
        <Input id="remote-node-custom-endpoint" value={form.endpointUrl} onChange={(event) => updateEndpointUrl(event.target.value)} placeholder={t('remoteFleet.registration.helpers.custom.endpointUrlPlaceholder')} />
      </div>
    </div>
  );
}

export function VmFields({ form, setForm, clearCredentialOperationIds }: FleetRegistrationFieldsProps) {
  const { t } = useTranslation();
  const update = <K extends keyof FleetRegistrationFormState>(key: K, value: FleetRegistrationFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const updateVmHost = (value: string) => {
    setForm((current) => ({
      ...current,
      vmHost: value,
      displayName: current.displayName.trim() ? current.displayName : value.trim(),
    }));
  };

  return (
    <div className="space-y-4 rounded-xl border border-border/70 p-4">
      <p className="text-sm font-medium">{t('remoteFleet.registration.vm.title')}</p>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div className="space-y-2">
          <Label htmlFor="remote-node-vm-host">{t('remoteFleet.registration.vm.fields.host')}</Label>
          <Input id="remote-node-vm-host" value={form.vmHost} onChange={(event) => updateVmHost(event.target.value)} placeholder={t('remoteFleet.registration.vm.placeholders.host')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="remote-node-vm-port">{t('remoteFleet.registration.vm.fields.port')}</Label>
          <Input id="remote-node-vm-port" inputMode="numeric" value={form.vmPort} onChange={(event) => update('vmPort', event.target.value)} placeholder={t('remoteFleet.registration.vm.placeholders.port')} />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="remote-node-vm-username">{t('remoteFleet.registration.vm.fields.username')}</Label>
          <Input id="remote-node-vm-username" value={form.vmUsername} onChange={(event) => update('vmUsername', event.target.value)} placeholder={t('remoteFleet.registration.vm.placeholders.username')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="remote-node-vm-auth">{t('remoteFleet.registration.vm.fields.loginMethod')}</Label>
          <Select
            id="remote-node-vm-auth"
            value={form.vmAuthMethod}
            onChange={(event) => {
              clearCredentialOperationIds();
              setForm((current) => ({ ...current, vmAuthMethod: event.target.value as VmAuthMethod, vmPassword: '', vmPrivateKey: '' }));
            }}
          >
            {VM_AUTH_METHOD_OPTIONS.map((method) => (
              <option key={method} value={method}>{t(`remoteFleet.registration.vm.loginMethods.${method}`)}</option>
            ))}
          </Select>
        </div>
      </div>
      {form.vmAuthMethod === 'password' ? (
        <div className="space-y-2">
          <Label htmlFor="remote-node-vm-password">{t('remoteFleet.registration.vm.credentials.password')}</Label>
          <Input id="remote-node-vm-password" type="password" value={form.vmPassword} onChange={(event) => update('vmPassword', event.target.value)} />
        </div>
      ) : null}
      {form.vmAuthMethod === 'private-key' ? (
        <div className="space-y-2">
          <Label htmlFor="remote-node-vm-private-key">{t('remoteFleet.registration.vm.credentials.privateKey')}</Label>
          <Textarea id="remote-node-vm-private-key" value={form.vmPrivateKey} onChange={(event) => update('vmPrivateKey', event.target.value)} />
        </div>
      ) : null}
      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <p className="text-xs font-medium text-foreground">{t('remoteFleet.registration.vm.cloudDiscovery.title')}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('remoteFleet.registration.vm.cloudDiscovery.description')}</p>
      </div>
    </div>
  );
}
