import { lazy } from 'react';
import type { FleetRegistrationTarget } from '../extensions';
import {
  isDockerLoopbackHttps2375Endpoint,
  parseContainerImageCandidates,
  parseOptionalContainerImage,
  parseOptionalK8sApiServerUrl,
  parseOptionalPort,
  sshEndpointUrl,
  sshFormValuesFromEndpoint,
  undefinedIfEmpty,
  withoutUndefined,
} from './form';

export const sshRegistrationTarget: FleetRegistrationTarget = {
  kind: 'ssh-host',
  publicConfigPlaceholderKey: 'remoteFleet.registration.helpers.sshHost.publicConfigPlaceholder',
  secretRefsPlaceholderKey: 'remoteFleet.registration.helpers.sshHost.secretRefsPlaceholder',
  fields: lazy(() => import('./fields').then((module) => ({ default: module.SshFields }))),
  fromConnection: (connection) => sshFormValuesFromEndpoint(connection.endpointUrl),
  connection: (form) => {
    const sshPort = parseOptionalPort(form.sshPort);
    return {
      endpointUrl: sshEndpointUrl(form.sshHost, sshPort),
      displayNameSeed: form.sshHost,
      publicConfig: { ssh: undefinedIfEmpty(withoutUndefined({
        host: form.sshHost.trim() || undefined,
        port: sshPort,
        username: form.sshUsername.trim() || undefined,
      })) },
    };
  },
  environment: (form) => ({
    environmentKind: 'ssh-workdir',
    displayNameSeed: form.sshHost,
    publicConfig: {},
  }),
  credentialDrafts: (form) => {
    if (form.sshAuthMethod === 'password' && form.sshPassword.trim()) {
      return [{ credentialName: 'sshPassword', plaintextValue: form.sshPassword }];
    }
    if (form.sshAuthMethod === 'private-key' && form.sshPrivateKey.trim()) {
      return [{ credentialName: 'sshPrivateKey', plaintextValue: form.sshPrivateKey }];
    }
    return [];
  },
  submitSeed: (form) => form.sshHost,
  confirmDeployment: true,
};

export const containerRegistrationTarget: FleetRegistrationTarget = {
  kind: 'container',
  publicConfigPlaceholderKey: 'remoteFleet.registration.helpers.container.publicConfigPlaceholder',
  secretRefsPlaceholderKey: 'remoteFleet.registration.helpers.container.secretRefsPlaceholder',
  fields: lazy(() => import('./fields').then((module) => ({ default: module.ContainerFields }))),
  fromConnection: () => ({}),
  connection: (form) => {
    const endpointUrl = form.endpointUrl.trim() || undefined;
    if (isDockerLoopbackHttps2375Endpoint(endpointUrl ?? '')) {
      throw new Error('remoteFleet.registration.errors.dockerLoopbackHttps2375');
    }
    return {
      endpointUrl,
      displayNameSeed: form.endpointUrl,
      publicConfig: { docker: undefinedIfEmpty(withoutUndefined({
        endpointUrl,
        connectionSource: 'endpoint',
        authMethod: form.containerAuthMethod,
      })) },
    };
  },
  environment: (form) => ({
    environmentKind: 'docker-container',
    displayNameSeed: form.containerName || form.endpointUrl,
    publicConfig: { docker: undefinedIfEmpty(withoutUndefined({
      containerName: form.containerName.trim() || undefined,
      image: parseOptionalContainerImage(form.containerImage),
      imageCandidates: parseContainerImageCandidates(form.containerImageCandidates),
    })) },
  }),
  credentialDrafts: (form) => {
    if (form.containerAuthMethod === 'bearer-token' && form.containerBearerToken.trim()) {
      return [{ credentialName: 'dockerBearerToken', plaintextValue: form.containerBearerToken }];
    }
    return [];
  },
  submitSeed: (form) => form.endpointUrl,
  confirmDeployment: true,
};

export const k8sRegistrationTarget: FleetRegistrationTarget = {
  kind: 'k8s-pod',
  publicConfigPlaceholderKey: 'remoteFleet.registration.helpers.k8sPod.publicConfigPlaceholder',
  secretRefsPlaceholderKey: 'remoteFleet.registration.helpers.k8sPod.secretRefsPlaceholder',
  fields: lazy(() => import('./fields').then((module) => ({ default: module.K8sFields }))),
  fromConnection: (connection) => ({ k8sApiServerUrl: connection.endpointUrl ?? '' }),
  connection: (form) => {
    const endpointUrl = parseOptionalK8sApiServerUrl(form.k8sApiServerUrl);
    return {
      endpointUrl,
      displayNameSeed: form.k8sApiServerUrl,
      publicConfig: { k8s: undefinedIfEmpty(withoutUndefined({ apiServerUrl: endpointUrl })) },
    };
  },
  environment: (form) => ({
    environmentKind: 'k8s-workload',
    displayNameSeed: form.k8sApiServerUrl,
    publicConfig: { k8s: undefinedIfEmpty(withoutUndefined({ namespace: form.k8sNamespace.trim() || undefined })) },
  }),
  credentialDrafts: (form) => {
    if (form.k8sBearerToken.trim()) {
      return [{ credentialName: 'kubeBearerToken', plaintextValue: form.k8sBearerToken }];
    }
    return [];
  },
  submitSeed: (form) => form.k8sApiServerUrl,
  confirmDeployment: true,
};

export const customRegistrationTarget: FleetRegistrationTarget = {
  kind: 'custom',
  publicConfigPlaceholderKey: 'remoteFleet.registration.helpers.custom.publicConfigPlaceholder',
  secretRefsPlaceholderKey: 'remoteFleet.registration.helpers.custom.secretRefsPlaceholder',
  fields: lazy(() => import('./fields').then((module) => ({ default: module.CustomFields }))),
  fromConnection: () => ({}),
  connection: (form) => ({
    endpointUrl: form.endpointUrl.trim() || undefined,
    displayNameSeed: form.endpointUrl,
    publicConfig: {},
  }),
  environment: (form) => ({
    environmentKind: 'custom',
    displayNameSeed: form.endpointUrl,
    publicConfig: {},
  }),
  credentialDrafts: () => [],
  submitSeed: (form) => form.endpointUrl,
  confirmDeployment: false,
};

export const vmRegistrationTarget: FleetRegistrationTarget = {
  kind: 'vm',
  publicConfigPlaceholderKey: 'remoteFleet.registration.helpers.vm.publicConfigPlaceholder',
  secretRefsPlaceholderKey: 'remoteFleet.registration.helpers.vm.secretRefsPlaceholder',
  fields: lazy(() => import('./fields').then((module) => ({ default: module.VmFields }))),
  fromConnection: (connection) => {
    const sshValues = sshFormValuesFromEndpoint(connection.endpointUrl);
    return {
      vmHost: sshValues.sshHost,
      vmPort: sshValues.sshPort,
      vmUsername: sshValues.sshUsername,
    };
  },
  connection: (form) => {
    const sshPort = parseOptionalPort(form.vmPort);
    return {
      endpointUrl: sshEndpointUrl(form.vmHost, sshPort),
      displayNameSeed: form.vmHost,
      publicConfig: { vm: undefinedIfEmpty(withoutUndefined({
        host: form.vmHost.trim() || undefined,
        port: sshPort,
        username: form.vmUsername.trim() || undefined,
        loginMethod: form.vmAuthMethod,
      })) },
    };
  },
  environment: (form) => ({
    environmentKind: 'vm-workdir',
    displayNameSeed: form.vmHost,
    publicConfig: {},
  }),
  credentialDrafts: (form) => {
    if (form.vmAuthMethod === 'password' && form.vmPassword.trim()) {
      return [{ credentialName: 'sshPassword', plaintextValue: form.vmPassword }];
    }
    if (form.vmAuthMethod === 'private-key' && form.vmPrivateKey.trim()) {
      return [{ credentialName: 'sshPrivateKey', plaintextValue: form.vmPrivateKey }];
    }
    return [];
  },
  submitSeed: (form) => form.vmHost,
  confirmDeployment: true,
};
