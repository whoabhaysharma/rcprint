import React, { useState, useEffect, useCallback } from 'react';
import type { User } from 'firebase/auth';
import { ArrowLeft, Users, Coins, FileText, LayoutGrid, IndianRupee, CheckCircle2, AlertCircle, ShieldCheck } from 'lucide-react';
import { useMessageDialog } from './message-dialog';
import { track } from '../analytics';

type DashboardData = {
  totalUsers: number;
  totalCredits: number;
  totalRegistrations: number;
  totalBatchSubmissions: number;
  totalRevenue: number;
  registrationsToday: number;
  registrationsThisMonth: number;
  batchStats: {
    processed: number;
    error: number;
    pending: number;
  };
  usersByCredits: Array<{
    uid: string;
    email: string | null;
    credits: number;
    superAdmin: boolean;
    createdAtMs: number | null;
  }>;
  recentOrders: Array<{
    id: string;
    amount: number;
    credits: number;
    email: string | null;
    createdAtMs: number | null;
  }>;
  extractionModel?: string;
};

export function AdminDashboard({ user, onBack }: { user: User; onBack: () => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [grantEmail, setGrantEmail] = useState('');
  const [grantCredits, setGrantCredits] = useState('100');
  const [grantSubmitting, setGrantSubmitting] = useState(false);
  const [modelInput, setModelInput] = useState('');
  const [settingsSubmitting, setSettingsSubmitting] = useState(false);
  const showMessage = useMessageDialog();

  useEffect(() => {
    if (data?.extractionModel) {
      setModelInput(data.extractionModel);
    }
  }, [data]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/dashboard', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as DashboardData & { ok?: boolean };
      setData(json);
    } catch (e) {
      setError((e as Error)?.message || 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  const fmtDate = (ms: number | null) =>
    ms == null ? '—' : new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  const fmtCurrency = (n: number) =>
    '₹' + Number(n).toLocaleString('en-IN');

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FDFDFD] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-full border-4 border-blue-200 border-t-blue-600 animate-spin" />
          <div className="text-sm font-bold uppercase tracking-widest text-slate-400">Loading dashboard…</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#FDFDFD] flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-[2.5rem] border border-red-200 bg-red-50 p-8 text-center">
          <AlertCircle size={40} className="mx-auto mb-4 text-red-500" />
          <h2 className="text-xl font-black text-slate-900 mb-2">Failed to load</h2>
          <p className="text-sm font-medium text-slate-600 mb-6">{error}</p>
          <button
            onClick={load}
            className="px-6 py-3 bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-black"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const statCards = [
    { label: 'Total Users', value: data.totalUsers.toLocaleString(), icon: Users, color: 'bg-blue-50 text-blue-600' },
    { label: 'Total Credits', value: data.totalCredits.toLocaleString(), icon: Coins, color: 'bg-amber-50 text-amber-600' },
    { label: 'Registrations', value: data.totalRegistrations.toLocaleString(), icon: FileText, color: 'bg-green-50 text-green-600' },
    { label: 'Registrations Today', value: data.registrationsToday.toLocaleString(), icon: FileText, color: 'bg-emerald-50 text-emerald-600' },
    { label: 'Registrations This Month', value: data.registrationsThisMonth.toLocaleString(), icon: FileText, color: 'bg-teal-50 text-teal-600' },
    { label: 'Batch Submissions', value: data.totalBatchSubmissions.toLocaleString(), icon: LayoutGrid, color: 'bg-purple-50 text-purple-600' },
    { label: 'Total Revenue', value: fmtCurrency(data.totalRevenue), icon: IndianRupee, color: 'bg-indigo-50 text-indigo-600' },
  ];

  return (
    <div className="min-h-screen bg-[#FDFDFD]">
      <header className="sticky top-0 z-50 border-b border-slate-200/90 bg-white/95 backdrop-blur-xl supports-[backdrop-filter]:bg-white/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-white text-[10px] font-black uppercase tracking-widest text-slate-600 hover:bg-slate-50 transition-colors active:scale-[0.98]"
            >
              <ArrowLeft size={14} />
              Back
            </button>
            <span className="text-sm sm:text-base font-black tracking-tight text-slate-900">
              Admin Dashboard
            </span>
          </div>
          <button
            onClick={load}
            className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-[10px] font-black uppercase tracking-widest text-slate-600 hover:bg-slate-50 transition-colors active:scale-[0.98]"
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map((card) => (
            <div
              key={card.label}
              className="rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${card.color}`}>
                  <card.icon size={20} />
                </div>
              </div>
              <div className="text-2xl font-black text-slate-900 tabular-nums">{card.value}</div>
              <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mt-1">{card.label}</div>
            </div>
          ))}
        </div>

        {/* Batch Stats */}
        <div className="rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm">
          <h3 className="text-sm font-black tracking-tight text-slate-900 mb-4">Batch Processing Status</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-2xl bg-green-50 border border-green-100 p-4 text-center">
              <div className="text-xl font-black text-green-700 tabular-nums">{data.batchStats.processed}</div>
              <div className="text-[10px] font-black uppercase tracking-widest text-green-600 mt-1">
                <CheckCircle2 size={12} className="inline mr-1" />
                Processed
              </div>
            </div>
            <div className="rounded-2xl bg-red-50 border border-red-100 p-4 text-center">
              <div className="text-xl font-black text-red-700 tabular-nums">{data.batchStats.error}</div>
              <div className="text-[10px] font-black uppercase tracking-widest text-red-600 mt-1">
                <AlertCircle size={12} className="inline mr-1" />
                Failed
              </div>
            </div>
            <div className="rounded-2xl bg-amber-50 border border-amber-100 p-4 text-center">
              <div className="text-xl font-black text-amber-700 tabular-nums">{data.batchStats.pending}</div>
              <div className="text-[10px] font-black uppercase tracking-widest text-amber-600 mt-1">Pending</div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Grant Credits */}
          <div className="rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
                <ShieldCheck size={20} />
              </div>
              <h3 className="text-sm font-black tracking-tight text-slate-900">Grant Credits</h3>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-[11px] font-black uppercase tracking-widest text-slate-500 mb-2">
                  Recipient email
                </label>
                <input
                  value={grantEmail}
                  onChange={(e) => setGrantEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-blue-200"
                />
              </div>
              <div>
                <label className="block text-[11px] font-black uppercase tracking-widest text-slate-500 mb-2">
                  Credits to add
                </label>
                <input
                  value={grantCredits}
                  onChange={(e) => setGrantCredits(e.target.value)}
                  inputMode="numeric"
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-blue-200"
                />
              </div>
              <button
                type="button"
                disabled={grantSubmitting}
                onClick={async () => {
                  const email = grantEmail.trim();
                  const creditsToAdd = Number.parseInt(grantCredits.trim(), 10);
                  if (!email) {
                    showMessage('Enter a recipient email.', 'Missing email');
                    return;
                  }
                  if (!Number.isFinite(creditsToAdd) || creditsToAdd < 1) {
                    showMessage('Enter a valid credits amount (integer >= 1).', 'Invalid credits');
                    return;
                  }
                  setGrantSubmitting(true);
                  try {
                    track('ve_admin_grant_attempt', { credits_to_add: creditsToAdd });
                    const token = await user.getIdToken();
                    const params = new URLSearchParams({ email, credits: String(creditsToAdd) });
                    const res = await fetch(`/api/admin/grantCredits?${params}`, {
                      method: 'GET',
                      headers: { Authorization: `Bearer ${token}` },
                    });
                    if (!res.ok) throw new Error(await res.text());
                    const result = (await res.json()) as { granted?: number; targetEmail?: string; credits?: number };
                    track('ve_admin_grant_ok', {
                      granted: Number(result.granted || 0),
                      target_balance: Number(result.credits || 0),
                    });
                    showMessage(
                      `Granted ${Number(result.granted || 0)} credits to ${result.targetEmail || email}.\nNew balance: ${Number(result.credits || 0)} credits.`,
                      'Credits granted',
                    );
                    setGrantEmail('');
                    void load();
                  } catch (e) {
                    track('ve_admin_grant_fail');
                    showMessage((e as Error)?.message || 'Failed to grant credits', 'Admin error');
                  } finally {
                    setGrantSubmitting(false);
                  }
                }}
                className="w-full rounded-2xl bg-slate-900 py-3 text-xs font-black uppercase tracking-widest text-white hover:bg-black disabled:opacity-60"
              >
                {grantSubmitting ? 'Granting…' : 'Grant Credits'}
              </button>
            </div>
          </div>

          {/* Global AI Config */}
          <div className="rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
                <LayoutGrid size={20} />
              </div>
              <h3 className="text-sm font-black tracking-tight text-slate-900">AI Model Configuration</h3>
            </div>
            <div className="space-y-4 flex flex-col justify-between h-[calc(100%-3.5rem)]">
              <div>
                <label className="block text-[11px] font-black uppercase tracking-widest text-slate-500 mb-2">
                  Active Gemini Model
                </label>
                <input
                  value={modelInput}
                  onChange={(e) => setModelInput(e.target.value)}
                  placeholder="gemini-3.1-flash-lite"
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-blue-200"
                />
                <p className="text-[10px] text-slate-400 font-medium mt-1.5 leading-relaxed">
                  Default: <span className="font-bold">gemini-3.1-flash-lite</span>. Enter any valid Gemini model name to override the default model immediately.
                </p>
              </div>
              <button
                type="button"
                disabled={settingsSubmitting}
                onClick={async () => {
                  const modelName = modelInput.trim();
                  if (!modelName) {
                    showMessage('Please enter a valid model name.', 'Invalid model');
                    return;
                  }
                  setSettingsSubmitting(true);
                  try {
                    const token = await user.getIdToken();
                    const res = await fetch('/api/admin/updateSettings', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                      },
                      body: JSON.stringify({ extractionModel: modelName }),
                    });
                    if (!res.ok) throw new Error(await res.text());
                    showMessage(
                      `Successfully updated active extraction model to: ${modelName}`,
                      'Settings updated'
                    );
                    void load();
                  } catch (e) {
                    showMessage((e as Error)?.message || 'Failed to update model settings', 'Admin error');
                  } finally {
                    setSettingsSubmitting(false);
                  }
                }}
                className="w-full rounded-2xl bg-slate-900 py-3 text-xs font-black uppercase tracking-widest text-white hover:bg-black disabled:opacity-60 mt-auto"
              >
                {settingsSubmitting ? 'Updating settings…' : 'Save Model Configuration'}
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Top Users */}
          <div className="rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm">
            <h3 className="text-sm font-black tracking-tight text-slate-900 mb-4">Top Users by Credits</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-100">
                    <th className="pb-3 pr-2">#</th>
                    <th className="pb-3 pr-2">Email</th>
                    <th className="pb-3 text-right">Credits</th>
                  </tr>
                </thead>
                <tbody>
                  {data.usersByCredits.slice(0, 20).map((u, i) => (
                    <tr key={u.uid} className="border-b border-slate-50 text-sm">
                      <td className="py-2.5 pr-2 text-slate-400 font-bold tabular-nums w-8">{i + 1}</td>
                      <td className="py-2.5 pr-2">
                        <span className="font-bold text-slate-900 truncate block max-w-[200px]">
                          {u.email || u.uid.slice(0, 12)}
                        </span>
                        {u.superAdmin && (
                          <span className="ml-1.5 text-[9px] font-black uppercase tracking-widest text-amber-600">Admin</span>
                        )}
                      </td>
                      <td className="py-2.5 text-right font-black text-slate-900 tabular-nums">{u.credits.toLocaleString()}</td>
                    </tr>
                  ))}
                  {data.usersByCredits.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-8 text-center text-sm font-medium text-slate-500">No users yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recent Purchases */}
          <div className="rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm">
            <h3 className="text-sm font-black tracking-tight text-slate-900 mb-4">Recent Credit Purchases</h3>
            {data.recentOrders.length === 0 ? (
              <div className="py-8 text-center text-sm font-medium text-slate-500">No purchases yet.</div>
            ) : (
              <ul className="space-y-2">
                {data.recentOrders.map((o) => (
                  <li key={o.id} className="rounded-2xl bg-slate-50/80 border border-slate-100 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-500 tabular-nums">{fmtDate(o.createdAtMs)}</div>
                        <div className="mt-0.5 text-sm font-bold text-slate-900 truncate">{o.email || '—'}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-black text-green-600 tabular-nums">+{o.credits}</div>
                        <div className="text-[10px] font-bold text-slate-400 tabular-nums">{o.email ? fmtCurrency(o.amount) : ''}</div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
