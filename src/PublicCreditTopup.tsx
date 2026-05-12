/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';
import { Coins } from 'lucide-react';
import { track } from './analytics';
import { resolveFunctionsHttpUrl } from './resolveFunctionsHttpUrl';

const MIN_STEP = 50;

async function readApiError(res: Response): Promise<string> {
  const t = await res.text();
  try {
    const j = JSON.parse(t) as { error?: string; message?: string };
    return j.error || j.message || t || `HTTP ${res.status}`;
  } catch {
    return t || `HTTP ${res.status}`;
  }
}

async function parseJsonBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) {
    throw new Error(
      'Server returned HTML instead of JSON (usually the app shell). Using the Hosting emulator, open /add-credits after npm run build or run npm run dev on port 3000.'
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(text.slice(0, 180) || `Invalid response (${res.status})`);
  }
}

export default function PublicCreditTopup() {
  const [email, setEmail] = React.useState('');
  const [amountRaw, setAmountRaw] = React.useState('50');
  const [phase, setPhase] = React.useState<
    'idle' | 'creating' | 'awaiting_payment' | 'verifying'
  >('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<{ credits: number; added: number } | null>(null);

  const parsedAmount = Number.parseInt(String(amountRaw).trim(), 10);

  const validationHint = React.useMemo(() => {
    if (!Number.isFinite(parsedAmount)) return 'Enter a whole number';
    if (parsedAmount < MIN_STEP) return `Minimum is ${MIN_STEP}`;
    if (parsedAmount % MIN_STEP !== 0) return `Must be a multiple of ${MIN_STEP}`;
    return null;
  }, [parsedAmount]);

  const busy = phase !== 'idle';

  const startCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (validationHint) {
      setError(validationHint);
      return;
    }

    const RazorpayCtor = (window as unknown as { Razorpay?: new (opts: unknown) => { open: () => void; on: (ev: string, fn: (err: unknown) => void) => void } }).Razorpay;
    if (!RazorpayCtor) {
      setError('Razorpay checkout script not loaded');
      return;
    }

    setPhase('creating');
    try {
      track('ve_public_topup_submit', { credits: parsedAmount });
      const createUrl = resolveFunctionsHttpUrl('/api/razorpay/createPublicOrder');
      const orderRes = await fetch(createUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), credits: parsedAmount }),
      });
      if (!orderRes.ok) {
        setError(await readApiError(orderRes));
        setPhase('idle');
        return;
      }
      const payload = await parseJsonBody<{
        order: { id: string; amount: number; currency: string; notes?: Record<string, string> };
        keyId: string;
        credits: number;
        amountInr: number;
      }>(orderRes);
      const { order, keyId, credits, amountInr } = payload;

      await new Promise<void>((resolve, reject) => {
        const rzp = new RazorpayCtor({
          key: keyId,
          amount: order.amount,
          currency: order.currency || 'INR',
          name: 'Vehicle Enrollment',
          description: `${credits} credits — ₹${amountInr}`,
          order_id: order.id,
          prefill: {
            email: email.trim(),
          },
          notes: order.notes || undefined,
          theme: { color: '#2563eb' },
          handler: async (response: {
            razorpay_order_id: string;
            razorpay_payment_id: string;
            razorpay_signature: string;
          }) => {
            setPhase('verifying');
            try {
              const verifyUrl = resolveFunctionsHttpUrl('/api/razorpay/verifyPublicPayment');
              const verifyRes = await fetch(verifyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(response),
              });
              const data = await parseJsonBody<{
                ok?: boolean;
                credits?: number;
                error?: string;
              }>(verifyRes);
              if (!verifyRes.ok || !data.ok) {
                const msg = data.error || `Verification failed (${verifyRes.status})`;
                setPhase('idle');
                reject(new Error(msg));
                return;
              }
              const added = credits;
              const newBal = Number(data.credits);
              setSuccess({
                credits: Number.isFinite(newBal) ? newBal : 0,
                added: added,
              });
              track('ve_public_topup_ok', { credits: added });
              setPhase('idle');
              resolve();
            } catch (err) {
              setPhase('idle');
              reject(err instanceof Error ? err : new Error('Verification failed'));
            }
          },
          modal: {
            ondismiss: () => {
              track('ve_public_topup_dismiss');
              setPhase('idle');
              reject(new Error('Payment cancelled'));
            },
          },
        });

        rzp.on('payment.failed', (err: unknown) => {
          const desc =
            err &&
            typeof err === 'object' &&
            'error' in err &&
            err.error &&
            typeof err.error === 'object' &&
            'description' in err.error
              ? String((err.error as { description?: string }).description)
              : 'Payment failed';
          track('ve_public_topup_payment_failed', { desc: desc.slice(0, 80) });
          setPhase('idle');
          reject(new Error(desc));
        });

        setPhase('awaiting_payment');
        rzp.open();
      });
    } catch (err) {
      console.error('Public checkout error:', err);
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setPhase('idle');
    }
  };

  return (
    <div className="min-h-screen bg-[#FDFDFD] text-slate-900 font-sans flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md rounded-[2.5rem] border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/50">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center">
            <Coins className="w-6 h-6" strokeWidth={2.25} />
          </div>
          <div>
            <h1 className="text-lg font-black tracking-tight text-slate-900">Buy credits</h1>
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
              Razorpay · No sign-in
            </p>
          </div>
        </div>
        <p className="mt-4 text-sm text-slate-600 leading-relaxed">
          Enter the email on your account and how many credits to buy. Amount must be a multiple of{' '}
          {MIN_STEP} (minimum {MIN_STEP}). Payment is processed with Razorpay; credits are added after a
          successful payment if an account exists for that email.
        </p>
        <p className="mt-3 text-xs text-slate-500 leading-relaxed">
          Price on this page defaults to <span className="font-bold text-slate-700">₹1 per credit</span>{' '}
          (server env <code className="font-mono text-[11px]">PUBLIC_TOPUP_INR_PER_CREDIT</code> can change
          this).
        </p>

        <form onSubmit={startCheckout} className="mt-8 space-y-5">
          <div>
            <label htmlFor="pct-email" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
              Account email
            </label>
            <input
              id="pct-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              disabled={busy}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-60"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label htmlFor="pct-amount" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
              Credits to buy
            </label>
            <input
              id="pct-amount"
              type="number"
              min={MIN_STEP}
              step={MIN_STEP}
              required
              value={amountRaw}
              onChange={(ev) => setAmountRaw(ev.target.value)}
              disabled={busy}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-60"
            />
            {validationHint ? (
              <p className="mt-2 text-xs font-bold text-amber-700">{validationHint}</p>
            ) : null}
          </div>

          {error ? (
            <div className="rounded-2xl bg-red-50 border border-red-100 px-4 py-3 text-sm font-bold text-red-800">
              {error}
            </div>
          ) : null}

          {success ? (
            <div className="rounded-2xl bg-emerald-50 border border-emerald-100 px-4 py-3 text-sm font-bold text-emerald-900">
              Added {success.added} credits. New balance: {success.credits}.
            </div>
          ) : null}

          <button
            type="submit"
            disabled={busy || !!validationHint}
            className="w-full rounded-2xl bg-blue-600 py-4 text-xs font-black uppercase tracking-widest text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-600/20"
          >
            {phase === 'creating'
              ? 'Starting checkout…'
              : phase === 'awaiting_payment'
                ? 'Complete payment in Razorpay…'
                : phase === 'verifying'
                  ? 'Verifying payment…'
                  : 'Pay with Razorpay'}
          </button>
        </form>

        <p className="mt-8 text-center text-[11px] text-slate-400 font-medium">
          <a href="/" className="text-blue-600 font-bold hover:underline">
            Back to app
          </a>
        </p>
      </div>
    </div>
  );
}
