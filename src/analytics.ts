/**
 * Google Analytics 4 via Firebase Analytics. All helpers are no-ops when unsupported
 * or when measurement is disabled.
 */
import {
  getAnalytics,
  isSupported,
  logEvent,
  setUserId,
  setUserProperties,
  type Analytics,
} from 'firebase/analytics';
import { app } from './firebase';

const MAX_EVENT_NAME = 40;
const MAX_PARAM_NAME = 40;
const MAX_PARAM_STR = 100;
const MAX_CUSTOM_PARAMS = 20;

const disabled =
  typeof import.meta.env !== 'undefined' &&
  (import.meta.env.VITE_ANALYTICS_DISABLED === 'true' ||
    import.meta.env.VITE_ANALYTICS_DISABLED === '1');

let analyticsPromise: Promise<Analytics | null> | null = null;

function getAnalyticsInstance(): Promise<Analytics | null> {
  if (typeof window === 'undefined' || disabled) return Promise.resolve(null);
  if (analyticsPromise) return analyticsPromise;
  analyticsPromise = (async () => {
    const measurementId = (app.options as { measurementId?: string }).measurementId;
    if (!measurementId) return null;
    try {
      if (!(await isSupported())) return null;
      return getAnalytics(app);
    } catch {
      return null;
    }
  })();
  return analyticsPromise;
}

export function initAnalytics(): Promise<Analytics | null> {
  return getAnalyticsInstance();
}

function sanitizeParams(params?: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!params) return out;
  let n = 0;
  for (const [rawKey, v] of Object.entries(params)) {
    if (n >= MAX_CUSTOM_PARAMS) break;
    if (v === undefined || v === null) continue;
    const key = rawKey
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, MAX_PARAM_NAME);
    if (!key) continue;
    if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else out[key] = String(v).slice(0, MAX_PARAM_STR);
    n++;
  }
  return out;
}

function normalizeEventName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, MAX_EVENT_NAME);
}

/** Custom and recommended GA4 events (snake_case, ≤40 chars). */
export function track(eventName: string, params?: Record<string, unknown>): void {
  const name = normalizeEventName(eventName);
  if (!name) return;
  void getAnalyticsInstance().then((a) => {
    if (!a) return;
    try {
      logEvent(a, name, sanitizeParams(params));
    } catch (e) {
      console.warn('[analytics] logEvent failed', e);
    }
  });
}

/** Manual screen reporting for SPA views. */
export function trackScreen(screenName: string, params?: Record<string, unknown>): void {
  const screen = screenName.slice(0, MAX_PARAM_STR);
  void getAnalyticsInstance().then((a) => {
    if (!a) return;
    try {
      logEvent(a, 'screen_view', {
        firebase_screen: screen,
        firebase_screen_class: screen,
        ...sanitizeParams(params),
      });
    } catch (e) {
      console.warn('[analytics] screen_view failed', e);
    }
  });
}

export function setAnalyticsUserId(uid: string | null): void {
  void getAnalyticsInstance().then((a) => {
    if (!a) return;
    try {
      setUserId(a, uid ?? '');
    } catch (e) {
      console.warn('[analytics] setUserId failed', e);
    }
  });
}

export function setAnalyticsUserProps(props: Record<string, string | number | boolean>): void {
  void getAnalyticsInstance().then((a) => {
    if (!a) return;
    try {
      const stringProps: Record<string, string> = {};
      for (const [k, v] of Object.entries(sanitizeParams(props))) {
        stringProps[k] = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
      }
      setUserProperties(a, stringProps);
    } catch (e) {
      console.warn('[analytics] setUserProperties failed', e);
    }
  });
}
