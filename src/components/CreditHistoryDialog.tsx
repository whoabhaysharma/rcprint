/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';
import type { User } from 'firebase/auth';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/src/components/ui/dialog';

const PAGE_SIZE = 12;

export type CreditHistoryItem = {
  id: string;
  createdAtMs: number | null;
  delta: number;
  balanceAfter: number;
  type: string | null;
  label: string;
  meta: Record<string, unknown>;
};

type PagePayload = { items: CreditHistoryItem[]; nextCursor: string | null };

export function CreditHistoryDialog({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  user: User;
}) {
  const [pages, setPages] = React.useState<PagePayload[]>([]);
  const [pageIndex, setPageIndex] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadPage = React.useCallback(
    async (startAfter: string): Promise<PagePayload> => {
      const token = await user.getIdToken();
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (startAfter) params.set('startAfter', startAfter);
      const res = await fetch(`/api/credits/history?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        items?: CreditHistoryItem[];
        nextCursor?: string | null;
      };
      return {
        items: data.items || [],
        nextCursor: data.nextCursor ?? null,
      };
    },
    [user],
  );

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setPages([]);
      setPageIndex(0);
      try {
        const first = await loadPage('');
        if (!cancelled) setPages([first]);
      } catch (e) {
        if (!cancelled) setError((e as Error)?.message || 'Failed to load history');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loadPage]);

  const current = pages[pageIndex];

  const goNext = async () => {
    if (!current?.nextCursor) return;
    if (pages[pageIndex + 1]) {
      setPageIndex((i) => i + 1);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await loadPage(current.nextCursor);
      setPages((p) => [...p, next]);
      setPageIndex((i) => i + 1);
    } catch (e) {
      setError((e as Error)?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  const goPrev = () => {
    if (pageIndex > 0) setPageIndex((i) => i - 1);
  };

  const fmtDate = (ms: number | null) =>
    ms == null ? '—' : new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:rounded-[2rem]">
        <DialogHeader className="shrink-0 border-b border-slate-100 p-6 pb-4">
          <DialogTitle className="text-xl font-black tracking-tight text-slate-900">Credit history</DialogTitle>
          <p className="pt-1 text-sm font-medium leading-relaxed text-slate-500">
            Purchases, batch AI usage, and balance changes (newest first). Only activity after this feature ships is listed.
          </p>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {error ? (
            <div className="mb-4 rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-800">{error}</div>
          ) : null}
          {loading && !current ? (
            <div className="py-12 text-center text-sm font-bold uppercase tracking-widest text-slate-400">Loading…</div>
          ) : !current || current.items.length === 0 ? (
            <div className="py-12 text-center text-sm font-medium text-slate-500">No entries yet.</div>
          ) : (
            <ul className="space-y-3">
              {current.items.map((row) => (
                <li key={row.id} className="rounded-2xl border border-slate-100 bg-slate-50/80 px-4 py-3 text-left">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-bold tabular-nums text-slate-500">{fmtDate(row.createdAtMs)}</div>
                      <div className="mt-1 text-sm font-black text-slate-900">{row.label || row.type || 'Entry'}</div>
                    </div>
                    <div
                      className={`shrink-0 text-sm font-black tabular-nums ${
                        row.delta >= 0 ? 'text-green-600' : 'text-red-600'
                      }`}
                    >
                      {row.delta >= 0 ? '+' : ''}
                      {row.delta}
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] font-bold tabular-nums text-slate-400">
                    Balance after: {Number.isFinite(row.balanceAfter) ? row.balanceAfter : '—'}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-100 bg-white p-6 pt-4">
          <button
            type="button"
            onClick={goPrev}
            disabled={pageIndex === 0 || loading}
            className="rounded-xl border border-slate-200 px-4 py-3 text-xs font-black uppercase tracking-widest text-slate-700 transition-colors disabled:opacity-40 hover:bg-slate-50"
          >
            Previous
          </button>
          <span className="text-[11px] font-black uppercase tracking-widest text-slate-400 tabular-nums">
            Page {pageIndex + 1}
          </span>
          <button
            type="button"
            onClick={() => void goNext()}
            disabled={!current?.nextCursor || loading}
            className="rounded-xl bg-slate-900 px-4 py-3 text-xs font-black uppercase tracking-widest text-white transition-colors disabled:opacity-40 hover:bg-black"
          >
            Next
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
