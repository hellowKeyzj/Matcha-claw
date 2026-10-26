import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { RouteLoadingFallback } from '@/app/routes';
import { isTraceEnabled, startupTrace } from '@/lib/trace-logger';
import { buildSettingsSectionLink, parseSettingsSectionFromSearch } from '@/plugins/settings/sections';
import { AccountBootSplash, AuthPage } from './auth';
import { useAccountStore } from './stores/account';
import { useLicenseStore, useLocalLicenseLocked } from './stores/license';

function isLocalAccountEntryState(state: unknown): boolean {
  return !!state && typeof state === 'object' && (state as { accountEntry?: unknown }).accountEntry === 'local';
}

export function useAccountGate() {
  const navigate = useNavigate();
  const location = useLocation();
  const isAuthRoute = location.pathname === '/login' || location.pathname === '/register';
  const [localAccountEntryAccepted, setLocalAccountEntryAccepted] = useState(() =>
    isLocalAccountEntryState(location.state)
  );
  const accountStatus = useAccountStore((state) => state.status);
  const licenseLocked = useLocalLicenseLocked();
  const licenseSnapshot = useLicenseStore((state) => state.snapshot);
  const licenseError = useLicenseStore((state) => state.error);
  const subscribeLicense = useLicenseStore((state) => state.subscribe);

  useEffect(() => {
    if (accountStatus === 'signedIn' && isAuthRoute) {
      navigate('/', { replace: true });
    }
  }, [accountStatus, isAuthRoute, navigate]);

  const acceptLocalAccountEntry = useCallback(() => {
    setLocalAccountEntryAccepted(true);
  }, []);

  if (accountStatus === 'signedIn' && localAccountEntryAccepted) {
    setLocalAccountEntryAccepted(false);
  }
  const localAccountEntryRequested = localAccountEntryAccepted || isLocalAccountEntryState(location.state);

  const licenseRequired = localAccountEntryRequested && accountStatus !== 'signedIn';
  const licenseChecking = licenseRequired && !licenseError
    && (licenseSnapshot === null || licenseSnapshot.state === 'checking');
  const licenseBlocked = localAccountEntryRequested && licenseLocked && !licenseChecking;
  const isLicenseRoute = location.pathname === '/settings'
    && parseSettingsSectionFromSearch(location.search) === 'license';
  const observeLicense = licenseRequired || (accountStatus === 'signedIn' && isLicenseRoute);
  useEffect(() => {
    if (observeLicense) return subscribeLicense();
  }, [observeLicense, subscribeLicense]);
  const shouldApplyAccountGate = !isAuthRoute;
  const showAccountBoot = shouldApplyAccountGate
    && accountStatus === 'checking'
    && !localAccountEntryRequested;
  const showAuthGate = shouldApplyAccountGate
    && (accountStatus === 'signedOut' || accountStatus === 'offline' || accountStatus === 'requires2fa')
    && !localAccountEntryRequested;

  const gate = showAccountBoot ? 'account-checking'
    : showAuthGate ? 'auth'
    : licenseChecking && !isAuthRoute && !isLicenseRoute ? 'license-checking'
    : licenseBlocked && !isAuthRoute && !isLicenseRoute ? 'license-blocked'
    : 'routes';
  const licenseState = licenseSnapshot?.state ?? 'unobserved';
  useLayoutEffect(() => {
    if (!isTraceEnabled()) return;
    const startedAt = performance.now();
    const detail = () => ({ gate, accountStatus, licenseState, isAuthRoute, isLicenseRoute });
    startupTrace('renderer.app', 'gate.setup', detail);
    return () => startupTrace('renderer.app', 'gate.cleanup', () => ({
      ...detail(), durationMs: Math.round(performance.now() - startedAt),
    }));
  }, [gate, accountStatus, licenseState, isAuthRoute, isLicenseRoute]);

  const gateElement = showAccountBoot ? (
    <AccountBootSplash />
  ) : showAuthGate ? (
    <AuthPage onLocalEntry={acceptLocalAccountEntry} />
  ) : licenseChecking && !isAuthRoute && !isLicenseRoute ? (
    <RouteLoadingFallback />
  ) : licenseBlocked && !isAuthRoute && !isLicenseRoute ? (
    <Navigate to={buildSettingsSectionLink('license')} replace state={{ accountEntry: 'local' }} />
  ) : null;

  return {
    isAuthRoute,
    contentVisible: !isAuthRoute && !showAccountBoot && !showAuthGate && !licenseChecking && !licenseBlocked,
    gateElement,
    acceptLocalAccountEntry,
  };
}
