/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Upload, FileText, X, AlertCircle, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { storage, db } from './firebase';
import type { User as FirebaseUser } from 'firebase/auth';
import { track } from './analytics';
import { useMessageDialog } from './components/message-dialog';
import { AI_EXTRACTION_CREDIT_COST } from './constants/credits';

interface BatchUploadProps {
  user: FirebaseUser;
  credits: number;
  creditsLoading: boolean;
  onRequestCredits: () => void;
  onComplete: () => void;
}

interface FileWithPreview {
  file: File;
  id: string;
  status: 'pending' | 'uploading' | 'uploaded' | 'error';
  error?: string;
}

const MAX_FILES = 50;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export default function BatchUpload({
  user,
  credits,
  creditsLoading,
  onRequestCredits,
  onComplete,
}: BatchUploadProps) {
  const showMessage = useMessageDialog();
  const [files, setFiles] = useState<FileWithPreview[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const canUseBatch =
    !creditsLoading && credits >= AI_EXTRACTION_CREDIT_COST;

  const creditsNeededForQueue = files.length * AI_EXTRACTION_CREDIT_COST;
  const hasEnoughCreditsForQueue = credits >= creditsNeededForQueue;

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []).length;
    track('ve_batch_file_picker_change', { picked_count: picked });
    if (!canUseBatch) {
      track('ve_batch_file_select_blocked', { reason: 'no_credits' });
      showMessage(
        `Batch upload needs ${AI_EXTRACTION_CREDIT_COST} credits in balance per PDF. Each file is debited when processing starts; if extraction fails, credits are refunded automatically.`,
        'Credits required',
      );
      onRequestCredits();
      return;
    }

    const selectedFiles = Array.from(e.target.files || []);
    
    if (selectedFiles.length + files.length > MAX_FILES) {
      track('ve_batch_file_select_blocked', { reason: 'max_files' });
      showMessage(`You can only upload up to ${MAX_FILES} files at a time.`, 'Too many files');
      return;
    }

    const validFiles: FileWithPreview[] = [];
    const errors: string[] = [];

    selectedFiles.forEach((file) => {
      if (file.type !== 'application/pdf') {
        errors.push(`${file.name}: Only PDF files are allowed`);
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        errors.push(`${file.name}: File size exceeds 10MB`);
        return;
      }
      validFiles.push({
        file,
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        status: 'pending',
      });
    });

    if (validFiles.length === 0) {
      if (errors.length > 0) {
        track('ve_batch_file_select_skip', { error_lines: errors.length });
        showMessage(errors.join('\n'), 'Some files were skipped');
      }
      return;
    }

    const totalAfter = files.length + validFiles.length;
    const needed = totalAfter * AI_EXTRACTION_CREDIT_COST;
    if (credits < needed) {
      track('ve_batch_file_select_blocked', { reason: 'queue_exceeds_credits', queue_after: totalAfter });
      showMessage(
        `Each PDF needs ${AI_EXTRACTION_CREDIT_COST} credits when processing succeeds. ${totalAfter} file(s) require ${needed} credits; you have ${credits}. Remove files from the queue or buy more credits.`,
        'Insufficient credits',
      );
      onRequestCredits();
      return;
    }

    if (errors.length > 0) {
      track('ve_batch_file_select_partial', { accepted: validFiles.length, skipped_lines: errors.length });
      showMessage(errors.join('\n'), 'Some files were skipped');
    }

    track('ve_batch_files_queued', { added: validFiles.length, queue_total: totalAfter });
    setFiles((prev) => [...prev, ...validFiles]);
  };

  const removeFile = (id: string) => {
    track('ve_batch_file_remove');
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const handleUpload = async () => {
    if (files.length === 0) return;

    if (!canUseBatch || credits < files.length * AI_EXTRACTION_CREDIT_COST) {
      track('ve_batch_upload_submit_blocked', { reason: 'credits', queue: files.length });
      showMessage(
        `You need ${files.length * AI_EXTRACTION_CREDIT_COST} credits in balance for ${files.length} file(s) (${AI_EXTRACTION_CREDIT_COST} per file). You have ${credits}. Failed extractions are refunded automatically.`,
        'Insufficient credits',
      );
      onRequestCredits();
      return;
    }

    track('ve_batch_upload_submit_start', { file_count: files.length });
    setIsUploading(true);
    setUploadProgress(0);

    const batchJobRef = await addDoc(collection(db, 'batchJobs'), {
      userId: user.uid,
      userEmail: user.email,
      totalFiles: files.length,
      processedFiles: 0,
      status: 'in_progress',
      createdAt: serverTimestamp(),
    });

    let completed = 0;

    for (const fileItem of files) {
      try {
        setFiles((prev) =>
          prev.map((f) => (f.id === fileItem.id ? { ...f, status: 'uploading' } : f))
        );

        const timestamp = Date.now();
        const storageRef = ref(
          storage,
          `batch-pdfs/${user.uid}/${timestamp}-${fileItem.file.name}`
        );
        const storagePath = storageRef.fullPath;

        await uploadBytes(storageRef, fileItem.file);
        const pdfUrl = await getDownloadURL(storageRef);

        await addDoc(collection(db, 'batchSubmissions'), {
          userId: user.uid,
          userEmail: user.email,
          fileName: fileItem.file.name,
          status: 'pending',
          pdfUrl,
          storagePath,
          batchJobId: batchJobRef.id,
          createdAt: serverTimestamp(),
        });

        setFiles((prev) =>
          prev.map((f) => (f.id === fileItem.id ? { ...f, status: 'uploaded' } : f))
        );

        completed++;
        setUploadProgress(Math.round((completed / files.length) * 100));
      } catch (error: any) {
        console.error(`Error uploading ${fileItem.file.name}:`, error);
        track('ve_batch_file_upload_item_fail', { index: completed + 1 });
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileItem.id
              ? { ...f, status: 'error', error: error.message }
              : f
          )
        );
      }
    }

    setIsUploading(false);
    track('ve_batch_upload_submit_done', { file_count: files.length, ok_count: completed });
    
    setTimeout(() => {
      onComplete();
    }, 1500);
  };

  return (
    <div className="w-full min-h-[calc(100svh-3.5rem)] bg-[#FDFDFD] py-8 pb-12 px-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-black tracking-tight text-slate-900 mb-2">
            Batch Upload
          </h1>
          <p className="text-slate-500 font-medium">
            Upload up to {MAX_FILES} RC PDFs for AI processing ({AI_EXTRACTION_CREDIT_COST} credits per file; debited when processing runs, refunded if extraction fails)
          </p>
        </div>

        {creditsLoading ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm font-bold text-slate-600 mb-6">
            Loading your credit balance…
          </div>
        ) : !canUseBatch ? (
          <div className="rounded-2xl border-2 border-amber-200 bg-amber-50 px-5 py-5 mb-6">
            <p className="text-sm font-black text-slate-900 mb-2">Credits required for batch upload</p>
            <p className="text-sm font-medium text-slate-600 mb-4">
              You need at least {AI_EXTRACTION_CREDIT_COST} credits per PDF in your queue. Your balance:{' '}
              <span className="font-black tabular-nums">{credits}</span> credits.
            </p>
            <button
              type="button"
              onClick={onRequestCredits}
              className="w-full sm:w-auto px-6 py-3 rounded-xl bg-blue-600 text-white text-xs font-black uppercase tracking-widest hover:bg-blue-700"
            >
              Buy credits
            </button>
          </div>
        ) : files.length > 0 && !hasEnoughCreditsForQueue ? (
          <div className="rounded-2xl border-2 border-amber-200 bg-amber-50 px-5 py-4 mb-6 text-sm font-bold text-slate-800">
            This queue needs {creditsNeededForQueue} credits ({files.length} × {AI_EXTRACTION_CREDIT_COST}). You have {credits}.
            Remove files or buy credits before uploading.
          </div>
        ) : null}

        <div className="bg-white rounded-3xl border-2 border-slate-100 p-8 shadow-sm mb-6">
          <div className="relative">
            <input
              type="file"
              accept="application/pdf"
              multiple
              onChange={handleFileSelect}
              disabled={
                isUploading || files.length >= MAX_FILES || !canUseBatch
              }
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
            />
            <div
              className={`w-full h-48 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed transition-all ${
                isUploading || files.length >= MAX_FILES || !canUseBatch
                  ? 'border-slate-200 bg-slate-50 cursor-not-allowed'
                  : 'border-blue-300 bg-blue-50 hover:bg-blue-100'
              }`}
            >
              <Upload
                size={48}
                className={`mb-4 ${
                  isUploading || files.length >= MAX_FILES || !canUseBatch
                    ? 'text-slate-300'
                    : 'text-blue-600'
                }`}
              />
              <h3 className="text-xl font-black text-slate-900 mb-1">
                {!canUseBatch
                  ? 'Add credits to upload'
                  : files.length >= MAX_FILES
                  ? 'Maximum files reached'
                  : 'Drop PDF files here'}
              </h3>
              <p className="text-sm text-slate-500 font-medium">
                {files.length} / {MAX_FILES} files selected
              </p>
            </div>
          </div>
        </div>

        {files.length > 0 && (
          <div className="bg-white rounded-3xl border-2 border-slate-100 p-6 shadow-sm mb-6">
            <h2 className="text-lg font-black text-slate-900 mb-4">
              Selected Files ({files.length})
            </h2>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              <AnimatePresence>
                {files.map((fileItem) => (
                  <motion.div
                    key={fileItem.id}
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100"
                  >
                    <FileText
                      size={20}
                      className={`flex-shrink-0 ${
                        fileItem.status === 'uploaded'
                          ? 'text-green-600'
                          : fileItem.status === 'error'
                          ? 'text-red-600'
                          : fileItem.status === 'uploading'
                          ? 'text-blue-600'
                          : 'text-slate-400'
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-slate-900 truncate">
                        {fileItem.file.name}
                      </p>
                      <p className="text-xs text-slate-500">
                        {(fileItem.file.size / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </div>
                    {fileItem.status === 'uploaded' && (
                      <CheckCircle2 size={20} className="text-green-600 flex-shrink-0" />
                    )}
                    {fileItem.status === 'error' && (
                      <AlertCircle size={20} className="text-red-600 flex-shrink-0" />
                    )}
                    {fileItem.status === 'uploading' && (
                      <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                    )}
                    {fileItem.status === 'pending' && !isUploading && (
                      <button
                        onClick={() => removeFile(fileItem.id)}
                        className="p-1 hover:bg-slate-200 rounded-lg transition-colors flex-shrink-0"
                      >
                        <X size={16} className="text-slate-600" />
                      </button>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}

        {isUploading && (
          <div className="bg-white rounded-3xl border-2 border-slate-100 p-6 shadow-sm mb-6">
            <div className="mb-2 flex justify-between items-center">
              <span className="text-sm font-bold text-slate-900">
                Uploading files...
              </span>
              <span className="text-sm font-black text-blue-600">
                {uploadProgress}%
              </span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden">
              <motion.div
                className="h-full bg-blue-600 rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${uploadProgress}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          </div>
        )}

        <div className="flex gap-4">
          <button
            onClick={() => {
              track('ve_batch_upload_cancel_nav');
              onComplete();
            }}
            disabled={isUploading}
            className="px-8 py-4 bg-slate-100 text-slate-700 rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleUpload}
            disabled={
              files.length === 0 ||
              isUploading ||
              !canUseBatch ||
              !hasEnoughCreditsForQueue
            }
            className="flex-1 px-8 py-4 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg"
          >
            {isUploading ? 'Uploading...' : `Upload ${files.length} File${files.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
