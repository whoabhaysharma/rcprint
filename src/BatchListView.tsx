/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { collection, query, where, onSnapshot, QueryDocumentSnapshot, doc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { ref, deleteObject } from 'firebase/storage';
import { db, storage } from './firebase';
import { FileText, Clock, CheckCircle2, XCircle, Edit3, Loader, Upload, RefreshCw, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { User as FirebaseUser } from 'firebase/auth';
import type { BatchSubmission } from './types';
import { useMessageDialog } from './components/message-dialog';

const storagePathFromUrl = (pdfUrl: string | undefined): string | null => {
  if (!pdfUrl) return null;
  // Works for Firebase Storage download URLs (including emulator/prod):
  // .../o/<urlEncodedFullPath>?...
  const idx = pdfUrl.indexOf('/o/');
  if (idx === -1) return null;
  const tail = pdfUrl.slice(idx + 3);
  const encoded = tail.split('?')[0];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
};

interface BatchListViewProps {
  user: FirebaseUser;
  onSelectSubmission: (id: string) => void;
  onNewBatch: () => void;
  /** Called when a submission reaches a terminal billing state (processed) so the header can refresh balance. */
  onCreditsMaybeChanged?: () => void;
}

const statusConfig = {
  pending: {
    icon: Clock,
    label: 'Pending',
    color: 'text-slate-500',
    bgColor: 'bg-slate-100',
  },
  processing: {
    icon: Loader,
    label: 'Processing',
    color: 'text-blue-600',
    bgColor: 'bg-blue-100',
  },
  processed: {
    icon: CheckCircle2,
    label: 'Processed',
    color: 'text-green-600',
    bgColor: 'bg-green-100',
  },
  error: {
    icon: XCircle,
    label: 'Error',
    color: 'text-red-600',
    bgColor: 'bg-red-100',
  },
};

export default function BatchListView({ user, onSelectSubmission, onNewBatch, onCreditsMaybeChanged }: BatchListViewProps) {
  const showMessage = useMessageDialog();
  const [submissions, setSubmissions] = useState<(BatchSubmission & { docId: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'processing' | 'processed' | 'error'>('all');
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ submission: BatchSubmission & { docId: string } } | null>(null);
  const statusByIdRef = useRef<Record<string, string>>({});
  const onCreditsMaybeChangedRef = useRef(onCreditsMaybeChanged);
  onCreditsMaybeChangedRef.current = onCreditsMaybeChanged;

  useEffect(() => {
    const q = query(
      collection(db, 'batchSubmissions'),
      where('userId', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map((doc: QueryDocumentSnapshot) => ({
        docId: doc.id,
        ...(doc.data() as Omit<BatchSubmission, 'id'>),
        id: doc.id,
      }));
      // Sort client-side to avoid requiring a composite index in production.
      docs.sort((a, b) => {
        const aMs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const bMs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return bMs - aMs;
      });

      let shouldRefreshCredits = false;
      const ids = new Set<string>();
      for (const row of docs) {
        ids.add(row.docId);
        const prev = statusByIdRef.current[row.docId];
        if (row.status === 'processed' && prev !== 'processed') {
          shouldRefreshCredits = true;
        }
        statusByIdRef.current[row.docId] = row.status;
      }
      for (const k of Object.keys(statusByIdRef.current)) {
        if (!ids.has(k)) delete statusByIdRef.current[k];
      }

      setSubmissions(docs);
      setLoadError(null);
      setLoading(false);
      if (shouldRefreshCredits) {
        onCreditsMaybeChangedRef.current?.();
      }
    }, (err) => {
      console.error('Failed to load batch submissions:', err);
      setLoadError(err?.message || 'Failed to load submissions');
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user.uid]);

  const handleRetry = async (submissionId: string) => {
    setRetryingIds(prev => new Set(prev).add(submissionId));
    try {
      const submissionRef = doc(db, 'batchSubmissions', submissionId);
      await updateDoc(submissionRef, {
        status: 'pending',
        errorMessage: null,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error('Error retrying submission:', error);
      showMessage('Failed to retry. Please try again.', 'Retry failed');
    } finally {
      setRetryingIds(prev => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });
    }
  };

  const confirmDelete = (submission: BatchSubmission & { docId: string }) => {
    setDeleteConfirmation({ submission });
  };

  const handleDelete = async () => {
    if (!deleteConfirmation) return;
    
    const submission = deleteConfirmation.submission;
    setDeleteConfirmation(null);
    setDeletingIds(prev => new Set(prev).add(submission.docId));
    
    try {
      // Delete from Storage
      try {
        const anySubmission: any = submission as any;
        const storagePath: string | null =
          anySubmission.storagePath ||
          storagePathFromUrl(submission.pdfUrl) ||
          null;

        if (storagePath) {
          const storageRef = ref(storage, storagePath);
          await deleteObject(storageRef);
        }
      } catch (storageError) {
        console.warn('Storage file may already be deleted:', storageError);
      }

      // Delete from Firestore
      await deleteDoc(doc(db, 'batchSubmissions', submission.docId));
      
    } catch (error) {
      console.error('Error deleting submission:', error);
      showMessage('Failed to delete. Please try again.', 'Delete failed');
      setDeletingIds(prev => {
        const next = new Set(prev);
        next.delete(submission.docId);
        return next;
      });
    }
  };

  const filteredSubmissions = filter === 'all' 
    ? submissions 
    : submissions.filter((s) => s.status === filter);

  const stats = {
    total: submissions.length,
    pending: submissions.filter((s) => s.status === 'pending').length,
    processing: submissions.filter((s) => s.status === 'processing').length,
    processed: submissions.filter((s) => s.status === 'processed').length,
    error: submissions.filter((s) => s.status === 'error').length,
  };

  if (loading) {
    return (
      <div className="w-full min-h-[calc(100svh-3.5rem)] bg-[#FDFDFD] py-8 pb-12 px-6 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-500 font-bold">Loading submissions...</p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="w-full min-h-[calc(100svh-3.5rem)] bg-[#FDFDFD] py-8 pb-12 px-6 flex items-center justify-center">
        <div className="bg-white rounded-3xl border-2 border-slate-100 p-10 shadow-sm max-w-xl w-full text-center">
          <h2 className="text-2xl font-black text-slate-900 mb-3">Could not load submissions</h2>
          <p className="text-slate-600 font-medium mb-6 break-words">{loadError}</p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => {
                setLoading(true);
                setLoadError(null);
                // re-trigger useEffect by forcing a state change is unnecessary; user refresh is simplest.
                window.location.reload();
              }}
              className="px-8 py-4 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-blue-700 transition-all shadow-lg"
            >
              Reload
            </button>
            <button
              onClick={() => onNewBatch()}
              className="px-8 py-4 bg-slate-100 text-slate-700 rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-slate-200 transition-all"
            >
              New Batch
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full min-h-[calc(100svh-3.5rem)] bg-[#FDFDFD] py-8 pb-12 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 pr-2">
            <h1 className="text-4xl font-black tracking-tight text-slate-900 mb-2">
              Batch Submissions
            </h1>
            <p className="text-slate-500 font-medium">
              Manage and review your vehicle registration submissions
            </p>
          </div>
          <button
            onClick={onNewBatch}
            className="shrink-0 px-6 py-3 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-blue-700 transition-all shadow-lg flex items-center gap-2 self-start sm:self-auto"
          >
            <Upload size={16} />
            New Batch
          </button>
        </div>

        <div className="grid grid-cols-5 gap-4 mb-8">
          <button
            onClick={() => setFilter('all')}
            className={`p-4 rounded-2xl border-2 transition-all ${
              filter === 'all'
                ? 'border-blue-500 bg-blue-50'
                : 'border-slate-100 bg-white hover:border-slate-200'
            }`}
          >
            <div className="text-2xl font-black text-slate-900">{stats.total}</div>
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Total
            </div>
          </button>
          <button
            onClick={() => setFilter('pending')}
            className={`p-4 rounded-2xl border-2 transition-all ${
              filter === 'pending'
                ? 'border-slate-500 bg-slate-50'
                : 'border-slate-100 bg-white hover:border-slate-200'
            }`}
          >
            <div className="text-2xl font-black text-slate-700">{stats.pending}</div>
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Pending
            </div>
          </button>
          <button
            onClick={() => setFilter('processing')}
            className={`p-4 rounded-2xl border-2 transition-all ${
              filter === 'processing'
                ? 'border-blue-500 bg-blue-50'
                : 'border-slate-100 bg-white hover:border-slate-200'
            }`}
          >
            <div className="text-2xl font-black text-blue-600">{stats.processing}</div>
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Processing
            </div>
          </button>
          <button
            onClick={() => setFilter('processed')}
            className={`p-4 rounded-2xl border-2 transition-all ${
              filter === 'processed'
                ? 'border-green-500 bg-green-50'
                : 'border-slate-100 bg-white hover:border-slate-200'
            }`}
          >
            <div className="text-2xl font-black text-green-600">{stats.processed}</div>
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Processed
            </div>
          </button>
          <button
            onClick={() => setFilter('error')}
            className={`p-4 rounded-2xl border-2 transition-all ${
              filter === 'error'
                ? 'border-red-500 bg-red-50'
                : 'border-slate-100 bg-white hover:border-slate-200'
            }`}
          >
            <div className="text-2xl font-black text-red-600">{stats.error}</div>
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Error
            </div>
          </button>
        </div>

        {filteredSubmissions.length === 0 ? (
          <div className="bg-white rounded-3xl border-2 border-slate-100 p-16 text-center shadow-sm">
            <FileText size={64} className="text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-black text-slate-900 mb-2">
              {filter === 'all' ? 'No submissions yet' : `No ${filter} submissions`}
            </h3>
            <p className="text-slate-500 font-medium mb-6">
              {filter === 'all'
                ? 'Upload your first batch to get started'
                : `Switch to "All" to see all submissions`}
            </p>
            {filter === 'all' && (
              <button
                onClick={onNewBatch}
                className="px-8 py-4 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-blue-700 transition-all shadow-lg"
              >
                Upload Batch
              </button>
            )}
          </div>
        ) : (
          <div className="grid gap-4">
            {filteredSubmissions.map((submission) => {
              const StatusIcon = statusConfig[submission.status].icon;
              return (
                <motion.div
                  key={submission.docId}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white rounded-2xl border-2 border-slate-100 p-6 hover:border-slate-200 transition-all shadow-sm"
                >
                  <div className="flex items-start gap-4">
                    <div className={`p-3 rounded-xl ${statusConfig[submission.status].bgColor}`}>
                      <StatusIcon
                        size={24}
                        className={`${statusConfig[submission.status].color} ${
                          submission.status === 'processing' ? 'animate-spin' : ''
                        }`}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-4 mb-2">
                        <div className="flex-1 min-w-0">
                          <h3 className="text-lg font-black text-slate-900 truncate mb-1">
                            {submission.fileName}
                          </h3>
                          {submission.extractedData?.regnNo && (
                            <p className="text-sm font-bold text-blue-600">
                              {submission.extractedData.regnNo}
                            </p>
                          )}
                        </div>
                        <span
                          className={`px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider ${statusConfig[submission.status].bgColor} ${statusConfig[submission.status].color}`}
                        >
                          {statusConfig[submission.status].label}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-slate-500 font-medium mb-3">
                        <span>
                          Uploaded{' '}
                          {submission.createdAt?.toDate
                            ? submission.createdAt.toDate().toLocaleString()
                            : 'recently'}
                        </span>
                        {submission.processedAt && (
                          <span>
                            Processed{' '}
                            {submission.processedAt.toDate
                              ? submission.processedAt.toDate().toLocaleString()
                              : 'recently'}
                          </span>
                        )}
                      </div>
                      {submission.errorMessage && (
                        <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-3">
                          <p className="text-xs font-bold text-red-800">
                            {submission.errorMessage}
                          </p>
                        </div>
                      )}
                      {submission.extractedData && submission.status === 'processed' && (
                        <div className="flex gap-2 flex-wrap mb-3">
                          {submission.extractedData.regdOwner && (
                            <span className="px-2 py-1 bg-slate-100 rounded-lg text-xs font-bold text-slate-700">
                              {submission.extractedData.regdOwner}
                            </span>
                          )}
                          {submission.extractedData.manufacturer && (
                            <span className="px-2 py-1 bg-slate-100 rounded-lg text-xs font-bold text-slate-700">
                              {submission.extractedData.manufacturer}
                            </span>
                          )}
                          {submission.extractedData.modelNo && (
                            <span className="px-2 py-1 bg-slate-100 rounded-lg text-xs font-bold text-slate-700">
                              {submission.extractedData.modelNo}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="flex items-center gap-3">
                        {submission.status === 'processed' && (
                          <button
                            onClick={() => onSelectSubmission(submission.docId)}
                            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl font-black uppercase tracking-widest text-xs hover:bg-blue-700 transition-all"
                          >
                            <Edit3 size={14} />
                            Edit & Download
                          </button>
                        )}
                        {submission.status === 'error' && (
                          <button
                            onClick={() => handleRetry(submission.docId)}
                            disabled={retryingIds.has(submission.docId)}
                            className="flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-xl font-black uppercase tracking-widest text-xs hover:bg-orange-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <RefreshCw size={14} className={retryingIds.has(submission.docId) ? 'animate-spin' : ''} />
                            {retryingIds.has(submission.docId) ? 'Retrying...' : 'Retry'}
                          </button>
                        )}
                        <button
                          onClick={() => confirmDelete(submission)}
                          disabled={deletingIds.has(submission.docId)}
                          className="flex items-center gap-2 px-4 py-2 bg-red-100 text-red-700 rounded-xl font-black uppercase tracking-widest text-xs hover:bg-red-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                          title={'Delete submission'}
                        >
                          <Trash2 size={14} />
                          {deletingIds.has(submission.docId) ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      <AnimatePresence>
        {deleteConfirmation && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-slate-900/80 backdrop-blur-md flex items-center justify-center p-6"
            onClick={() => setDeleteConfirmation(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-[2.5rem] p-8 max-w-md w-full shadow-2xl"
            >
              <div className="flex items-center justify-center w-16 h-16 bg-red-100 rounded-2xl mx-auto mb-6">
                <Trash2 size={32} className="text-red-600" />
              </div>
              <h2 className="text-2xl font-black text-slate-900 mb-4 text-center">
                Delete Submission?
              </h2>
              <p className="text-slate-600 font-medium text-center mb-2">
                Are you sure you want to delete:
              </p>
              <p className="text-slate-900 font-bold text-center mb-6 px-4 py-2 bg-slate-50 rounded-xl">
                {deleteConfirmation.submission.fileName}
              </p>
              <p className="text-sm text-slate-500 font-medium text-center mb-8">
                This action cannot be undone. The PDF and all extracted data will be permanently deleted.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setDeleteConfirmation(null)}
                  className="flex-1 px-6 py-4 bg-slate-100 text-slate-700 rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-slate-200 transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  className="flex-1 px-6 py-4 bg-red-600 text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-red-700 transition-all shadow-lg"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
