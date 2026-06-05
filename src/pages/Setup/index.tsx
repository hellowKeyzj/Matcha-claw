/**
 * Setup Wizard Page
 * First-time setup experience for new users
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ExternalLink,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import matchaClawIcon from '@/assets/logo.svg';
import { TitleBar } from '@/components/layout/TitleBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { invokeIpc } from '@/lib/api-client';
import { isGatewayOperational, isGatewayRecovering, isGatewayUnavailable } from '@/lib/gateway-status';
import { hostApiFetch, hostOpenClawGetStatus, hostUvInstallAll, resolveSingleCapabilityRuntimeAddress, waitForRuntimeJobResult } from '@/lib/host-api';
import { hostLicenseValidate } from '@/lib/license-runtime';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/stores/gateway';
import { useSettingsStore } from '@/stores/settings';
import type { RuntimeAddress } from '../../../runtime-host/shared/runtime-address';

const SETTINGS_RUNTIME_CAPABILITY_ID = 'settings.runtime';
const LICENSE_RUNTIME_CAPABILITY_ID = 'license.runtime';
const PLATFORM_RUNTIME_CAPABILITY_ID = 'platform.runtime';

interface SetupStep {
  id: string;
  title: string;
  description: string;
}

type LicenseValidationCode =
  | 'valid'
  | 'empty'
  | 'format_invalid'
  | 'service_unconfigured'
  | 'network_error'
  | 'server_rejected'
  | 'cache_grace_valid'
  | 'expired'
  | 'device_mismatch'
  | 'not_allowed'
  | 'checksum_invalid';

interface LicenseValidationResponse {
  valid: boolean;
  code: LicenseValidationCode;
  normalizedKey?: string;
  message?: string;
}

interface LicenseGateSnapshot {
  state: 'checking' | 'granted' | 'blocked';
  lastValidation?: LicenseValidationResponse | null;
}

const STEP = {
  WELCOME: 0,
  RUNTIME: 1,
  INSTALLING: 2,
  COMPLETE: 3,
} as const;

const steps: SetupStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to MatchaClaw',
    description: 'Your AI assistant is ready to be configured',
  },
  {
    id: 'runtime',
    title: 'Environment Check',
    description: 'Verifying system requirements',
  },
  {
    id: 'installing',
    title: 'Setting Up',
    description: 'Installing essential components',
  },
  {
    id: 'complete',
    title: 'All Set!',
    description: 'MatchaClaw is ready to use',
  },
];

interface DefaultSkill {
  id: string;
  name: string;
  description: string;
}

const defaultSkills: DefaultSkill[] = [
  { id: 'opencode', name: 'OpenCode', description: 'AI coding assistant backend' },
  { id: 'python-env', name: 'Python Environment', description: 'Python runtime for skills' },
  { id: 'code-assist', name: 'Code Assist', description: 'Code analysis and suggestions' },
  { id: 'file-tools', name: 'File Tools', description: 'File operations and management' },
  { id: 'terminal', name: 'Terminal', description: 'Shell command execution' },
];

export function Setup() {
  const { t } = useTranslation('setup');
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState<number>(STEP.WELCOME);
  const [installedSkills, setInstalledSkills] = useState<string[]>([]);
  const [runtimeChecksPassed, setRuntimeChecksPassed] = useState(false);
  const [licenseKey, setLicenseKey] = useState('');
  const [licenseValidation, setLicenseValidation] = useState<LicenseValidationResponse | null>(null);
  const [licenseValidationCode, setLicenseValidationCode] = useState<LicenseValidationCode | 'unknown' | null>(null);
  const [licenseValidating, setLicenseValidating] = useState(false);
  const [settingsRuntimeAddress, setSettingsRuntimeAddress] = useState<RuntimeAddress | null>(null);
  const [licenseRuntimeAddress, setLicenseRuntimeAddress] = useState<RuntimeAddress | null>(null);
  const [platformRuntimeAddress, setPlatformRuntimeAddress] = useState<RuntimeAddress | null>(null);
  const bootstrappedLicenseRef = useRef(false);
  const markSetupComplete = useSettingsStore((state) => state.markSetupComplete);

  const safeStepIndex = Number.isInteger(currentStep)
    ? Math.min(Math.max(currentStep, STEP.WELCOME), steps.length - 1)
    : STEP.WELCOME;
  const step = steps[safeStepIndex] ?? steps[STEP.WELCOME];
  const isFirstStep = safeStepIndex === STEP.WELCOME;
  const isLastStep = safeStepIndex === steps.length - 1;
  const licenseValidated = licenseValidation?.valid === true;

  const canProceed = useMemo(() => {
    switch (safeStepIndex) {
      case STEP.WELCOME:
        return licenseValidated;
      case STEP.RUNTIME:
        return runtimeChecksPassed;
      case STEP.INSTALLING:
        return false;
      case STEP.COMPLETE:
        return true;
      default:
        return true;
    }
  }, [licenseValidated, runtimeChecksPassed, safeStepIndex]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      resolveSingleCapabilityRuntimeAddress(SETTINGS_RUNTIME_CAPABILITY_ID),
      resolveSingleCapabilityRuntimeAddress(LICENSE_RUNTIME_CAPABILITY_ID),
      resolveSingleCapabilityRuntimeAddress(PLATFORM_RUNTIME_CAPABILITY_ID),
    ])
      .then(([settingsAddress, licenseAddress, platformAddress]) => {
        if (active) {
          setSettingsRuntimeAddress(settingsAddress);
          setLicenseRuntimeAddress(licenseAddress);
          setPlatformRuntimeAddress(platformAddress);
        }
      })
      .catch(() => {
        if (active) {
          setSettingsRuntimeAddress(null);
          setLicenseRuntimeAddress(null);
          setPlatformRuntimeAddress(null);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const handleNext = async () => {
    if (isLastStep) {
      if (!settingsRuntimeAddress) {
        toast.error(t('license.messages.unknown'));
        return;
      }
      try {
        await markSetupComplete(settingsRuntimeAddress);
        toast.success(t('complete.title'));
        navigate('/');
      } catch {
        toast.error(t('license.messages.unknown'));
      }
      return;
    }
    setCurrentStep((index) => index + 1);
  };

  const handleBack = () => {
    setCurrentStep((index) => Math.max(index - 1, STEP.WELCOME));
  };

  const handleSkip = () => {
    if (safeStepIndex === STEP.WELCOME && !licenseValidated) {
      toast.error(t('license.messages.requiredBeforeSkip'));
      return;
    }
    if (!settingsRuntimeAddress) {
      toast.error(t('license.messages.unknown'));
      return;
    }
    void markSetupComplete(settingsRuntimeAddress)
      .then(() => {
        navigate('/');
      })
      .catch(() => {
        toast.error(t('license.messages.unknown'));
      });
  };

  const handleLicenseKeyChange = useCallback((value: string) => {
    setLicenseKey(value);
    setLicenseValidation(null);
    setLicenseValidationCode(null);
  }, []);

  const handleValidateLicense = useCallback(async () => {
    if (!licenseRuntimeAddress) {
      setLicenseValidation(null);
      setLicenseValidationCode('unknown');
      toast.error(t('license.messages.unknown'));
      return;
    }
    setLicenseValidating(true);
    try {
      const result = await hostLicenseValidate<LicenseValidationResponse>(licenseKey, licenseRuntimeAddress);

      setLicenseValidation(result);
      setLicenseValidationCode(result.code);
      if (result.normalizedKey) {
        setLicenseKey(result.normalizedKey);
      }

      if (result.valid) {
        toast.success(
          result.code === 'cache_grace_valid'
            ? t('license.messages.cache_grace_valid')
            : t('license.messages.valid')
        );
      } else {
        const localized = t(`license.messages.${result.code}`, { defaultValue: '' });
        const fallback = t('license.messages.unknown');
        toast.error(result.message ? `${localized || fallback}: ${result.message}` : (localized || fallback));
      }
    } catch (error) {
      setLicenseValidation(null);
      setLicenseValidationCode('unknown');
      toast.error(t('license.messages.unknown', { defaultValue: String(error) }));
    } finally {
      setLicenseValidating(false);
    }
  }, [licenseKey, licenseRuntimeAddress, t]);

  useEffect(() => {
    if (bootstrappedLicenseRef.current) {
      return;
    }
    bootstrappedLicenseRef.current = true;

    const bootstrapFromGate = async () => {
      try {
        const [storedKeyPayload, gate] = await Promise.all([
          hostApiFetch<{ key: string | null }>('/api/license/stored-key'),
          hostApiFetch<LicenseGateSnapshot>('/api/license/gate'),
        ]);

        const normalizedStoredKey = typeof storedKeyPayload?.key === 'string'
          ? storedKeyPayload.key.trim()
          : '';
        if (normalizedStoredKey) {
          setLicenseKey(normalizedStoredKey);
        }

        if (gate?.state !== 'granted') {
          return;
        }

        const lastValidation = gate.lastValidation;
        const resolvedValidation: LicenseValidationResponse =
          lastValidation && lastValidation.valid
            ? {
              ...lastValidation,
              normalizedKey: lastValidation.normalizedKey || normalizedStoredKey || undefined,
            }
            : {
              valid: true,
              code: 'valid',
              normalizedKey: normalizedStoredKey || undefined,
            };

        setLicenseValidation(resolvedValidation);
        setLicenseValidationCode(resolvedValidation.code);
        if (resolvedValidation.normalizedKey) {
          setLicenseKey(resolvedValidation.normalizedKey);
        }

        setCurrentStep((prev) => (prev === STEP.WELCOME ? STEP.RUNTIME : prev));
      } catch {
        // Ignore bootstrap errors and keep user on manual flow.
      }
    };

    void bootstrapFromGate();
  }, []);

  const handleInstallationComplete = useCallback((skills: string[]) => {
    setInstalledSkills(skills);
    setTimeout(() => {
      setCurrentStep((index) => index + 1);
    }, 1000);
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex-1 overflow-auto">
        <div className="flex justify-center pt-8">
          <div className="flex items-center gap-2">
            {steps.map((item, index) => (
              <div key={item.id} className="flex items-center">
                <div
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full border-2 transition-colors',
                    index < safeStepIndex
                      ? 'border-primary bg-primary text-primary-foreground'
                      : index === safeStepIndex
                        ? 'border-primary text-primary'
                        : 'border-slate-600 text-slate-600'
                  )}
                >
                  {index < safeStepIndex ? <Check className="h-4 w-4" /> : <span className="text-sm">{index + 1}</span>}
                </div>
                {index < steps.length - 1 && (
                  <div
                    className={cn(
                      'h-0.5 w-8 transition-colors',
                      index < safeStepIndex ? 'bg-primary' : 'bg-slate-600'
                    )}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={step.id}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="mx-auto max-w-2xl p-8"
          >
            <div className="mb-8 text-center">
              <h1 className="mb-2 text-3xl font-bold">{t(`steps.${step.id}.title`)}</h1>
              <p className="text-slate-400">{t(`steps.${step.id}.description`)}</p>
            </div>

            <div className="mb-8 rounded-xl border bg-card p-8 text-card-foreground shadow-sm">
              {safeStepIndex === STEP.WELCOME && (
                <WelcomeContent
                  licenseKey={licenseKey}
                  onLicenseKeyChange={handleLicenseKeyChange}
                  onValidateLicense={handleValidateLicense}
                  licenseValidating={licenseValidating}
                  licenseValidationCode={licenseValidationCode}
                  settingsRuntimeAddress={settingsRuntimeAddress}
                />
              )}
              {safeStepIndex === STEP.RUNTIME && <RuntimeContent onStatusChange={setRuntimeChecksPassed} />}
              {safeStepIndex === STEP.INSTALLING && (
                <InstallingContent
                  skills={defaultSkills}
                  runtimeAddress={platformRuntimeAddress}
                  onComplete={handleInstallationComplete}
                  onSkip={() => setCurrentStep((index) => index + 1)}
                />
              )}
              {safeStepIndex === STEP.COMPLETE && <CompleteContent installedSkills={installedSkills} />}
            </div>

            {safeStepIndex !== STEP.INSTALLING && (
              <div className="flex justify-between">
                <div>
                  {!isFirstStep && (
                    <Button variant="ghost" onClick={handleBack}>
                      <ChevronLeft className="mr-2 h-4 w-4" />
                      {t('nav.back')}
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  {!isLastStep && safeStepIndex !== STEP.RUNTIME && safeStepIndex !== STEP.WELCOME && (
                    <Button variant="ghost" onClick={handleSkip}>
                      {t('nav.skipSetup')}
                    </Button>
                  )}
                  <Button onClick={handleNext} disabled={!canProceed}>
                    {isLastStep ? (
                      t('nav.getStarted')
                    ) : (
                      <>
                        {t('nav.next')}
                        <ChevronRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

interface WelcomeContentProps {
  licenseKey: string;
  onLicenseKeyChange: (value: string) => void;
  onValidateLicense: () => Promise<void>;
  licenseValidating: boolean;
  licenseValidationCode: LicenseValidationCode | 'unknown' | null;
  settingsRuntimeAddress: RuntimeAddress | null;
}

function WelcomeContent({
  licenseKey,
  onLicenseKeyChange,
  onValidateLicense,
  licenseValidating,
  licenseValidationCode,
  settingsRuntimeAddress,
}: WelcomeContentProps) {
  const { t } = useTranslation('setup');
  const { language, setLanguage } = useSettingsStore();

  return (
    <div className="space-y-4 text-center">
      <div className="mb-4 flex justify-center">
        <img src={matchaClawIcon} alt="MatchaClaw" className="h-16 w-16" />
      </div>
      <h2 className="text-xl font-semibold">{t('welcome.title')}</h2>
      <p className="text-muted-foreground">{t('welcome.description')}</p>

      <div className="mx-auto max-w-md space-y-3 rounded-lg border p-4 text-left">
        <div className="space-y-1">
          <Label htmlFor="setup-license-key">{t('license.label')}</Label>
          <p className="text-xs text-muted-foreground">{t('license.hint')}</p>
        </div>
        <div className="flex gap-2">
          <Input
            id="setup-license-key"
            value={licenseKey}
            placeholder={t('license.placeholder')}
            onChange={(event) => onLicenseKeyChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void onValidateLicense();
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="button" onClick={() => void onValidateLicense()} disabled={licenseValidating}>
            {licenseValidating ? <Loader2 className="h-4 w-4 animate-spin" /> : t('license.validate')}
          </Button>
        </div>
        <p
          className={cn(
            'text-xs',
            licenseValidationCode === 'valid' || licenseValidationCode === 'cache_grace_valid'
              ? 'text-green-500'
              : licenseValidationCode
                ? 'text-destructive'
                : 'text-muted-foreground'
          )}
        >
          {licenseValidationCode ? t(`license.messages.${licenseValidationCode}`) : t('license.messages.idle')}
        </p>
      </div>

      <div className="flex justify-center gap-2 py-2">
        {SUPPORTED_LANGUAGES.map((lang) => (
          <Button
            key={lang.code}
            variant={language === lang.code ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => { if (settingsRuntimeAddress) void setLanguage(lang.code, settingsRuntimeAddress).catch(() => {}); }}
            className="h-7 text-xs"
          >
            {lang.label}
          </Button>
        ))}
      </div>

      <ul className="space-y-2 pt-2 text-left text-muted-foreground">
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-400" />
          {t('welcome.features.noCommand')}
        </li>
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-400" />
          {t('welcome.features.modernUI')}
        </li>
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-400" />
          {t('welcome.features.bundles')}
        </li>
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-400" />
          {t('welcome.features.crossPlatform')}
        </li>
      </ul>
    </div>
  );
}

interface RuntimeContentProps {
  onStatusChange: (canProceed: boolean) => void;
}

function RuntimeContent({ onStatusChange }: RuntimeContentProps) {
  const { t } = useTranslation('setup');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const startGateway = useGatewayStore((state) => state.start);
  const [checks, setChecks] = useState({
    nodejs: { status: 'checking' as 'checking' | 'success' | 'error', message: '' },
    openclaw: { status: 'checking' as 'checking' | 'success' | 'error', message: '' },
    gateway: { status: 'checking' as 'checking' | 'success' | 'error', message: '' },
  });
  const [showLogs, setShowLogs] = useState(false);
  const [logContent, setLogContent] = useState('');
  const [openclawDir, setOpenclawDir] = useState('');
  const gatewayTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const runChecks = useCallback(async () => {
    setChecks({
      nodejs: { status: 'checking', message: '' },
      openclaw: { status: 'checking', message: '' },
      gateway: { status: 'checking', message: '' },
    });

    setChecks((prev) => ({
      ...prev,
      nodejs: { status: 'success', message: t('runtime.status.success') },
    }));

    try {
      const openclawStatus = await hostOpenClawGetStatus();
      setOpenclawDir(openclawStatus.dir);

      if (!openclawStatus.packageExists) {
        setChecks((prev) => ({
          ...prev,
          openclaw: { status: 'error', message: `OpenClaw package not found at: ${openclawStatus.dir}` },
        }));
      } else if (!openclawStatus.isBuilt) {
        setChecks((prev) => ({
          ...prev,
          openclaw: { status: 'error', message: 'OpenClaw package found but dist is missing' },
        }));
      } else {
        const versionLabel = openclawStatus.version ? ` v${openclawStatus.version}` : '';
        setChecks((prev) => ({
          ...prev,
          openclaw: { status: 'success', message: `OpenClaw package ready${versionLabel}` },
        }));
      }
    } catch (error) {
      setChecks((prev) => ({
        ...prev,
        openclaw: { status: 'error', message: `Check failed: ${error}` },
      }));
    }

    const currentGateway = useGatewayStore.getState().status;
    if (isGatewayOperational(currentGateway)) {
      setChecks((prev) => ({
        ...prev,
        gateway: { status: 'success', message: `Running on port ${currentGateway.port}` },
      }));
    } else if (currentGateway.processState === 'error') {
      setChecks((prev) => ({
        ...prev,
        gateway: { status: 'error', message: currentGateway.error || t('runtime.status.error') },
      }));
    } else {
      setChecks((prev) => ({
        ...prev,
        gateway: {
          status: 'checking',
          message: currentGateway.processState === 'starting' || currentGateway.processState === 'control_connecting'
            ? t('runtime.status.checking')
            : 'Waiting for gateway...',
        },
      }));
    }
  }, [t]);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  useEffect(() => {
    const allPassed = checks.nodejs.status === 'success'
      && checks.openclaw.status === 'success'
      && (checks.gateway.status === 'success' || isGatewayOperational(gatewayStatus));
    onStatusChange(allPassed);
  }, [checks, gatewayStatus, onStatusChange]);

  useEffect(() => {
    if (isGatewayOperational(gatewayStatus)) {
      setChecks((prev) => ({
        ...prev,
        gateway: { status: 'success', message: t('runtime.status.gatewayRunning', { port: gatewayStatus.port }) },
      }));
    } else if (gatewayStatus.processState === 'error') {
      setChecks((prev) => ({
        ...prev,
        gateway: { status: 'error', message: gatewayStatus.error || 'Failed to start' },
      }));
    } else if (isGatewayUnavailable(gatewayStatus)) {
      setChecks((prev) => ({
        ...prev,
        gateway: { status: 'error', message: gatewayStatus.lastError || 'Gateway unavailable' },
      }));
    } else if (isGatewayRecovering(gatewayStatus)) {
      setChecks((prev) => ({
        ...prev,
        gateway: { status: 'checking', message: 'Starting...' },
      }));
    }
  }, [gatewayStatus, t]);

  useEffect(() => {
    if (gatewayTimeoutRef.current) {
      clearTimeout(gatewayTimeoutRef.current);
      gatewayTimeoutRef.current = null;
    }

    if (
      isGatewayOperational(gatewayStatus)
      || gatewayStatus.processState === 'error'
      || isGatewayUnavailable(gatewayStatus)
    ) {
      return;
    }

    gatewayTimeoutRef.current = setTimeout(() => {
      setChecks((prev) => {
        if (prev.gateway.status === 'checking') {
          return {
            ...prev,
            gateway: { status: 'error', message: 'Gateway startup timed out' },
          };
        }
        return prev;
      });
    }, 600 * 1000);

    return () => {
      if (gatewayTimeoutRef.current) {
        clearTimeout(gatewayTimeoutRef.current);
        gatewayTimeoutRef.current = null;
      }
    };
  }, [gatewayStatus]);

  const handleStartGateway = async () => {
    setChecks((prev) => ({
      ...prev,
      gateway: { status: 'checking', message: 'Starting...' },
    }));
    await startGateway();
  };

  const handleShowLogs = async () => {
    try {
      const logs = await hostApiFetch<{ content: string }>('/api/logs?tailLines=100');
      setLogContent(logs.content);
      setShowLogs(true);
    } catch {
      setLogContent('(Failed to load logs)');
      setShowLogs(true);
    }
  };

  const handleOpenLogDir = async () => {
    try {
      const { dir: logDir } = await hostApiFetch<{ dir: string | null }>('/api/logs/dir');
      if (logDir) {
        await invokeIpc('shell:showItemInFolder', logDir);
      }
    } catch {
      // Ignore log directory open failures.
    }
  };

  const renderStatus = (status: 'checking' | 'success' | 'error', message: string) => {
    if (status === 'checking') {
      return (
        <span className="flex items-center gap-2 whitespace-nowrap text-yellow-400">
          <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" />
          {message || 'Checking...'}
        </span>
      );
    }
    if (status === 'success') {
      return (
        <span className="flex items-center gap-2 whitespace-nowrap text-green-400">
          <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
          {message}
        </span>
      );
    }

    const isLong = message.length > 30;
    const displayMessage = isLong ? message.slice(0, 30) : message;

    return (
      <span className="flex items-center gap-2 whitespace-nowrap text-red-400">
        <XCircle className="h-5 w-5 flex-shrink-0" />
        <span>{displayMessage}</span>
        {isLong && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-pointer font-medium text-red-300 hover:text-red-200">...</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-sm whitespace-normal break-words text-xs">
              {message}
            </TooltipContent>
          </Tooltip>
        )}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">{t('runtime.title')}</h2>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={handleShowLogs}>
            {t('runtime.viewLogs')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void runChecks()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('runtime.recheck')}
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-[1fr_auto] items-center gap-4 rounded-lg bg-muted/50 p-3">
          <span className="text-left">{t('runtime.nodejs')}</span>
          <div className="flex justify-end">{renderStatus(checks.nodejs.status, checks.nodejs.message)}</div>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center gap-4 rounded-lg bg-muted/50 p-3">
          <div className="min-w-0 text-left">
            <span>{t('runtime.openclaw')}</span>
            {openclawDir && (
              <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                {openclawDir}
              </p>
            )}
          </div>
          <div className="mt-0.5 flex justify-end self-start">
            {renderStatus(checks.openclaw.status, checks.openclaw.message)}
          </div>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center gap-4 rounded-lg bg-muted/50 p-3">
          <div className="flex items-center gap-2 text-left">
            <span>Gateway Service</span>
            {checks.gateway.status === 'error' && (
              <Button variant="outline" size="sm" onClick={handleStartGateway}>
                Start Gateway
              </Button>
            )}
          </div>
          <div className="flex justify-end">{renderStatus(checks.gateway.status, checks.gateway.message)}</div>
        </div>
      </div>

      {(checks.nodejs.status === 'error' || checks.openclaw.status === 'error') && (
        <div className="mt-4 rounded-lg border border-red-500/20 bg-red-900/20 p-4">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-5 w-5 text-red-400" />
            <div>
              <p className="font-medium text-red-400">{t('runtime.issue.title')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('runtime.issue.desc')}</p>
            </div>
          </div>
        </div>
      )}

      {showLogs && (
        <div className="mt-4 rounded-lg border border-border bg-black/40 p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">Application Logs</p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleOpenLogDir}>
                <ExternalLink className="mr-1 h-3 w-3" />
                Open Log Folder
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowLogs(false)}>
                Close
              </Button>
            </div>
          </div>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-black/50 p-3 font-mono text-xs text-slate-300">
            {logContent || '(No logs available yet)'}
          </pre>
        </div>
      )}
    </div>
  );
}

type InstallStatus = 'pending' | 'installing' | 'completed' | 'failed';

interface SkillInstallState {
  id: string;
  name: string;
  description: string;
  status: InstallStatus;
}

interface InstallingContentProps {
  skills: DefaultSkill[];
  runtimeAddress: RuntimeAddress | null;
  onComplete: (installedSkills: string[]) => void;
  onSkip: () => void;
}

function InstallingContent({ skills, runtimeAddress, onComplete, onSkip }: InstallingContentProps) {
  const { t } = useTranslation('setup');
  const [skillStates, setSkillStates] = useState<SkillInstallState[]>(
    skills.map((skill) => ({ ...skill, status: 'pending' as InstallStatus }))
  );
  const [overallProgress, setOverallProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const installStarted = useRef(false);

  useEffect(() => {
    if (installStarted.current) {
      return;
    }
    installStarted.current = true;

    const runRealInstall = async () => {
      try {
        if (!runtimeAddress) {
          throw new Error('platform runtime address unavailable');
        }
        setSkillStates((prev) => prev.map((skill) => ({ ...skill, status: 'installing' })));
        setOverallProgress(10);

        const submission = await hostUvInstallAll(runtimeAddress);
        await waitForRuntimeJobResult(submission.job.id, {
          timeoutMs: 120000,
          intervalMs: 500,
        });
        setSkillStates((prev) => prev.map((skill) => ({ ...skill, status: 'completed' })));
        setOverallProgress(100);
        await new Promise((resolve) => setTimeout(resolve, 800));
        onComplete(skills.map((skill) => skill.id));
      } catch (error) {
        setSkillStates((prev) => prev.map((skill) => ({ ...skill, status: 'failed' })));
        setErrorMessage(String(error));
        toast.error('Installation error');
      }
    };

    void runRealInstall();
  }, [onComplete, runtimeAddress, skills]);

  const getStatusIcon = (status: InstallStatus) => {
    switch (status) {
      case 'pending':
        return <div className="h-5 w-5 rounded-full border-2 border-slate-500" />;
      case 'installing':
        return <Loader2 className="h-5 w-5 animate-spin text-primary" />;
      case 'completed':
        return <CheckCircle2 className="h-5 w-5 text-green-400" />;
      case 'failed':
        return <XCircle className="h-5 w-5 text-red-400" />;
    }
  };

  const getStatusText = (skill: SkillInstallState) => {
    switch (skill.status) {
      case 'pending':
        return <span className="text-muted-foreground">{t('installing.status.pending')}</span>;
      case 'installing':
        return <span className="text-primary">{t('installing.status.installing')}</span>;
      case 'completed':
        return <span className="text-green-400">{t('installing.status.installed')}</span>;
      case 'failed':
        return <span className="text-red-400">{t('installing.status.failed')}</span>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mb-4 text-4xl">⚙️</div>
        <h2 className="mb-2 text-xl font-semibold">{t('installing.title')}</h2>
        <p className="text-muted-foreground">{t('installing.subtitle')}</p>
      </div>

      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t('installing.progress')}</span>
          <span className="text-primary">{overallProgress}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-secondary">
          <motion.div
            className="h-full bg-primary"
            initial={{ width: 0 }}
            animate={{ width: `${overallProgress}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
      </div>

      <div className="max-h-48 space-y-2 overflow-y-auto">
        {skillStates.map((skill) => (
          <motion.div
            key={skill.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn(
              'flex items-center justify-between rounded-lg p-3',
              skill.status === 'installing' ? 'bg-muted' : 'bg-muted/50'
            )}
          >
            <div className="flex items-center gap-3">
              {getStatusIcon(skill.status)}
              <div>
                <p className="font-medium">{skill.name}</p>
                <p className="text-xs text-muted-foreground">{skill.description}</p>
              </div>
            </div>
            {getStatusText(skill)}
          </motion.div>
        ))}
      </div>

      {errorMessage && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="rounded-lg border border-red-500/50 bg-red-900/30 p-4 text-sm text-red-200"
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
            <div className="space-y-1">
              <p className="font-semibold">{t('installing.error')}</p>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-monospace text-xs">
                {errorMessage}
              </pre>
              <Button
                variant="link"
                className="h-auto p-0 text-xs text-red-400 underline"
                onClick={() => window.location.reload()}
              >
                {t('installing.restart')}
              </Button>
            </div>
          </div>
        </motion.div>
      )}

      {!errorMessage && (
        <p className="text-center text-sm text-slate-400">{t('installing.wait')}</p>
      )}

      <div className="flex justify-end">
        <Button variant="ghost" className="text-muted-foreground" onClick={onSkip}>
          {t('installing.skip')}
        </Button>
      </div>
    </div>
  );
}

interface CompleteContentProps {
  installedSkills: string[];
}

function CompleteContent({ installedSkills }: CompleteContentProps) {
  const { t } = useTranslation('setup');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const installedSkillNames = defaultSkills
    .filter((skill) => installedSkills.includes(skill.id))
    .map((skill) => skill.name)
    .join(', ');

  return (
    <div className="space-y-6 text-center">
      <div className="mb-4 text-6xl">🎉</div>
      <h2 className="text-xl font-semibold">{t('complete.title')}</h2>
      <p className="text-muted-foreground">{t('complete.subtitle')}</p>

      <div className="mx-auto max-w-md space-y-3 text-left">
        <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
          <span>{t('complete.components')}</span>
          <span className="text-green-400">
            {installedSkillNames || `${installedSkills.length} ${t('installing.status.installed')}`}
          </span>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
          <span>{t('complete.gateway')}</span>
          <span className={isGatewayOperational(gatewayStatus) ? 'text-green-400' : 'text-yellow-400'}>
            {isGatewayOperational(gatewayStatus) ? `✓ ${t('complete.running')}` : gatewayStatus.processState}
          </span>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{t('complete.footer')}</p>
    </div>
  );
}

export default Setup;
