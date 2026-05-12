/**
 * Firebase Hosting emulator (:5000) often serves index.html for POST /api/* instead of
 * rewriting to the Functions emulator. Call the HTTP functions URL directly in that case.
 */
import { app } from './firebase';

const REGION = 'us-central1';

const REWRITE_TO_EXPORT: Record<string, string> = {
  '/api/razorpay/createPublicOrder': 'createPublicRazorpayOrder',
  '/api/razorpay/verifyPublicPayment': 'verifyPublicRazorpayPayment',
};

function isLocalHostingEmulatorPort5000(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const u = new URL(window.location.href);
    const localHost =
      u.hostname === '127.0.0.1' ||
      u.hostname === 'localhost' ||
      u.hostname === '[::1]' ||
      u.hostname === '::1';
    return localHost && u.port === '5000';
  } catch {
    return false;
  }
}

function forceFunctionsEmulatorFromEnv(): boolean {
  const v = import.meta.env.VITE_FUNCTIONS_EMULATOR_HTTP;
  return v === 'true' || v === '1';
}

export function resolveFunctionsHttpUrl(hostingRewritePath: string): string {
  if (typeof window === 'undefined') return hostingRewritePath;

  if (!forceFunctionsEmulatorFromEnv() && !isLocalHostingEmulatorPort5000()) {
    return hostingRewritePath;
  }

  const exportName = REWRITE_TO_EXPORT[hostingRewritePath];
  if (!exportName) return hostingRewritePath;

  const projectId = app.options.projectId || '';
  return `http://127.0.0.1:5001/${projectId}/${REGION}/${exportName}`;
}
