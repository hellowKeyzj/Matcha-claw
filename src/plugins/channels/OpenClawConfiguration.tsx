import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X, QrCode, Loader2, BookOpen, Eye, EyeOff, Check, AlertCircle, CheckCircle, ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { ChannelIcon } from './ChannelIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useChannelsStore } from './store';
import { useGatewayStore } from '@/plugins/runtime/store';
import { useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { runtimeEndpointsEqual } from '@/types/desktop/runtime-address';
import { channelErrorCode, logChannelTrace, hostChannelsActivate, hostChannelsConfigure, hostChannelsCancelAuthorization, hostChannelsCancelSession, hostChannelsLoginWait, hostChannelsReadConfig, hostChannelsStartAuthorization, hostChannelsValidateCredentials, hostChannelsWaitAuthorization } from '@/lib/channel-runtime';
import { isTraceEnabled } from '@/lib/trace-logger';
import { isGatewayOperational } from '@/lib/gateway-status';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { invokeIpc } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import type { ChannelConfigField, ChannelSetupMode } from '@/types/channel';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { ChannelConfigurationProps } from './extensions';
import { channelScopeCurrent } from './scope';

const QR_GENERATE_TIMEOUT_MS = 12_000;
const CHANNEL_CONFIG_LOADING_DELAY_MS = 180;

type ChannelAuthPrompt = Readonly<{
  qrDataUrl?: string;
  authorizationUrl?: string;
  sessionKey?: string;
}>;

type DialogSetupMode = ChannelSetupMode;

export default function OpenClawConfiguration({ scope, target, presentation, onBack, onClose, onChannelAdded }: ChannelConfigurationProps) {
  const { t } = useTranslation('channels');
  const active = useRef(true);
  const operationSequence = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; operationSequence.current += 1; }; }, []);
  const gatewayStatus = useGatewayStore((state) => state.status);
  const endpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const agents = useMemo(() => endpoints.find((entry) => runtimeEndpointsEqual(entry.endpointRef, scope.endpoint))?.agents.map((agent) => ({ id: agent.agentId, name: agent.displayName })) ?? [], [endpoints, scope]);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [channelName, setChannelName] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [loadedAgentId, setLoadedAgentId] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [authPrompt, setAuthPrompt] = useState<ChannelAuthPrompt | null>(null);
  const [qrImageFailed, setQrImageFailed] = useState(false);
  const [setupMode, setSetupMode] = useState<DialogSetupMode>('guided');
  const [validating, setValidating] = useState(false);
  const [loadedConfigKey, setLoadedConfigKey] = useState<string | null>(null);
  const [isExistingConfig, setIsExistingConfig] = useState(false);
  const qrGenerateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qrAccountIdRef = useRef<string | null>(null);
  const authSessionKeyRef = useRef<string | null>(null);
  const qrTraceIdRef = useRef<string | undefined>(undefined);
  const qrWaitAbortControllerRef = useRef<AbortController | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  } | null>(null);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

  const selectedType = target.kind === 'new' ? target.type : target.channel.type;
  const configuredChannel = target.kind === 'configured' ? target.channel : null;
  const meta = presentation.meta;
  const isConfiguredChannelEdit = target.kind === 'configured';
  const configuredAccountId = configuredChannel?.accountId?.trim() || undefined;
  const requiredFieldsFilled = meta?.configFields
    .filter((field) => field.required)
    .every((field) => configValues[field.key]?.trim()) ?? false;
  const configKey = `${selectedType}:${configuredAccountId ?? ''}`;
  const configReady = loadedConfigKey === configKey;
  const showConfigLoading = useDelayedFlag(!configReady, CHANNEL_CONFIG_LOADING_DELAY_MS);
  const isExistingTarget = target.kind === 'configured' || isExistingConfig;
  const guidedSetupFlow = presentation.login;
  const supportsGuidedSetup = Boolean(guidedSetupFlow);
  const supportsCredentialSetup = Boolean(meta?.setupFlows.some((flow) => flow.mode === 'credential'));
  const showSetupModeSwitch = !isConfiguredChannelEdit && supportsGuidedSetup && supportsCredentialSetup;
  const effectiveSetupMode: DialogSetupMode = showSetupModeSwitch ? setupMode : supportsGuidedSetup && !isConfiguredChannelEdit ? 'guided' : 'credential';
  const shouldStartAuthorization = guidedSetupFlow?.kind === 'authorization' && target.kind !== 'configured' && effectiveSetupMode === 'guided';
  const shouldStartQrLogin = guidedSetupFlow?.kind === 'qr-login' && target.kind !== 'configured' && effectiveSetupMode === 'guided';
  const shouldValidateToken = effectiveSetupMode === 'credential' && meta?.connectionType === 'token' && requiredFieldsFilled;
  const agentIdToSave = selectedAgentId && (!isConfiguredChannelEdit || selectedAgentId !== loadedAgentId)
    ? selectedAgentId
    : undefined;
  const agentOptions = useMemo(() => {
    const options = [...agents];
    for (const id of [loadedAgentId, selectedAgentId]) {
      if (id && !options.some((agent) => agent.id === id)) options.push({ id, name: id });
    }
    return options;
  }, [agents, loadedAgentId, selectedAgentId]);


  const clearQrGenerateTimeout = useCallback(() => {
    if (qrGenerateTimeoutRef.current) {
      clearTimeout(qrGenerateTimeoutRef.current);
      qrGenerateTimeoutRef.current = null;
    }
  }, []);

  const stopActiveLoginSession = useCallback(async () => {
    clearQrGenerateTimeout();
    qrWaitAbortControllerRef.current?.abort();
    qrWaitAbortControllerRef.current = null;

    const activeAccountId = qrAccountIdRef.current;
    const activeSessionKey = authSessionKeyRef.current;
    const traceId = qrTraceIdRef.current;
    qrAccountIdRef.current = null;
    authSessionKeyRef.current = null;

    if (!selectedType || (!activeAccountId && !activeSessionKey)) return;

    const startedAt = isTraceEnabled() ? Date.now() : 0;
    logChannelTrace('login.cancel.start', traceId);
    if (shouldStartAuthorization && activeSessionKey) {
      try {
        const authChannelType = guidedSetupFlow.channel;
        await hostChannelsCancelAuthorization(scope, authChannelType, activeSessionKey, { traceId });
        logChannelTrace('login.cancel.end', traceId, () => ({ outcome: 'cancelled', durationMs: Date.now() - startedAt }));
      } catch (error) {
        logChannelTrace('login.cancel.end', traceId, () => ({ outcome: 'error', errorCode: channelErrorCode(error), durationMs: Date.now() - startedAt }));
      }
      return;
    }

    if (shouldStartQrLogin && activeAccountId) {
      try {
        const qrChannelType = guidedSetupFlow.channel;
        await hostChannelsCancelSession(scope, qrChannelType, activeAccountId, { traceId });
        logChannelTrace('login.cancel.end', traceId, () => ({ outcome: 'cancelled', durationMs: Date.now() - startedAt }));
      } catch (error) {
        logChannelTrace('login.cancel.end', traceId, () => ({ outcome: 'error', errorCode: channelErrorCode(error), durationMs: Date.now() - startedAt }));
      }
    }
  }, [clearQrGenerateTimeout, selectedType, shouldStartAuthorization, shouldStartQrLogin, guidedSetupFlow, scope]);

  // Load existing config when a channel type is selected
  useEffect(() => {
    setSelectedAgentId('');
    setLoadedAgentId('');
    setShowAdvancedSettings(false);
    setSetupMode('guided');
    setChannelName(configuredAccountId ?? '');
    setConfigValues({});
    setIsExistingConfig(isConfiguredChannelEdit);
    setAuthPrompt(null);
    setQrImageFailed(false);
    setValidationResult(null);
    setLoadedConfigKey(null);

    let cancelled = false;
    const nextConfigKey = `${selectedType}:${configuredAccountId ?? ''}`;
    const traceId = isTraceEnabled() ? crypto.randomUUID() : undefined;
    const startedAt = isTraceEnabled() ? Date.now() : 0;
    logChannelTrace('config.read.start', traceId);

    (async () => {
      try {
        const result = await hostChannelsReadConfig(scope, selectedType, configuredAccountId, { traceId });

        if (cancelled || !active.current || !channelScopeCurrent(scope)) return;

        const hasValues = Object.keys(result.values).length > 0;
        logChannelTrace('config.read.end', traceId, () => ({ outcome: hasValues ? 'loaded' : 'empty', durationMs: Date.now() - startedAt }));
        setConfigValues(result.values);
        setSelectedAgentId(result.agentId ?? '');
        setLoadedAgentId(result.agentId ?? '');
        if (hasValues) setIsExistingConfig(true);
      } catch (error) {
        if (!cancelled && active.current && channelScopeCurrent(scope)) {
          logChannelTrace('config.read.end', traceId, () => ({ outcome: 'error', errorCode: channelErrorCode(error), durationMs: Date.now() - startedAt }));
        }
      } finally {
        if (!cancelled && active.current && channelScopeCurrent(scope)) setLoadedConfigKey(nextConfigKey);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedType, configuredAccountId, isConfiguredChannelEdit, clearQrGenerateTimeout, scope]);

  // Focus first input when form is ready (avoids Windows focus loss after native dialogs)
  useEffect(() => {
    if (selectedType && configReady && firstInputRef.current) {
      firstInputRef.current.focus();
    }
  }, [selectedType, configReady]);

  useEffect(() => {
    if (!selectedType || (!shouldStartQrLogin && !shouldStartAuthorization)) return undefined;
    return () => { void stopActiveLoginSession(); };
  }, [selectedType, shouldStartQrLogin, shouldStartAuthorization, stopActiveLoginSession]);

  const handleValidate = async () => {
    if (!selectedType) return;
    const request = ++operationSequence.current;
    const current = () => active.current && request === operationSequence.current && channelScopeCurrent(scope);

    setValidating(true);
    setValidationResult(null);

    try {
      const result = await hostChannelsValidateCredentials(scope, selectedType, configValues);
      if (!current()) return;

      const warnings = result.warnings || [];
      if (result.valid && result.details) {
        const details = result.details;
        if (details.botUsername) warnings.push(`Bot: @${details.botUsername}`);
        if (details.guildName) warnings.push(`Server: ${details.guildName}`);
        if (details.channelName) warnings.push(`Channel: #${details.channelName}`);
      }

      setValidationResult({
        valid: result.valid || false,
        errors: result.errors || [],
        warnings,
      });
    } catch (error) {
      if (!current()) return;
      setValidationResult({
        valid: false,
        errors: [String(error)],
        warnings: [],
      });
    } finally {
      if (current()) setValidating(false);
    }
  };


  const handleConnect = async () => {
    if (!selectedType || !meta) return;
    const request = ++operationSequence.current;
    const current = () => active.current && request === operationSequence.current && channelScopeCurrent(scope);

    const traceId = isTraceEnabled() ? crypto.randomUUID() : undefined;
    const startedAt = isTraceEnabled() ? Date.now() : 0;
    let outcome = 'unconfirmed';
    const confirmMutation = () => {
      outcome = 'confirmed';
      void useChannelsStore.getState().refreshAfterConfirmedMutation(scope);
    };
    let activePhase: 'login.start' | 'validation' | 'config' | null = null;
    let phaseStartedAt = startedAt;
    logChannelTrace('create.click', traceId);
    const accountId = (configuredAccountId ?? channelName.trim()) || 'default';
    logChannelTrace('create.submit.start', traceId, () => ({ accountPresent: Boolean(accountId), gatewayOperational: isGatewayOperational(gatewayStatus) }));
    setConnecting(true);
    setValidationResult(null);
    if (shouldStartQrLogin || shouldStartAuthorization) {
      await stopActiveLoginSession();
      if (!current()) return;
    }
    const explicitAgentId = agentIdToSave;

    try {
      // For QR-based channels, request QR code
      if (shouldStartQrLogin) {
        clearQrGenerateTimeout();
        qrGenerateTimeoutRef.current = setTimeout(() => {
          if (!current()) return;
          logChannelTrace('login.qr.timeout', traceId, () => ({ errorCode: 'TIMEOUT', durationMs: Date.now() - startedAt }));
          setConnecting(false);
          toast.error(t('toast.qrGenerateTimeout'));
        }, QR_GENERATE_TIMEOUT_MS);
        const qrChannelType = guidedSetupFlow.channel;
        qrAccountIdRef.current = accountId;
        qrTraceIdRef.current = traceId;
        const loginStartedAt = isTraceEnabled() ? Date.now() : 0;
        activePhase = 'login.start';
        phaseStartedAt = loginStartedAt;
        logChannelTrace('login.start.start', traceId);
        const startResult = await hostChannelsActivate(scope, { channelType: qrChannelType, accountId, agentId: explicitAgentId, config: configValues }, { traceId });
        if (!current()) { await hostChannelsCancelSession(scope, qrChannelType, accountId, { traceId }).catch(() => undefined); return; }
        logChannelTrace('login.start.end', traceId, () => ({ outcome: startResult.success ? 'accepted' : 'unconfirmed', durationMs: Date.now() - loginStartedAt }));
        activePhase = null;
        const progress = startResult.progress;
        if (!progress || (progress.outcome !== 'progress' && progress.outcome !== 'connected')) {
          throw new Error(startResult.error || 'Channel activation outcome is unknown');
        }
        if (progress.qrDataUrl) {
          setQrImageFailed(false);
          setAuthPrompt((current) => ({ ...current, qrDataUrl: progress.qrDataUrl, sessionKey: progress.sessionKey }));
          clearQrGenerateTimeout();
        }
        if (progress.outcome === 'connected') {
          clearQrGenerateTimeout();
          qrAccountIdRef.current = null;
          setConnecting(false);
          confirmMutation();
          logChannelTrace('login.confirmed', traceId);
          onChannelAdded();
          return;
        }
        const waitController = new AbortController();
        qrWaitAbortControllerRef.current = waitController;
        let currentQrDataUrl = progress.qrDataUrl;
        let sessionKey = progress.sessionKey;
        while (!waitController.signal.aborted) {
          let waitResult: Awaited<ReturnType<typeof hostChannelsLoginWait>>;
          const waitStartedAt = isTraceEnabled() ? Date.now() : 0;
          logChannelTrace('login.wait.start', traceId);
          try {
            waitResult = await hostChannelsLoginWait(scope, qrChannelType, accountId, {
              traceId,
              timeoutMs: 300_000,
              sessionKey,
              currentQrDataUrl,
              signal: waitController.signal,
            });
            logChannelTrace('login.wait.end', traceId, () => ({ outcome: ['progress', 'connected', 'target_rejected'].includes(waitResult.outcome) ? waitResult.outcome : 'unknown', durationMs: Date.now() - waitStartedAt }));
          } catch (error) {
            logChannelTrace('login.wait.end', traceId, () => ({ outcome: 'error', errorCode: channelErrorCode(error), durationMs: Date.now() - waitStartedAt }));
            if (!current() || waitController.signal.aborted) { outcome = 'cancelled'; return; }
            throw error;
          }
          if (!current() || waitController.signal.aborted) { outcome = 'cancelled'; return; }
          if (waitResult.sessionKey) {
            sessionKey = waitResult.sessionKey;
          }
          if (waitResult.qrDataUrl) {
            clearQrGenerateTimeout();
            currentQrDataUrl = waitResult.qrDataUrl;
            setQrImageFailed(false);
            setAuthPrompt((current) => ({ ...current, qrDataUrl: waitResult.qrDataUrl, sessionKey }));
          }
          if (waitResult.outcome === 'connected') {
            clearQrGenerateTimeout();
            qrAccountIdRef.current = null;
            qrWaitAbortControllerRef.current = null;
            setConnecting(false);
            confirmMutation();
            logChannelTrace('login.confirmed', traceId);
            onChannelAdded();
            return;
          }
          if (waitResult.outcome !== 'progress') {
            throw new Error(waitResult.outcome === 'target_rejected'
              ? 'Channel activation was rejected'
              : 'Channel activation outcome is unknown');
          }
        }
        return;
      }

      if (shouldStartAuthorization) {
        clearQrGenerateTimeout();
        const authorizationChannelType = guidedSetupFlow.channel;
        const waitController = new AbortController();
        qrWaitAbortControllerRef.current = waitController;
        qrAccountIdRef.current = accountId;
        qrTraceIdRef.current = traceId;
        const loginStartedAt = isTraceEnabled() ? Date.now() : 0;
        activePhase = 'login.start';
        phaseStartedAt = loginStartedAt;
        logChannelTrace('login.start.start', traceId);
        const startResult = await hostChannelsStartAuthorization(scope, {
          channelType: authorizationChannelType,
          accountId,
          ...(explicitAgentId ? { agentId: explicitAgentId } : {}),
          config: configValues,
        }, { traceId });
        if (!current()) { if (startResult.sessionKey) await hostChannelsCancelAuthorization(scope, authorizationChannelType, startResult.sessionKey, { traceId }).catch(() => undefined); return; }
        logChannelTrace('login.start.end', traceId, () => ({ outcome: startResult.outcome, durationMs: Date.now() - loginStartedAt }));
        activePhase = null;
        if (startResult.sessionKey) authSessionKeyRef.current = startResult.sessionKey;
        if (startResult.qrDataUrl || startResult.authorizationUrl || startResult.sessionKey) {
          setQrImageFailed(false);
          setAuthPrompt({
            qrDataUrl: startResult.qrDataUrl,
            authorizationUrl: startResult.authorizationUrl,
            sessionKey: startResult.sessionKey,
          });
        }
        if (startResult.outcome === 'connected') {
          qrAccountIdRef.current = null;
          authSessionKeyRef.current = null;
          qrWaitAbortControllerRef.current = null;
          setConnecting(false);
          confirmMutation();
          logChannelTrace('login.confirmed', traceId);
          onChannelAdded();
          return;
        }
        if (startResult.outcome !== 'progress' || !startResult.sessionKey) {
          throw new Error(startResult.outcome === 'target_rejected'
            ? 'Channel authorization was rejected'
            : 'Channel authorization outcome is unknown');
        }
        let sessionKey = startResult.sessionKey;
        while (!waitController.signal.aborted) {
          let waitResult: Awaited<ReturnType<typeof hostChannelsWaitAuthorization>>;
          const waitStartedAt = isTraceEnabled() ? Date.now() : 0;
          logChannelTrace('login.wait.start', traceId);
          try {
            waitResult = await hostChannelsWaitAuthorization(scope, authorizationChannelType, sessionKey, {
              traceId,
              timeoutMs: 300_000,
              signal: waitController.signal,
            });
            logChannelTrace('login.wait.end', traceId, () => ({ outcome: ['progress', 'connected', 'target_rejected'].includes(waitResult.outcome) ? waitResult.outcome : 'unknown', durationMs: Date.now() - waitStartedAt }));
          } catch (error) {
            logChannelTrace('login.wait.end', traceId, () => ({ outcome: 'error', errorCode: channelErrorCode(error), durationMs: Date.now() - waitStartedAt }));
            if (!current() || waitController.signal.aborted) { outcome = 'cancelled'; return; }
            throw error;
          }
          if (!current() || waitController.signal.aborted) { outcome = 'cancelled'; return; }
          if (waitResult.sessionKey) {
            sessionKey = waitResult.sessionKey;
            authSessionKeyRef.current = waitResult.sessionKey;
          }
          if (waitResult.qrDataUrl || waitResult.authorizationUrl) {
            setQrImageFailed(false);
            setAuthPrompt((current) => ({
              ...current,
              qrDataUrl: waitResult.qrDataUrl ?? current?.qrDataUrl,
              authorizationUrl: waitResult.authorizationUrl ?? current?.authorizationUrl,
              sessionKey,
            }));
          }
          if (waitResult.outcome === 'connected') {
            qrAccountIdRef.current = null;
            authSessionKeyRef.current = null;
            qrWaitAbortControllerRef.current = null;
            setConnecting(false);
            confirmMutation();
            logChannelTrace('login.confirmed', traceId);
            onChannelAdded();
            return;
          }
          if (waitResult.outcome === 'cancelled') {
            outcome = 'cancelled';
            return;
          }
          if (waitResult.outcome !== 'progress') {
            throw new Error(waitResult.outcome === 'target_rejected'
              ? 'Channel authorization was rejected'
              : 'Channel authorization outcome is unknown');
          }
        }
        return;
      }

      // Step 1: Validate credentials against the actual service API
      if (shouldValidateToken) {
        const validationStartedAt = isTraceEnabled() ? Date.now() : 0;
        activePhase = 'validation';
        phaseStartedAt = validationStartedAt;
        logChannelTrace('validation.start', traceId);
        const validationResponse = await hostChannelsValidateCredentials(scope, selectedType, configValues, { traceId });
        if (!current()) return;
        logChannelTrace('validation.end', traceId, () => ({ outcome: validationResponse.valid ? 'valid' : 'invalid', durationMs: Date.now() - validationStartedAt }));

        activePhase = null;
        if (!validationResponse.valid) {
          outcome = 'validation_rejected';
          setValidationResult({
            valid: false,
            errors: validationResponse.errors || ['Validation failed'],
            warnings: validationResponse.warnings || [],
          });
          setConnecting(false);
          return;
        }

        // Show success details (bot name, guild name, etc.) as warnings/info
        const warnings = validationResponse.warnings || [];
        if (validationResponse.details) {
          const details = validationResponse.details;
          if (details.botUsername) {
            warnings.push(`Bot: @${details.botUsername}`);
          }
          if (details.guildName) {
            warnings.push(`Server: ${details.guildName}`);
          }
          if (details.channelName) {
            warnings.push(`Channel: #${details.channelName}`);
          }
        }

        // Show validation success with details
        setValidationResult({
          valid: true,
          errors: [],
          warnings,
        });
      }

      // Step 2: Activate channel configuration
      const config: Record<string, unknown> = { ...configValues };
      const configStartedAt = isTraceEnabled() ? Date.now() : 0;
      activePhase = 'config';
      phaseStartedAt = configStartedAt;
      logChannelTrace('config.start', traceId);
      const saveResult = await hostChannelsConfigure(scope, { channelType: selectedType, accountId, agentId: explicitAgentId, config }, { traceId });
      if (!current()) return;
      logChannelTrace('config.end', traceId, () => ({ outcome: saveResult.success ? 'confirmed' : 'unconfirmed', durationMs: Date.now() - configStartedAt }));
      activePhase = null;
      if (!saveResult?.success) {
        throw new Error(saveResult?.error || 'Failed to save channel config');
      }
      if (typeof saveResult.warning === 'string' && saveResult.warning) {
        toast.warning(saveResult.warning);
      }

      confirmMutation();
      toast.success(t('toast.channelSaved', { name: meta.name }));

      // Brief delay so user can see the success state before dialog closes
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (current()) onChannelAdded();
    } catch (error) {
      if (!current()) return;
      clearQrGenerateTimeout();
      outcome = 'error';
      if (activePhase) logChannelTrace(`${activePhase}.end`, traceId, () => ({ outcome, errorCode: channelErrorCode(error), durationMs: Date.now() - phaseStartedAt }));
      logChannelTrace('create.error', traceId, () => ({ errorCode: channelErrorCode(error) }));
      toast.error(t('toast.configFailed', { error: channelErrorCode(error) }));
      setConnecting(false);
    } finally {
      logChannelTrace('create.submit.end', traceId, () => ({ outcome, durationMs: Date.now() - startedAt }));
      logChannelTrace('create.final', traceId, () => ({ outcome, durationMs: Date.now() - startedAt }));
    }
  };

  const handleRefreshCode = () => {
    setQrImageFailed(false);
    void handleConnect();
  };

  const openDocs = () => {
    if (meta?.docsPath) {
      void invokeIpc('shell:openResourcePath', meta.docsPath).catch((error) => {
        console.error(`[startup-trace] ${JSON.stringify({ source: 'channel-renderer', phase: 'docs.error', errorCode: channelErrorCode(error) })}`);
        toast.error(t('toast.openDocsFailed', { error }));
      });
    }
  };


  const isFormValid = () => {
    if (!meta) return false;
    if (isConfiguredChannelEdit && agentIdToSave) return true;
    if (isConfiguredChannelEdit && Object.keys(configValues).length === 0) return false;
    if (shouldStartAuthorization) return true;

    // Check all required fields are filled
    return meta.configFields
      .filter((field) => field.required)
      .every((field) => configValues[field.key]?.trim());
  };

  const updateConfigValue = (key: string, value: string) => {
    setConfigValues((prev) => ({ ...prev, [key]: value }));
  };

  const toggleSecretVisibility = (key: string) => {
    setShowSecrets((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const regularFields = shouldStartAuthorization ? [] : meta.configFields.filter((field) => !presentation.advancedFieldKeys?.includes(field.key));
  const advancedFields = meta.configFields.filter((field) => presentation.advancedFieldKeys?.includes(field.key));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[hsl(var(--shell-scrim))] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <Card
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-[1.35rem] bg-[hsl(var(--shell-surface))] shadow-[var(--shell-shadow-overlay)] [border-color:hsl(var(--shell-border))]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between gap-4 border-b p-5 [border-color:hsl(var(--shell-border))]">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[0.95rem] border bg-[hsl(var(--shell-surface-muted))] [border-color:hsl(var(--shell-border))]">
              <ChannelIcon id={meta.iconId} className="h-7 w-7" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-lg">
                {selectedType
                  ? isExistingTarget
                    ? t('dialog.updateTitle', { name: meta.name })
                    : t('dialog.configureTitle', { name: meta.name })
                  : t('dialog.addTitle')}
              </CardTitle>
              <CardDescription className="mt-1 line-clamp-2 leading-5">
                {selectedType && isExistingTarget
                  ? t('dialog.existingDesc')
                  : meta ? t(meta.description) : t('dialog.selectDesc')}
              </CardDescription>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="-mr-2 -mt-2 shrink-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4 p-5">
          {authPrompt ? (
            // QR/link authorization display
            <div className="rounded-[1.15rem] border bg-[hsl(var(--shell-surface-muted))] p-5 text-center [border-color:hsl(var(--shell-border))]">
              <p className="text-sm font-medium text-foreground">
                {authPrompt.qrDataUrl ? t('dialog.scanQR', { name: meta?.name }) : t('dialog.openAuthorization', { name: meta?.name })}
              </p>
              {authPrompt.qrDataUrl ? (
                <div className="mt-4 flex justify-center">
                  <div className="rounded-[1rem] border bg-white p-3 shadow-sm">
                    {!qrImageFailed ? (
                      <img
                        src={authPrompt.qrDataUrl}
                        alt={t('dialog.qrImageAlt', { name: meta?.name || 'QR Code' })}
                        className="h-56 w-56 object-contain"
                        onError={() => setQrImageFailed(true)}
                      />
                    ) : (
                      <div className="flex h-56 w-56 items-center justify-center bg-gray-100">
                        <QrCode className="h-28 w-28 text-gray-400" />
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
              <p className="mt-4 text-xs text-muted-foreground">{t('dialog.waitingForScan')}</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {authPrompt.authorizationUrl ? (
                  <Button
                    variant="outline"
                    onClick={() => invokeIpc('shell:openExternal', authPrompt.authorizationUrl)}
                  >
                    {t('dialog.openAuthorizationLink')}
                  </Button>
                ) : null}
                <Button variant="outline" onClick={handleRefreshCode}>
                  {t('dialog.refreshCode')}
                </Button>
              </div>
            </div>
          ) : !configReady ? (
            // Loading saved config
            <div className="flex min-h-24 items-center justify-center py-8">
              {showConfigLoading ? (
                <>
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">{t('dialog.loadingConfig')}</span>
                </>
              ) : null}
            </div>
          ) : (
            // Connection form
            <div className="space-y-4">
              {showSetupModeSwitch && (
                <div className="grid grid-cols-2 gap-2 rounded-[0.95rem] border bg-[hsl(var(--shell-surface-muted))] p-1 [border-color:hsl(var(--shell-border))]">
                  <button
                    type="button"
                    className={cn(
                      'rounded-[0.75rem] px-3 py-2 text-sm font-medium transition-colors',
                      effectiveSetupMode === 'guided' ? 'bg-[hsl(var(--shell-surface))]' : 'text-[hsl(var(--shell-text-muted))] hover:text-foreground',
                    )}
                    onClick={() => setSetupMode('guided')}
                    disabled={connecting}
                  >
                    {t('dialog.setupModeGuided')}
                  </button>
                  <button
                    type="button"
                    className={cn(
                      'rounded-[0.75rem] px-3 py-2 text-sm font-medium transition-colors',
                      effectiveSetupMode === 'credential' ? 'bg-[hsl(var(--shell-surface))]' : 'text-[hsl(var(--shell-text-muted))] hover:text-foreground',
                    )}
                    onClick={() => setSetupMode('credential')}
                    disabled={connecting}
                  >
                    {t('dialog.setupModeCredential')}
                  </button>
                </div>
              )}

              {/* Existing config hint */}
              {isExistingConfig && (
                <div className="bg-blue-500/10 text-blue-600 dark:text-blue-400 p-3 rounded-lg text-sm flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 shrink-0" />
                  <span>{t('dialog.existingHint')}</span>
                </div>
              )}

              {/* Instructions */}
              <div className="bg-muted p-4 rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-sm">{t('dialog.howToConnect')}</p>
                  <Button
                    variant="link"
                    className="p-0 h-auto text-sm"
                    onClick={openDocs}
                    disabled={!meta?.docsPath}
                  >
                    <BookOpen className="h-3 w-3 mr-1" />
                    {t('dialog.viewDocs')}
                  </Button>
                </div>
                <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1">
                  {meta?.instructions.map((instruction, i) => (
                    <li key={i}>{t(instruction)}</li>
                  ))}
                </ol>
              </div>

              {/* Channel name */}
              <div className="space-y-2">
                <Label htmlFor="name">{t('dialog.channelName')}</Label>
                <Input
                  ref={firstInputRef}
                  id="name"
                  placeholder={t('dialog.channelNamePlaceholder', { name: meta?.name })}
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
                  disabled={isConfiguredChannelEdit}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="channel-agent">{t('dialog.agent')}</Label>
                <SelectPrimitive.Root
                  value={selectedAgentId ? `agent:${selectedAgentId}` : 'keep'}
                  onValueChange={(value) => setSelectedAgentId(value === 'keep' ? '' : value.slice('agent:'.length))}
                  disabled={connecting}
                >
                  <SelectPrimitive.Trigger
                    id="channel-agent"
                    className="flex h-11 w-full items-center justify-between gap-2 rounded-[var(--radius-interactive)] border border-input bg-card px-4 py-2 text-[15px] text-foreground ring-offset-background transition-[border-color,box-shadow,background-color,color] duration-150 hover:border-border focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/15 focus-visible:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="min-w-0 truncate"><SelectPrimitive.Value /></span>
                    <SelectPrimitive.Icon asChild>
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </SelectPrimitive.Icon>
                  </SelectPrimitive.Trigger>
                  <SelectPrimitive.Portal>
                    <SelectPrimitive.Content
                      position="popper"
                      sideOffset={4}
                      collisionPadding={12}
                      aria-label={t('dialog.agent')}
                      className="z-50 w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-24px)] max-h-[min(20rem,var(--radix-select-content-available-height))] overflow-hidden rounded-[var(--radius-interactive)] border border-border bg-popover text-popover-foreground shadow-lg"
                    >
                      <SelectPrimitive.Viewport className="select-scroll-viewport max-h-[inherit] overflow-y-auto overscroll-contain p-1">
                        {[{ id: '', name: t('dialog.agentDefault') }, ...agentOptions].map((agent) => (
                          <SelectPrimitive.Item
                            key={agent.id}
                            value={agent.id ? `agent:${agent.id}` : 'keep'}
                            className="relative flex cursor-default select-none items-center rounded-md py-2 pl-3 pr-8 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                          >
                            <SelectPrimitive.ItemText>
                              {agent.id && agent.name && agent.name !== agent.id ? `${agent.name} (${agent.id})` : agent.name || agent.id}
                            </SelectPrimitive.ItemText>
                            <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center">
                              <Check className="h-4 w-4" />
                            </SelectPrimitive.ItemIndicator>
                          </SelectPrimitive.Item>
                        ))}
                      </SelectPrimitive.Viewport>
                    </SelectPrimitive.Content>
                  </SelectPrimitive.Portal>
                </SelectPrimitive.Root>
              </div>

              {/* Configuration fields */}
              {regularFields.map((field) => (
                <ConfigField
                  key={field.key}
                  field={field}
                  value={configValues[field.key] || ''}
                  onChange={(value) => updateConfigValue(field.key, value)}
                  showSecret={showSecrets[field.key] || false}
                  onToggleSecret={() => toggleSecretVisibility(field.key)}
                />
              ))}

              {/* Weixin optional advanced settings */}
              {advancedFields.length > 0 && (
                <div className="rounded-lg border border-border/80 bg-muted/20 p-3 space-y-3">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between text-sm font-medium"
                    onClick={() => setShowAdvancedSettings((prev) => !prev)}
                  >
                    <span>{t('dialog.advancedSettings')}</span>
                    {showAdvancedSettings ? (
                      <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>
                  {showAdvancedSettings && (
                    <div className="space-y-4">
                      {advancedFields.map((field) => (
                        <ConfigField
                          key={field.key}
                          field={field}
                          value={configValues[field.key] || ''}
                          onChange={(value) => updateConfigValue(field.key, value)}
                          showSecret={showSecrets[field.key] || false}
                          onToggleSecret={() => toggleSecretVisibility(field.key)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Validation Results */}
              {validationResult && (
                <div className={`p-4 rounded-lg text-sm ${validationResult.valid ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-destructive/10 text-destructive'
                  }`}>
                  <div className="flex items-start gap-2">
                    {validationResult.valid ? (
                      <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    ) : (
                      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <h4 className="font-medium mb-1">
                        {validationResult.valid ? t('dialog.credentialsVerified') : t('dialog.validationFailed')}
                      </h4>
                      {validationResult.errors.length > 0 && (
                        <ul className="list-disc list-inside space-y-0.5">
                          {validationResult.errors.map((err, i) => (
                            <li key={i}>{err}</li>
                          ))}
                        </ul>
                      )}
                      {validationResult.valid && validationResult.warnings.length > 0 && (
                        <div className="mt-1 text-green-600 dark:text-green-400 space-y-0.5">
                          {validationResult.warnings.map((info, i) => (
                            <p key={i} className="text-xs">{info}</p>
                          ))}
                        </div>
                      )}
                      {!validationResult.valid && validationResult.warnings.length > 0 && (
                        <div className="mt-2 text-yellow-600 dark:text-yellow-500">
                          <p className="font-medium text-xs uppercase mb-1">{t('dialog.warnings')}</p>
                          <ul className="list-disc list-inside space-y-0.5">
                            {validationResult.warnings.map((warn, i) => (
                              <li key={i}>{warn}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <Separator />

              <div className="flex justify-between">
                <Button variant="outline" onClick={isConfiguredChannelEdit ? onClose : onBack}>
                  {t('dialog.back')}
                </Button>
                <div className="flex gap-2">
                  {/* Validation Button - Only for token-based channels for now */}
                  {meta?.connectionType === 'token' && (
                    <Button
                      variant="secondary"
                      onClick={handleValidate}
                      disabled={validating}
                    >
                      {validating ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          {t('dialog.validating')}
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="h-4 w-4 mr-2" />
                          {t('dialog.validateConfig')}
                        </>
                      )}
                    </Button>
                  )}
                  <Button
                    onClick={handleConnect}
                    disabled={connecting || !isFormValid()}
                  >
                    {connecting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {shouldStartAuthorization ? t('dialog.startingAuthorization') : shouldStartQrLogin ? t('dialog.generatingQR') : t('dialog.validatingAndSaving')}
                      </>
                    ) : shouldStartAuthorization ? (
                      t('dialog.startAuthorization')
                    ) : shouldStartQrLogin ? (
                      t('dialog.generateQRCode')
                    ) : (
                      <>
                        <Check className="h-4 w-4 mr-2" />
                        {isExistingConfig ? t('dialog.updateAndReconnect') : t('dialog.saveAndConnect')}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div >
  );
}

// ==================== Config Field Component ====================

interface ConfigFieldProps {
  field: ChannelConfigField;
  value: string;
  onChange: (value: string) => void;
  showSecret: boolean;
  onToggleSecret: () => void;
}

function ConfigField({ field, value, onChange, showSecret, onToggleSecret }: ConfigFieldProps) {
  const { t } = useTranslation('channels');
  const isPassword = field.type === 'password';

  return (
    <div className="space-y-2">
      <Label htmlFor={field.key}>
        {t(field.label)}
        {field.required && <span className="text-destructive ml-1">*</span>}
      </Label>
      <div className="flex gap-2">
        <Input
          id={field.key}
          type={isPassword && !showSecret ? 'password' : 'text'}
          placeholder={field.placeholder ? t(field.placeholder) : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-sm"
        />
        {isPassword && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onToggleSecret}
          >
            {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        )}
      </div>
      {field.description && (
        <p className="text-xs text-muted-foreground">
          {t(field.description)}
        </p>
      )}
      {field.envVar && (
        <p className="text-xs text-muted-foreground">
          {t('dialog.envVar', { var: field.envVar })}
        </p>
      )}
    </div>
  );
}
