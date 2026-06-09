/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { jsPDF } from 'jspdf';
import { QRCodeSVG } from 'qrcode.react';
import {
  RotateCcw, ShieldCheck, CheckCircle2, Printer,
  ZoomIn, ZoomOut, LayoutGrid, Coins, Plus, FileText, History, LogOut,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import html2canvas from 'html2canvas';
import confetti from 'canvas-confetti';
import { FirebaseError } from 'firebase/app';
import { auth, provider, db } from './firebase';
import { signInWithPopup, onAuthStateChanged, signOut, User as FirebaseUser } from 'firebase/auth';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import BatchUpload from './BatchUpload';
import BatchListView from './BatchListView';
import { CreditHistoryDialog } from './components/CreditHistoryDialog';
import { AdminDashboard } from './components/AdminDashboard';
import { useMessageDialog } from './components/message-dialog';
import { AI_EXTRACTION_CREDIT_COST } from './constants/credits';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { track, trackScreen, setAnalyticsUserId, setAnalyticsUserProps } from './analytics';


interface FormData {
  regnNo: string;
  regnDate: string;
  manufacturer: string;
  fuel: string;
  vehicleClass: string;
  bodyType: string;
  chassisNo: string;
  engineNo: string;
  modelNo: string;
  regdOwner: string;
  swdOf: string;
  address: string;
  cubicCapacity: string;
  seatCapacity: string;
  standCapacity: string;
  wheelBase: string;
  unladenWt: string;
  noOfCyc: string;
  ownerSerial: string;
  taxPaidUpTo: string;
  regdValidity: string;
  colour: string;
  rlw: string;
  issuingAuthority: string;
  purpose: string;
  hypothecatedTo: string;
  manufacturingDt: string;
}

const FORM_KEYS: Array<keyof FormData> = [
  'regnNo',
  'regnDate',
  'manufacturer',
  'fuel',
  'vehicleClass',
  'bodyType',
  'chassisNo',
  'engineNo',
  'modelNo',
  'regdOwner',
  'swdOf',
  'address',
  'cubicCapacity',
  'seatCapacity',
  'standCapacity',
  'wheelBase',
  'unladenWt',
  'noOfCyc',
  'ownerSerial',
  'taxPaidUpTo',
  'regdValidity',
  'colour',
  'rlw',
  'issuingAuthority',
  'purpose',
  'hypothecatedTo',
  'manufacturingDt',
];

const initialData: FormData = {
  regnNo: 'HR79E1420',
  regnDate: '27-11-2024',
  manufacturer: 'MAHINDRA & MAHINDRA LTD',
  fuel: 'DIESEL',
  vehicleClass: 'Motor Car',
  bodyType: 'HARD TOP',
  chassisNo: 'MAT12YZ...',
  engineNo: 'YDR4K...',
  modelNo: 'SCORPIO-N D MT 2WD Z6 7S',
  regdOwner: 'SHIL KUMAR',
  swdOf: 'MAHA SINGH',
  address: 'HOUSE NO-252 LALDAS PANARIDHAD (4-R) FARMANA KHARKHODA Sonipat HR 131408',
  cubicCapacity: '2184.00',
  seatCapacity: '7',
  standCapacity: '0',
  wheelBase: '2750',
  unladenWt: '1990',
  noOfCyc: '4',
  ownerSerial: '01',
  taxPaidUpTo: '10/2024',
  regdValidity: '26-11-2039',
  colour: 'D.SILVER',
  rlw: '2570',
  issuingAuthority: 'SDM KHARKHONDA',
  purpose: 'PERSONAL',
  hypothecatedTo: 'AXIS BANK LTD',
  manufacturingDt: '10/2024',
};

type AppView = 'mode-selection' | 'form' | 'preview' | 'success' | 'batch-upload' | 'batch-list' | 'admin-dashboard';

type RcDataSource = 'manual' | 'ai';


const AUTH_NETWORK_USER_MSG =
  'Could not reach Google sign-in (network). Check your internet connection, try another network or device, and pause VPN or extensions that block Google. For local development, only set VITE_USE_FIREBASE_EMULATORS=true when Firebase emulators are running.';

function userFacingAuthOrNetworkError(err: unknown): string {
  if (err instanceof FirebaseError && err.code === 'auth/network-request-failed') {
    return AUTH_NETWORK_USER_MSG;
  }
  if (err instanceof Error && err.message.includes('auth/network-request-failed')) {
    return AUTH_NETWORK_USER_MSG;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

const CARD_WIDTH_MM = 85.6;
const CARD_HEIGHT_MM = 53.98;
const CARD_ASPECT = CARD_WIDTH_MM / CARD_HEIGHT_MM;
const LAYOUT_STORAGE_KEY = 'rc_calibration_layout';
const TEMPLATE_STORAGE_KEY = 'rc_global_template_layout';
/** Mfg date + regd validity: toward mockup labels (card inches). */
const MFG_VALIDITY_X_NUDGE_IN = -0.028;
const MFG_VALIDITY_Y_NUDGE_IN = 0.018;
/** Small downward nudges to better align with background scan (card inches). */
const REGD_VALIDITY_Y_EXTRA_IN = 0.05;
const AUTHORITY_Y_EXTRA_IN = 0.05;
/** ~1 cm extra to the right for "As per Fitness" vs prior long-text anchor (inches on card). */
const REGD_VALIDITY_LONG_TEXT_X = 2.58 + 1 / 2.54 + MFG_VALIDITY_X_NUDGE_IN;
/** Points smaller than the field's resolved font size for long "As per Fitness" text. */
const REGD_VALIDITY_LONG_FONT_SUB_PT = 0.75;
/** Seat/stand/cyl/serial + unladen/CC/wheelbase/RLW vs mockup (card inches). */
const SPEC_GRID_X_NUDGE_IN = -0.028;
const SPEC_GRID_Y_NUDGE_IN = 0.018;
/** Shift value text down vs grey mockup labels (card inches). */
const MAIN_VALUE_Y_NUDGE_IN = 0.017;
/** QR block slight right nudge on card (inches). */
const QR_X_NUDGE_IN = 2 / 25.4;
/** QR block slight upward nudge on card (inches). Shifted 1.5mm upwards. */
const QR_Y_NUDGE_IN = -1.5 / 25.4;
/** QR plate ~4.5% smaller, centered in prior box. */
const QR_LAYOUT_BASE = { x: 0.0553, y: 1.0935 + QR_Y_NUDGE_IN, w: 0.9894, h: 0.905 } as const;
/** QR render scale: anchored bottom-left, grows to top-right. */
const QR_SCALE = 1.03;
/** Shift left-aligned values ~2mm to the right to avoid overlapping labels (2mm = 0.078 inches) */
const LEFT_VALUES_X_SHIFT_IN = 0.078;
/** Shift left-aligned values ~1.5mm down (1.5mm = 0.059 inches) */
const LEFT_VALUES_Y_SHIFT_IN = 0.059;
const DEFAULT_TEMPLATE_LAYOUT: Record<string, Partial<{ x: number; y: number; w: number; h: number; fontSize: number; bold: boolean }>> = {
  regnNo: { x: 0.5831, y: 0.0709, w: 0.8292, h: 0.1301, fontSize: 5 },
  regdOwner: { x: 0.5807, y: 0.152, fontSize: 5 },
  swdOf: { x: 0.5719, y: 0.244, fontSize: 5 },
  regnDate: { x: 0.58, y: 0.4264, fontSize: 5 },
  colour: { x: 0.5788, y: 0.4908, fontSize: 5 },
  fuel: { x: 0.5789, y: 0.5676, fontSize: 5 },
  vehicleClass: { x: 0.5858, y: 0.6374, fontSize: 5 },
  bodyType: { x: 0.5839, y: 0.7158, fontSize: 5 },
  manufacturer: { x: 0.5914, y: 0.7834, fontSize: 5 },
  chassisNo: { x: 0.5914, y: 0.854, fontSize: 5 },
  engineNo: { x: 0.5914, y: 0.9427, fontSize: 5 },
  modelNo: { x: 0.5914, y: 1.0194, fontSize: 5 },
  manufacturingDt: { x: 1.9244, y: 0.4081, fontSize: 5 },
  seatCapacity: { x: 1.7591, y: 1.314, fontSize: 5 },
  standCapacity: { x: 1.761, y: 1.4024, fontSize: 5 },
  noOfCyc: { x: 2.372, y: 1.326, fontSize: 5 },
  ownerSerial: { x: 2.3709, y: 1.4085, fontSize: 5 },
  unladenWt: { x: 3.0046, y: 1.1784, w: 0.3081, h: 0.0841, fontSize: 5 },
  cubicCapacity: { x: 3.0112, y: 1.2714, w: 0.2904, h: 0.0843, fontSize: 5 },
  wheelBase: { x: 3.0106, y: 1.3509, w: 0.2549, h: 0.0872, fontSize: 5 },
  rlw: { x: 3.007, y: 1.4306, w: 0.3271, h: 0.0992, fontSize: 5 },
  hypothecatedTo: { x: 1.7503, y: 1.1507, w: 0.822, h: 0.135, fontSize: 5 },
  address: { x: 1.4946, y: 1.602, fontSize: 5 },
  issuingAuthority: { x: 1.4993, y: 1.9363, fontSize: 5 },
  qrCode: { x: 0.1088, y: 1.125 + QR_Y_NUDGE_IN, w: 1.0336, h: 1.0337 },
  regdValidity: { x: 2.89, y: 0.4012, w: 0.4397, h: 0.132, fontSize: 5 },
  signature: { x: 2.6655, y: 1.9129, w: 0.8, h: 0.12 },
};

/** Preview / print: wrap hypothecation into lines for the card overlay (display-only). */
const HYPO_CHARS_PER_LINE = 13;

/**
 * Display-only wrapping for the card. Does NOT trim/normalize/clamp the underlying value.
 * Preserves existing line breaks and additionally wraps long lines every HYPO_CHARS_PER_LINE chars.
 */
const hypothecatedValueForCard = (raw: string): string => {
  if (!raw) return '';
  const parts = String(raw).split(/\r?\n/);
  const out: string[] = [];
  for (const p of parts) {
    if (p.length <= HYPO_CHARS_PER_LINE) {
      out.push(p);
      continue;
    }
    for (let i = 0; i < p.length; i += HYPO_CHARS_PER_LINE) {
      out.push(p.slice(i, i + HYPO_CHARS_PER_LINE));
    }
  }
  return out.join('\n');
};

export default function App() {
  // ── ALL hooks must be declared before any conditional return ──
  const showMessage = useMessageDialog();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [formData, setFormData] = useState<FormData>(initialData);
  const [view, setView] = useState<AppView>('mode-selection');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [credits, setCredits] = useState<number>(0);
  const [creditsLoading, setCreditsLoading] = useState(false);
  const [showPlans, setShowPlans] = useState(false);
  const [creditHistoryOpen, setCreditHistoryOpen] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [verifyingPayment, setVerifyingPayment] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [isLayoutEditing, setIsLayoutEditing] = useState(false);
  const [layoutResetTick, setLayoutResetTick] = useState(0);
  const [templateSaveTick, setTemplateSaveTick] = useState(0);
  const [templateSaved, setTemplateSaved] = useState(false);
  const [selectedBatchSubmissionId, setSelectedBatchSubmissionId] = useState<string | null>(null);
  const [isBatchEditMode, setIsBatchEditMode] = useState(false);
  /** manual = user typed data (free PDF/print); ai = extraction or batch (billed on server). */
  const [rcDataSource, setRcDataSource] = useState<RcDataSource>('manual');

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
      if (!u) {
        setCreditHistoryOpen(false);
        setShowPlans(false);
      }
    });
    return unsub;
  }, []);

  const refreshCredits = async (u: FirebaseUser | null) => {
    if (!u) {
      setCredits(0);
      return;
    }
    setCreditsLoading(true);
    try {
      const token = await u.getIdToken();
      const res = await fetch('/api/credits/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setCredits(Number(data?.credits || 0) || 0);
    } catch (e) {
      console.warn('Failed to refresh credits', e);
      setCredits(0);
    } finally {
      setCreditsLoading(false);
    }
  };

  useEffect(() => {
    void refreshCredits(user);
  }, [user]);

  const refreshAdminStatus = async (u: FirebaseUser | null) => {
    if (!u) {
      setIsSuperAdmin(false);
      return;
    }
    try {
      const token = await u.getIdToken();
      const res = await fetch('/api/admin/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { superAdmin?: boolean };
      setIsSuperAdmin(data.superAdmin === true);
    } catch (e) {
      console.warn('Failed to refresh admin status', e);
      setIsSuperAdmin(false);
    }
  };

  useEffect(() => {
    void refreshAdminStatus(user);
  }, [user]);

  useEffect(() => {
    const el = document.documentElement;
    if (view === 'form' || view === 'preview') {
      el.dataset.printPolicy = rcDataSource === 'manual' ? 'manual-free' : 'ai-guard';
    } else {
      delete el.dataset.printPolicy;
    }
    return () => {
      delete el.dataset.printPolicy;
    };
  }, [view, rcDataSource]);

  useEffect(() => {
    setAnalyticsUserId(user?.uid ?? null);
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) return;
    setAnalyticsUserProps({ super_admin: isSuperAdmin ? 'true' : 'false' });
  }, [user?.uid, isSuperAdmin]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      trackScreen('ve_sign_in');
      return;
    }
    if (view === 'admin-dashboard') {
      trackScreen('ve_admin_dashboard');
    } else if (view === 'form' || view === 'preview') {
      trackScreen('ve_rc_workspace', {
        workspace_phase: view,
        rc_data_source: rcDataSource,
        batch_edit: isBatchEditMode,
      });
    } else if (view === 'mode-selection') {
      trackScreen('ve_mode_selection');
    } else if (view === 'batch-upload') {
      trackScreen('ve_batch_upload');
    } else if (view === 'batch-list') {
      trackScreen('ve_batch_list');
    } else if (view === 'success') {
      trackScreen('ve_flow_success', { batch_edit: isBatchEditMode });
    }
  }, [authLoading, user?.uid, view, rcDataSource, isBatchEditMode]);

  useEffect(() => {
    if (!user?.uid || creditsLoading) return;
    track('ve_credits_balance', { credits: Math.min(credits, 99999) });
  }, [user?.uid, credits, creditsLoading]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!user?.uid) return;
      track('ve_preview_zoom', { zoom_pct: Math.round(zoom * 100) });
    }, 900);
    return () => window.clearTimeout(t);
  }, [zoom, user?.uid]);

  const layoutEditWasOn = useRef(false);
  useEffect(() => {
    if (!user?.uid) return;
    if (isLayoutEditing && !layoutEditWasOn.current) {
      track('ve_layout_edit_on');
      layoutEditWasOn.current = true;
    } else if (!isLayoutEditing && layoutEditWasOn.current) {
      track('ve_layout_edit_off');
      layoutEditWasOn.current = false;
    }
  }, [isLayoutEditing, user?.uid]);

  // ── Now safe to do conditional renders ──
  const goToBatchUpload = () => {
    track('ve_batch_upload_entry_click');
    if (creditsLoading) return;
    if (credits < AI_EXTRACTION_CREDIT_COST) {
      track('ve_batch_upload_blocked', { reason: 'low_credits' });
      showMessage(
        `Batch AI uses ${AI_EXTRACTION_CREDIT_COST} credits per PDF (debited when each file is processed; you are refunded if extraction fails). Purchase credits to continue.`,
        'Insufficient credits',
      );
      track('ve_plans_open_click', { from: 'batch_go_low_credits' });
      setShowPlans(true);
      return;
    }
    setView('batch-upload');
  };



  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleFormFieldBlur = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const name = e.target.name;
    if (!name) return;
    const len = (e.target.value || '').trim().length;
    track('ve_form_field_blur', { field: String(name).slice(0, 40), value_len: len });
  };

  const handleSignatureChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      track('ve_signature_file_chosen', {
        mime: (file.type || 'unknown').slice(0, 40),
        size_kb: Math.min(Math.round(file.size / 1024), 99999),
      });
      const reader = new FileReader();
      reader.onloadend = () => setSignature(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  const loadBatchSubmission = async (submissionId: string) => {
    track('ve_batch_submission_load_start', { id_len: submissionId.length });
    try {
      const docRef = doc(db, 'batchSubmissions', submissionId);
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.extractedData) {
          setFormData({ ...initialData, ...data.extractedData });
        }
        setSelectedBatchSubmissionId(submissionId);
        setIsBatchEditMode(true);
        setRcDataSource('ai');
        setView('preview');
        void refreshCredits(user);
        track('ve_batch_submission_load_ok', { has_extracted: Boolean(data.extractedData) });
      } else {
        track('ve_batch_submission_load_fail', { reason: 'missing_doc' });
      }
    } catch (error) {
      console.error('Error loading batch submission:', error);
      track('ve_batch_submission_load_fail', { reason: 'exception' });
      showMessage('Failed to load submission data.', 'Error');
    }
  };

  /**
   * Renders the RC card to PDF, downloads it, and persists a record to Firestore.
   * Returns `true` only if every step succeeds.
   */
  const generatePDF = async (): Promise<boolean> => {
    track('ve_pdf_gen_start', { batch_edit: isBatchEditMode, rc_data_source: rcDataSource });
    setIsGenerating(true);
    let originalStyle: string | null = null;
    let element: HTMLElement | null = null;
    try {
      element = document.getElementById('rc-a4-print');
      if (!element) {
        console.error('PDF target element not found');
        track('ve_pdf_gen_fail', { reason: 'no_dom' });
        return false;
      }

      originalStyle = element.style.cssText;
      element.style.cssText = 'position:fixed; top:0; left:0; width:210mm; height:297mm; z-index:-1; display:block; background:white;';

      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        width: 794,  // ~210mm @ 96dpi
        height: 1123 // ~297mm @ 96dpi
      });

      element.style.cssText = originalStyle;
      originalStyle = null;

      const imgData = canvas.toDataURL('image/png');
      const pdfDoc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      pdfDoc.addImage(imgData, 'PNG', 0, 0, 210, 297);
      pdfDoc.save(`RC_${formData.regnNo || 'Vehicle'}.pdf`);

      if (isBatchEditMode && selectedBatchSubmissionId) {
        const submissionRef = doc(db, 'batchSubmissions', selectedBatchSubmissionId);
        await updateDoc(submissionRef, {
          extractedData: formData,
          updatedAt: serverTimestamp(),
        });
        await addDoc(collection(db, 'registrations'), {
          ...formData,
          userId: user!.uid,
          userEmail: user!.email,
          batchSubmissionId: selectedBatchSubmissionId,
          createdAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, 'registrations'), {
          ...formData,
          userId: user!.uid,
          userEmail: user!.email,
          createdAt: serverTimestamp(),
        });
      }

      track('ve_pdf_gen_success', { batch_edit: isBatchEditMode });
      return true;
    } catch (error) {
      console.error('PDF error:', error);
      track('ve_pdf_gen_fail', { reason: 'exception' });
      return false;
    } finally {
      // Always restore the off-screen styling so a retry can run cleanly.
      if (element && originalStyle !== null) {
        element.style.cssText = originalStyle;
      }
      setIsGenerating(false);
    }
  };

  const payAndDownload = async () => {
    if (isPaying || isGenerating) return;
    if (!user) return;

    track('ve_download_pdf_click', { batch_edit: isBatchEditMode, rc_data_source: rcDataSource });
    setIsPaying(true);
    try {
      const ok = await generatePDF();
      if (!ok) {
        showMessage('PDF generation failed. Please try again.', 'Generation failed');
        return;
      }
      track('ve_download_pdf_success');
      setView('success');
      confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
      void refreshCredits(user);
    } finally {
      setIsPaying(false);
    }
  };

  /**
   * Opens a hidden iframe with the A4 RC layout and triggers `window.print()`.
   * Manual entry: free. AI session: still free here — credits were billed on extraction.
   */
  const triggerPrintIframe = (): boolean => {
    const printEl = document.getElementById('rc-a4-print');
    if (!printEl) return false;
    let stylesHtml = '';
    for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      stylesHtml += node.outerHTML;
    }
    const printIframe = document.createElement('iframe');
    printIframe.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:0;height:0;';
    document.body.appendChild(printIframe);
    const iframeDoc = printIframe.contentWindow?.document;
    if (!iframeDoc) {
      if (document.body.contains(printIframe)) document.body.removeChild(printIframe);
      return false;
    }
    iframeDoc.open();
    iframeDoc.write(`<!DOCTYPE html><html><head>${stylesHtml}<style>
      @page { size: A4 portrait; margin: 0; }
      body { margin: 0; padding: 0; background: white; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      #rc-a4-print {
        position: relative !important;
        left: 0 !important;
        top: 0 !important;
        width: 210mm !important;
        height: 297mm !important;
        display: block !important;
        overflow: hidden;
      }
      .a4-field { position: absolute !important; white-space: nowrap; }
    </style></head><body>${printEl.outerHTML}</body></html>`);
    iframeDoc.close();
    setTimeout(() => {
      printIframe.contentWindow?.focus();
      printIframe.contentWindow?.print();
      setTimeout(() => { if (document.body.contains(printIframe)) document.body.removeChild(printIframe); }, 2000);
    }, 600);
    return true;
  };

  const payAndPrint = async () => {
    if (isPaying || isGenerating) return;
    if (!user) return;

    track('ve_print_click', { rc_data_source: rcDataSource, batch_edit: isBatchEditMode });
    setIsPaying(true);
    try {
      const ok = triggerPrintIframe();
      if (!ok) {
        track('ve_print_fail', { reason: 'iframe' });
        showMessage('Print failed to open. Please try again.', 'Print failed');
      } else {
        track('ve_print_dialog_opened');
      }
    } finally {
      setIsPaying(false);
    }
  };

  const [rechargeAmount, setRechargeAmount] = useState('100');

  const rechargeAmountError = React.useMemo(() => {
    const amt = Number(rechargeAmount);
    if (!rechargeAmount.trim()) return null;
    if (!Number.isFinite(amt)) return 'Enter a valid number';
    if (amt < 50) return 'Minimum ₹50';
    if (amt > 2000) return 'Maximum ₹2000';
    if (amt % 10 !== 0) return 'Must be a multiple of ₹10';
    return null;
  }, [rechargeAmount]);

  const startCreditsPurchase = async () => {
    if (isPaying || isGenerating) return;
    if (!user) return;
    const amt = Number(rechargeAmount);
    if (!Number.isFinite(amt) || amt < 50 || amt > 2000 || amt % 10 !== 0) return;

    track('ve_credit_checkout_start', { amount: amt, view });
    setIsPaying(true);
    try {
      let token: string;
      try {
        token = await user.getIdToken(true);
      } catch (e) {
        showMessage(userFacingAuthOrNetworkError(e), 'Sign-in');
        return;
      }

      const orderRes = await fetch('/api/razorpay/createOrder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          amountInr: amt,
          notes: {
            regnNo: formData.regnNo || '',
            userEmail: user?.email || '',
          },
        }),
      });
      if (!orderRes.ok) throw new Error(await orderRes.text());
      const { order, keyId } = await orderRes.json();

      const RazorpayCtor = (window as any).Razorpay;
      if (!RazorpayCtor) throw new Error('Razorpay checkout script not loaded');

      await new Promise<void>((resolve, reject) => {
        const rzp = new RazorpayCtor({
          key: keyId,
          amount: order.amount,
          currency: order.currency,
          name: 'Vehicle Enrollment',
          description: `₹${amt} — ${amt} credits`,
          order_id: order.id,
          prefill: {
            name: user?.displayName || '',
            email: user?.email || '',
          },
          notes: order.notes || undefined,
          theme: { color: '#2563eb' },
          handler: async (response: any) => {
            setVerifyingPayment(true);
            try {
              let verifyToken: string;
              try {
                verifyToken = await user.getIdToken(true);
              } catch (e) {
                setVerifyingPayment(false);
                reject(new Error(userFacingAuthOrNetworkError(e)));
                return;
              }
              const verifyRes = await fetch('/api/razorpay/verifyPayment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${verifyToken}` },
                body: JSON.stringify(response),
              });
              if (!verifyRes.ok) throw new Error(await verifyRes.text());
              const data = await verifyRes.json();
              if (!data?.ok) throw new Error(data?.error || 'Payment verification failed');
              track('ve_credit_purchase_success', {
                amount: amt,
                credits_after: Number(data?.credits || 0) || 0,
              });
              setCredits(Number(data?.credits || 0) || 0);
              void refreshCredits(user);
              setVerifyingPayment(false);
              resolve();
            } catch (e) {
              setVerifyingPayment(false);
              reject(e);
            }
          },
          modal: {
            ondismiss: () => {
              track('ve_credit_checkout_dismiss');
              reject(new Error('Payment cancelled'));
            },
          },
        });

        rzp.on('payment.failed', (err: any) => {
          track('ve_credit_payment_failed', {
            desc: String(err?.error?.description || 'unknown').slice(0, 80),
          });
          reject(new Error(err?.error?.description || 'Payment failed'));
        });

        rzp.open();
      });
    } catch (error) {
      console.error('Payment error:', error);
      track('ve_credit_checkout_error', {
        msg: userFacingAuthOrNetworkError(error).slice(0, 80),
      });
      showMessage(userFacingAuthOrNetworkError(error), 'Payment');
    } finally {
      setIsPaying(false);
      setShowPlans(false);
    }
  };

  if (authLoading) return <div className="min-h-screen bg-[#FDFDFD] flex items-center justify-center text-slate-400 font-bold uppercase tracking-widest text-sm">Loading Identity...</div>;

  if (!user) {
    return (
      <div className="min-h-screen bg-[#FDFDFD] flex flex-col items-center justify-center p-6">
        <div className="w-20 h-20 bg-blue-50 text-blue-600 rounded-3xl flex items-center justify-center mb-8 shadow-[0_20px_40px_-10px_rgba(37,99,235,0.2)]">
          <ShieldCheck size={40} />
        </div>
        <h1 className="text-4xl font-black mb-4 text-slate-900 tracking-tight">Identity Required</h1>
        <p className="text-slate-500 mb-10 max-w-sm text-center font-medium leading-relaxed">Securely authorize your account to manage official vehicle registrations.</p>
        <button
          onClick={() => {
            track('ve_auth_google_click');
            void signInWithPopup(auth, provider)
              .then(() => {
                track('login', { method: 'google' });
              })
              .catch((e) => {
                track('ve_auth_fail', {
                  code: e instanceof FirebaseError ? e.code : 'unknown',
                });
              });
          }}
          className="px-8 py-5 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-[0.2em] text-[11px] hover:bg-blue-700 transition-all shadow-xl shadow-blue-500/20 active:scale-95 flex items-center gap-3"
        >
          Authorize with Google
        </button>
      </div>
    );
  }

  return (
    <>
      <AnimatePresence>
        {showPlans && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] bg-slate-900/80 backdrop-blur-md flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.98, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.98, y: 10 }}
              className="bg-white rounded-[2.5rem] p-8 max-w-lg w-full shadow-2xl"
            >
              <div className="flex items-start justify-between gap-6 mb-6">
                <div>
                  <h2 className="text-2xl font-black text-slate-900">Buy Credits</h2>
                  <p className="text-slate-500 font-medium mt-2 text-sm">
                    <span className="font-black text-slate-900">Manual entry</span> includes free PDF download and print.
                    {' '}
                    <span className="font-black text-slate-900">Batch AI</span> uses{' '}
                    <span className="font-black text-slate-900">{AI_EXTRACTION_CREDIT_COST} credits</span> per document (debited when extraction runs; refunded automatically if it fails).
                  </p>
                </div>
                <button
                  onClick={() => {
                    track('ve_plans_modal_close');
                    setShowPlans(false);
                  }}
                  className="w-10 h-10 rounded-2xl bg-slate-50 text-slate-500 font-black hover:bg-slate-100"
                  disabled={isPaying}
                  title="Close"
                >
                  ×
                </button>
              </div>

              {verifyingPayment ? (
                <div className="flex flex-col items-center justify-center py-12 space-y-4">
                  <div className="w-12 h-12 rounded-full border-4 border-blue-200 border-t-blue-600 animate-spin" />
                  <p className="text-lg font-black text-slate-900">Verifying payment…</p>
                  <p className="text-sm font-bold text-amber-700 text-center max-w-xs">
                    Do not close this page or navigate away while we confirm your payment.
                  </p>
                </div>
              ) : (
                <div className="space-y-5">
                  <div>
                    <label className="block text-[11px] font-black uppercase tracking-widest text-slate-500 mb-2">
                      Amount (₹)
                    </label>
                    <input
                      value={rechargeAmount}
                      onChange={(e) => setRechargeAmount(e.target.value)}
                      inputMode="numeric"
                      min={50}
                      max={2000}
                      step={10}
                      disabled={isPaying}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-lg font-black text-slate-900 outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-60 tabular-nums"
                    />
                    <p className="mt-2 text-xs font-bold text-slate-400">
                      ₹1 = 1 credit · ₹50–₹2,000 · multiples of ₹10
                    </p>
                    {rechargeAmountError ? (
                      <p className="mt-1 text-xs font-bold text-amber-700">{rechargeAmountError}</p>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      track('ve_credit_checkout_click', { amount: Number(rechargeAmount) });
                      void startCreditsPurchase();
                    }}
                    disabled={isPaying || !!rechargeAmountError || !rechargeAmount.trim()}
                    className="w-full rounded-2xl bg-blue-600 py-4 text-sm font-black uppercase tracking-widest text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-600/20"
                  >
                    {isPaying ? 'Processing…' : `Pay ₹${Number(rechargeAmount) || 0}`}
                  </button>
                </div>
              )}

              <div className="mt-6 rounded-2xl bg-slate-50 border border-slate-100 p-4">
                <div className="flex items-center justify-between text-sm font-bold text-slate-600">
                  <span>Current balance</span>
                  <span className="tabular-nums">{creditsLoading ? '...' : `${credits} credits`}</span>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <CreditHistoryDialog open={creditHistoryOpen} onOpenChange={setCreditHistoryOpen} user={user} />

      {view !== 'admin-dashboard' && (
      <header
        className="sticky top-0 z-[60] shrink-0 no-print border-b border-slate-200/90 bg-white/95 backdrop-blur-xl supports-[backdrop-filter]:bg-white/80"
        role="banner"
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="min-w-0 flex items-baseline gap-2">
            <span className="text-sm sm:text-base font-black tracking-tight text-slate-900 truncate">
              Vehicle Enrollment
            </span>
            {view === 'form' || view === 'preview' ? (
              <span className="hidden sm:inline text-[10px] font-bold uppercase tracking-widest text-slate-400 truncate">
                {isBatchEditMode ? 'Batch edit' : rcDataSource === 'manual' ? 'Manual' : 'AI'}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div
              className={`flex items-center gap-2 sm:gap-2.5 pl-2.5 sm:pl-3 pr-2 py-1.5 rounded-xl border bg-slate-50/80 ${
                credits < AI_EXTRACTION_CREDIT_COST
                  ? 'border-amber-200 ring-1 ring-amber-100/80'
                  : 'border-slate-200/80'
              }`}
              title={credits > 0 ? `${credits} credits — batch AI processing` : 'Buy credits for batch AI'}
            >
              <span
                className={`flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-lg ${
                  credits < AI_EXTRACTION_CREDIT_COST ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'
                }`}
              >
                <Coins size={16} />
              </span>
              <div className="flex flex-col items-start leading-none pr-1">
                <span className="text-[8px] font-black uppercase tracking-[0.2em] text-slate-400">
                  Credits
                </span>
                <span className="text-xs sm:text-sm font-black text-slate-900 tabular-nums mt-0.5">
                  {creditsLoading ? '…' : credits.toLocaleString()}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                track('ve_credit_history_open_click');
                setCreditHistoryOpen(true);
              }}
              className="flex items-center gap-1.5 px-2.5 sm:px-3 py-2 rounded-xl border border-slate-200 bg-white text-[10px] sm:text-[11px] font-black uppercase tracking-widest text-slate-600 hover:bg-slate-50 transition-colors active:scale-[0.98]"
              title="Credit history"
            >
              <History size={14} className="shrink-0" />
              <span className="max-[380px]:sr-only">History</span>
            </button>
            {isSuperAdmin ? (
              <button
                type="button"
                onClick={() => {
                  track('ve_admin_panel_open');
                  setView('admin-dashboard');
                }}
                className="flex items-center gap-1.5 px-2.5 sm:px-3 py-2 rounded-xl border border-slate-200 bg-white text-[10px] sm:text-[11px] font-black uppercase tracking-widest text-slate-600 hover:bg-slate-50 transition-colors active:scale-[0.98]"
                title="Admin dashboard"
              >
                <ShieldCheck size={14} className="shrink-0" />
                <span className="max-[380px]:sr-only">Admin</span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                track('ve_plans_open_click', { from: 'header_buy' });
                setShowPlans(true);
              }}
              className="flex items-center gap-1 px-3 sm:px-4 py-2 rounded-xl bg-blue-600 text-white text-[10px] sm:text-[11px] font-black uppercase tracking-widest hover:bg-blue-700 transition-colors active:scale-[0.98] shadow-sm shadow-blue-600/20"
            >
              <Plus size={12} strokeWidth={3} />
              Buy
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  track('ve_auth_logout_click');
                  await signOut(auth);
                  track('ve_auth_logout_ok');
                } catch (e) {
                  track('ve_auth_logout_fail');
                  showMessage((e as Error)?.message || 'Failed to log out', 'Logout');
                }
              }}
              className="flex items-center gap-1.5 px-2.5 sm:px-3 py-2 rounded-xl border border-slate-200 bg-white text-[10px] sm:text-[11px] font-black uppercase tracking-widest text-slate-600 hover:bg-slate-50 transition-colors active:scale-[0.98]"
              title="Log out"
            >
              <LogOut size={14} className="shrink-0" />
              <span className="max-[380px]:sr-only">Logout</span>
            </button>
          </div>
        </div>
      </header>
      )}

      <div className="w-full relative flex-1 min-h-0 flex flex-col">
        <AnimatePresence mode="wait">
            {view === 'admin-dashboard' ? (
              <AdminDashboard key="admin" user={user!} onBack={() => setView('mode-selection')} />
            ) : view === 'mode-selection' ? (
            <motion.div key="selection" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-5xl mx-auto space-y-12 py-12 sm:py-16 px-6">
              <div className="text-center space-y-4">
                <h1 className="text-5xl font-black tracking-tight text-slate-900">Vehicle Enrollment</h1>
                <p className="text-slate-400 font-medium text-lg leading-relaxed text-center mx-auto max-w-md">
                  Batch AI extraction for many PDFs, or enter one RC by hand — free download and print.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-3xl mx-auto">
                <button
                  type="button"
                  onClick={() => {
                    track('ve_mode_select', { mode: 'batch_list' });
                    setView('batch-list');
                  }}
                  className="relative h-[300px] group text-left"
                >
                  <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center rounded-[2.5rem] border-[3px] border-dashed border-green-200 bg-green-50 group-hover:bg-green-100 transition-all">
                    <LayoutGrid size={40} className="text-green-600 mb-4" />
                    <h3 className="text-xl font-black text-slate-900 mb-2">Batch processing</h3>
                    <p className="text-sm text-slate-500 font-medium">AI on multiple PDFs (per file; failures refunded)</p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    track('ve_mode_select', { mode: 'manual_entry' });
                    setRcDataSource('manual');
                    setFormData(initialData);
                    setSignature(null);
                    setView('form');
                  }}
                  className="relative h-[300px] group text-left"
                >
                  <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center rounded-[2.5rem] border-[3px] border-dashed border-slate-200 bg-slate-50 group-hover:bg-slate-100 transition-all">
                    <FileText size={40} className="text-slate-600 mb-4" />
                    <h3 className="text-xl font-black text-slate-900 mb-2">Manual entry</h3>
                    <p className="text-sm text-slate-500 font-medium">Type details yourself — free PDF and print</p>
                  </div>
                </button>
              </div>
            </motion.div>
          ) : view === 'batch-upload' ? (
            <BatchUpload
              user={user!}
              credits={credits}
              creditsLoading={creditsLoading}
              onRequestCredits={() => {
                track('ve_plans_open_click', { from: 'batch_upload' });
                setShowPlans(true);
              }}
              onComplete={() => setView('batch-list')}
            />
          ) : view === 'batch-list' ? (
            <BatchListView 
              user={user!} 
              onSelectSubmission={(id) => loadBatchSubmission(id)}
              onNewBatch={goToBatchUpload}
              onCreditsMaybeChanged={() => void refreshCredits(user)}
            />
          ) : view === 'form' || view === 'preview' ? (
            <motion.div key="workspace" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col lg:flex-row h-[calc(100svh-3.5rem)] min-h-0 overflow-hidden bg-[#FBFBFC]">
              <div className="lg:w-[460px] w-full h-full overflow-y-auto bg-white border-r border-slate-100 p-8 space-y-12 pb-44 no-print custom-scrollbar">
                <div className="flex items-center justify-between sticky top-0 bg-white/95 backdrop-blur-xl z-50 py-4 -translate-y-4 border-b border-slate-50">
                  <button 
                    onClick={() => {
                      track('ve_workspace_back', { batch_edit: isBatchEditMode });
                      if (isBatchEditMode) {
                        setIsBatchEditMode(false);
                        setSelectedBatchSubmissionId(null);
                        setFormData(initialData);
                        setSignature(null);
                        setView('batch-list');
                      } else {
                        setView('mode-selection');
                      }
                    }} 
                    className="text-slate-400 hover:text-slate-900 flex items-center gap-2 font-black uppercase text-[10px] tracking-widest bg-slate-50 px-4 py-2.5 rounded-xl border border-transparent"
                  >
                    <RotateCcw size={14} /> Back
                  </button>
                  <span className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-600">
                    {isBatchEditMode ? 'Batch Edit' : 'Unified Registry'}
                  </span>
                </div>
                <div className="space-y-16">
                  <FormSection step={0} formData={formData} onChange={handleInputChange} onFieldBlur={handleFormFieldBlur} />
                  <FormSection step={1} formData={formData} onChange={handleInputChange} onFieldBlur={handleFormFieldBlur} />
                  <FormSection step={2} formData={formData} onChange={handleInputChange} onFieldBlur={handleFormFieldBlur} />
                  <FormSection step={3} formData={formData} onChange={handleInputChange} onFieldBlur={handleFormFieldBlur} />
                  <FormSection step={4} formData={formData} onChange={handleInputChange} onFieldBlur={handleFormFieldBlur} onSign={handleSignatureChange} signature={signature} />
                </div>
                <div className="fixed bottom-0 left-0 lg:w-[460px] w-full p-6 bg-white/95 backdrop-blur-2xl border-t border-slate-100 z-50 flex gap-4 no-print">
                  <button
                    title="Print to A4 (free)"
                    onClick={payAndPrint}
                    disabled={isPaying || isGenerating}
                    className="w-16 h-16 rounded-2xl flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-slate-100 text-slate-500 hover:bg-slate-200"
                  >
                    <Printer size={22} />
                  </button>
                  {isBatchEditMode && (
                    <button 
                      onClick={async () => {
                        if (!selectedBatchSubmissionId) return;
                        track('ve_batch_editor_save_click');
                        try {
                          const submissionRef = doc(db, 'batchSubmissions', selectedBatchSubmissionId);
                          await updateDoc(submissionRef, {
                            extractedData: formData,
                            updatedAt: serverTimestamp(),
                          });
                          track('ve_batch_editor_save_ok');
                          showMessage('Changes saved successfully.', 'Saved');
                        } catch (error) {
                          console.error('Error saving:', error);
                          track('ve_batch_editor_save_fail');
                          showMessage('Failed to save changes.', 'Error');
                        }
                      }}
                      className="px-6 h-16 bg-slate-100 text-slate-700 rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-slate-200 transition-all"
                    >
                      Save
                    </button>
                  )}
                  <button
                    onClick={payAndDownload}
                    disabled={isGenerating || isPaying}
                    className="flex-1 h-16 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-widest shadow-xl flex items-center justify-center gap-4 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isPaying ? 'Working...' : isGenerating ? 'Generating...' : 'Download PDF'}
                  </button>
                </div>
              </div>

              <div className="flex-1 flex flex-col h-full bg-[#FAFAFB] relative overflow-hidden">
                <div className="absolute top-8 right-8 flex gap-3 z-40 bg-white/80 backdrop-blur-xl p-2 rounded-2xl border border-slate-200/50 shadow-sm no-print">
                  <button
                    onClick={() => {
                      track('ve_layout_toggle_click');
                      setIsLayoutEditing(v => !v);
                    }}
                    className={`px-4 text-[10px] font-black uppercase tracking-widest rounded-xl border transition-colors ${
                      isLayoutEditing
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-slate-500 border-slate-200'
                    }`}
                  >
                    {isLayoutEditing ? 'Editing On' : 'Edit Layout'}
                  </button>
                  <button
                    onClick={() => {
                      track('ve_layout_reset_click');
                      localStorage.removeItem(LAYOUT_STORAGE_KEY);
                      localStorage.removeItem(TEMPLATE_STORAGE_KEY);
                      setLayoutResetTick(t => t + 1);
                    }}
                    className="px-4 text-[10px] font-black uppercase tracking-widest rounded-xl border bg-white text-slate-500 border-slate-200 hover:bg-slate-50"
                  >
                    Reset
                  </button>
                  <button
                    onClick={() => {
                      track('ve_layout_template_save_click');
                      setTemplateSaveTick(t => t + 1);
                      setTemplateSaved(true);
                      setTimeout(() => setTemplateSaved(false), 1800);
                    }}
                    className={`px-4 text-[10px] font-black uppercase tracking-widest rounded-xl border ${
                      templateSaved
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                    }`}
                  >
                    {templateSaved ? 'Template Saved' : 'Save Template'}
                  </button>
                  <button onClick={() => setZoom(z => Math.max(0.4, z - 0.1))} className="p-3 text-slate-400"><ZoomOut size={18} /></button>
                  <span className="text-[11px] font-black text-slate-500 min-w-[45px] text-center tabular-nums self-center">{Math.round(zoom * 100)}%</span>
                  <button onClick={() => setZoom(z => Math.min(2, z + 0.1))} className="p-3 text-slate-400"><ZoomIn size={18} /></button>
                </div>
                <div className="flex-1 overflow-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:24px_24px] flex items-center justify-center p-12">
                  {/* Card preview at exact 85.60mm x 53.98mm ratio */}
                  <motion.div
                    animate={{ scale: zoom }}
                    className="shadow-[0_40px_80px_-20px_rgba(0,0,0,0.15)] bg-white ring-1 ring-slate-200 relative"
                    style={{
                      width: isLayoutEditing ? '860px' : '560px',
                      height: `${560 / CARD_ASPECT}px`,
                      overflow: 'hidden',
                      flexShrink: 0,
                    }}
                  >
                    <CardPreview
                      data={formData}
                      signature={signature}
                      isLayoutEditing={isLayoutEditing}
                      layoutResetTick={layoutResetTick}
                      templateSaveTick={templateSaveTick}
                    />
                  </motion.div>
                </div>
              </div>
            </motion.div>
          ) : view === 'success' ? (
            <motion.div key="success" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[3rem] p-16 text-center shadow-2xl border border-slate-50 max-w-lg mx-auto mt-24">
              <div className="w-24 h-24 bg-green-500 text-white rounded-full flex items-center justify-center mx-auto mb-8">
                <CheckCircle2 size={48} />
              </div>
              <h2 className="text-4xl font-black mb-4 text-slate-900">All Set!</h2>
              <button 
                onClick={() => { 
                  track('ve_success_continue', { batch_edit: isBatchEditMode });
                  setFormData(initialData); 
                  setSignature(null);
                  setRcDataSource('manual');
                  if (isBatchEditMode) {
                    setIsBatchEditMode(false);
                    setSelectedBatchSubmissionId(null);
                    setView('batch-list');
                  } else {
                    setView('mode-selection');
                  }
                }} 
                className="w-full py-6 bg-slate-900 text-white rounded-[2rem] font-black uppercase tracking-widest hover:bg-black transition-all"
              >
                {isBatchEditMode ? 'Back to Batch List' : 'Start New Enrollment'}
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </>
  );
}

function CardPreview({
  data,
  signature,
  isLayoutEditing,
  layoutResetTick,
  templateSaveTick,
}: {
  data: FormData;
  signature: string | null;
  isLayoutEditing: boolean;
  layoutResetTick: number;
  templateSaveTick: number;
}) {
  // 1 inch = 244.57px on this 856px-wide canvas (856/3.5 = 244.57)
  const PPI = 244.57;

  // Load field positions from localStorage (saved layout overrides)
  const getLayout = () => {
    try {
      const saved =
        localStorage.getItem(TEMPLATE_STORAGE_KEY) ||
        localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch {}
    return null;
  };
  const [layout, setLayout] = useState<Record<string, any>>(getLayout() ?? {});
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [draggingField, setDraggingField] = useState<string | null>(null);
  const [resizingField, setResizingField] = useState<string | null>(null);
  const [fontSizingField, setFontSizingField] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [resizeStart, setResizeStart] = useState({ mouseX: 0, mouseY: 0, w: 0, h: 0 });
  const [fontSizeStart, setFontSizeStart] = useState({ mouseY: 0, fontSize: 0 });

  const qrPayload = `Registeration No.:${data.regnNo || ''} Registeration Date:${data.regnDate || ''} Engine No.:${data.engineNo || ''} Chassis No.:${data.chassisNo || ''} Click URL to verify:https://qr.parivahan.gov.inedji/vq/qr?v=10o24T9kP39hXpb6`;

  useEffect(() => {
    setLayout(getLayout() ?? {});
    setSelectedField(null);
  }, [layoutResetTick]);

  useEffect(() => {
    if (!templateSaveTick) return;
    localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(layout));
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  }, [templateSaveTick, layout]);

  useEffect(() => {
    if (!isLayoutEditing) {
      setDraggingField(null);
      setResizingField(null);
      setFontSizingField(null);
    }
  }, [isLayoutEditing]);

  // A4 preview dimensions (px)
  const PREVIEW_W = 560;
  const PREVIEW_H = PREVIEW_W / CARD_ASPECT;
  const PREVIEW_PPI = PREVIEW_W / (CARD_WIDTH_MM / 25.4);
  const QR_PREVIEW = Math.round(0.70 * PREVIEW_PPI);
  const QR_PRINT   = Math.round(0.70 * 96); // 96dpi for print

  // Build a unified field list from saved layout positions
  type FieldDef = { key: string; value: string; bold?: boolean; isQR?: boolean; isSig?: boolean;
                    dx: number; dy: number; dw: number; dh: number; dSize: number };
  const FDEFS: FieldDef[] = [
    { key: 'regnNo',          dx: 0.5704 + LEFT_VALUES_X_SHIFT_IN, dy: 0.0474 + MAIN_VALUE_Y_NUDGE_IN + LEFT_VALUES_Y_SHIFT_IN, dw: 1.1, dh: 0.1, dSize: 8,   bold: true,  value: data.regnNo },
    { key: 'regdOwner',       dx: 0.5704 + LEFT_VALUES_X_SHIFT_IN, dy: 0.1445 + MAIN_VALUE_Y_NUDGE_IN + LEFT_VALUES_Y_SHIFT_IN, dw: 1.0793, dh: 0.0911, dSize: 7,   bold: true,  value: data.regdOwner },
    { key: 'swdOf',           dx: 0.5694 + LEFT_VALUES_X_SHIFT_IN, dy: 0.2337 + MAIN_VALUE_Y_NUDGE_IN + LEFT_VALUES_Y_SHIFT_IN, dw: 1.0498, dh: 0.0793, dSize: 7,                value: data.swdOf },
    { key: 'regnDate',        dx: 0.5694 + LEFT_VALUES_X_SHIFT_IN, dy: 0.4181 + MAIN_VALUE_Y_NUDGE_IN + LEFT_VALUES_Y_SHIFT_IN, dw: 0.8793, dh: 0.0752, dSize: 6.5,              value: data.regnDate },
    { key: 'colour',          dx: 0.5694 + LEFT_VALUES_X_SHIFT_IN, dy: 0.4908 + MAIN_VALUE_Y_NUDGE_IN + LEFT_VALUES_Y_SHIFT_IN, dw: 0.8321, dh: 0.0723, dSize: 6.5,              value: data.colour },
    { key: 'fuel',            dx: 0.5694 + LEFT_VALUES_X_SHIFT_IN, dy: 0.5624 + MAIN_VALUE_Y_NUDGE_IN + LEFT_VALUES_Y_SHIFT_IN, dw: 0.8793, dh: 0.0722, dSize: 6.5,              value: data.fuel },
    { key: 'vehicleClass',    dx: 0.5694 + LEFT_VALUES_X_SHIFT_IN, dy: 0.6322 + MAIN_VALUE_Y_NUDGE_IN + LEFT_VALUES_Y_SHIFT_IN, dw: 0.8616, dh: 0.0752, dSize: 6.5,              value: data.vehicleClass },
    { key: 'bodyType',        dx: 0.5694 + LEFT_VALUES_X_SHIFT_IN, dy: 0.7097 + MAIN_VALUE_Y_NUDGE_IN + LEFT_VALUES_Y_SHIFT_IN, dw: 0.8645, dh: 0.0723, dSize: 6.5,              value: data.bodyType },
    { key: 'manufacturer',    dx: 0.5694 + LEFT_VALUES_X_SHIFT_IN, dy: 0.7795 + MAIN_VALUE_Y_NUDGE_IN + LEFT_VALUES_Y_SHIFT_IN, dw: 1.2937, dh: 0.0752, dSize: 6,                value: data.manufacturer },
    { key: 'chassisNo',       dx: 0.5694 + LEFT_VALUES_X_SHIFT_IN, dy: 0.8481 + MAIN_VALUE_Y_NUDGE_IN + LEFT_VALUES_Y_SHIFT_IN, dw: 1.3262, dh: 0.0811, dSize: 6.5,              value: data.chassisNo },
    { key: 'engineNo',        dx: 0.5694 + LEFT_VALUES_X_SHIFT_IN, dy: 0.9268 + MAIN_VALUE_Y_NUDGE_IN + LEFT_VALUES_Y_SHIFT_IN, dw: 1.3173, dh: 0.0752, dSize: 6.5,              value: data.engineNo },
    { key: 'modelNo',         dx: 0.5694 + LEFT_VALUES_X_SHIFT_IN, dy: 1.0025 + MAIN_VALUE_Y_NUDGE_IN + LEFT_VALUES_Y_SHIFT_IN, dw: 1.3646, dh: 0.0782, dSize: 6,   bold: true,  value: data.modelNo },
    { key: 'manufacturingDt', dx: 1.8363 + MFG_VALIDITY_X_NUDGE_IN, dy: 0.3972 + MFG_VALIDITY_Y_NUDGE_IN, dw: 0.4285, dh: 0.09, dSize: 6.5,              value: data.manufacturingDt },
    { key: 'regdValidity',    dx: 2.8797 + MFG_VALIDITY_X_NUDGE_IN, dy: 0.4002 + MFG_VALIDITY_Y_NUDGE_IN + REGD_VALIDITY_Y_EXTRA_IN, dw: 0.5962, dh: 0.0959, dSize: 6.5,              value: data.regdValidity },
    { key: 'hypothecatedTo',  dx: 1.6964, dy: 1.1218, dw: 0.9, dh: 0.135, dSize: 5,   bold: true,  value: hypothecatedValueForCard(String(data.hypothecatedTo || '')) },
    { key: 'unladenWt',       dx: 2.908 + SPEC_GRID_X_NUDGE_IN, dy: 1.1653 + SPEC_GRID_Y_NUDGE_IN, dw: 0.597, dh: 0.0841, dSize: 6,                value: data.unladenWt },
    { key: 'cubicCapacity',   dx: 2.9081 + SPEC_GRID_X_NUDGE_IN, dy: 1.2504 + SPEC_GRID_Y_NUDGE_IN, dw: 0.5793, dh: 0.0723, dSize: 6,                value: data.cubicCapacity },
    { key: 'wheelBase',       dx: 2.908 + SPEC_GRID_X_NUDGE_IN, dy: 1.3239 + SPEC_GRID_Y_NUDGE_IN, dw: 0.5498, dh: 0.0752, dSize: 6,                value: data.wheelBase },
    { key: 'rlw',             dx: 2.908 + SPEC_GRID_X_NUDGE_IN, dy: 1.3973 + SPEC_GRID_Y_NUDGE_IN, dw: 0.5498, dh: 0.0811, dSize: 6,                value: data.rlw },
    { key: 'seatCapacity',    dx: 1.6911 + SPEC_GRID_X_NUDGE_IN, dy: 1.3046 + SPEC_GRID_Y_NUDGE_IN, dw: 0.35, dh: 0.09, dSize: 6.5,              value: data.seatCapacity },
    { key: 'standCapacity',   dx: 1.693 + SPEC_GRID_X_NUDGE_IN, dy: 1.3902 + SPEC_GRID_Y_NUDGE_IN, dw: 0.35, dh: 0.09, dSize: 6.5,              value: data.standCapacity },
    { key: 'noOfCyc',         dx: 2.2859 + SPEC_GRID_X_NUDGE_IN, dy: 1.2957 + SPEC_GRID_Y_NUDGE_IN, dw: 0.35, dh: 0.09, dSize: 6.5,              value: data.noOfCyc },
    { key: 'ownerSerial',     dx: 2.2848 + SPEC_GRID_X_NUDGE_IN, dy: 1.3873 + SPEC_GRID_Y_NUDGE_IN, dw: 0.35, dh: 0.09, dSize: 6.5,              value: data.ownerSerial },
    { key: 'address',         dx: 1.443, dy: 1.5462, dw: 1.5004, dh: 0.2191, dSize: 6,                value: data.address },
    { key: 'issuingAuthority',dx: 1.7278, dy: 1.88 + AUTHORITY_Y_EXTRA_IN, dw: 0.7612, dh: 0.103, dSize: 7,   bold: true,  value: data.issuingAuthority },
    { key: 'qrCode',          dx: 0.0734 + QR_X_NUDGE_IN, dy: 1.0935 + QR_Y_NUDGE_IN, dw: 0.9954 * QR_SCALE, dh: 1.0013 * QR_SCALE, dSize: 0,   isQR: true,  value: '' },
    { key: 'signature',       dx: 2.6447, dy: 1.8643, dw: 0.8, dh: 0.12, dSize: 0,   isSig: true, value: '' },
  ];


  // Resolve each field's position from saved layout or default
  const resolved = FDEFS.map(f => {
    const templateDefaults = DEFAULT_TEMPLATE_LAYOUT[f.key] ?? {};
    const p = layout?.[f.key] ?? templateDefaults;
    const baseX = p?.x ?? templateDefaults.x ?? f.dx;
    const validityValue = (data.regdValidity || '').trim().toLowerCase();
    const isLongValidity = f.key === 'regdValidity' && validityValue.startsWith('as per fitness');
    const baseSize = p?.fontSize ?? templateDefaults.fontSize ?? f.dSize;
    const size = isLongValidity
      ? Math.max(4, +(baseSize - REGD_VALIDITY_LONG_FONT_SUB_PT).toFixed(1))
      : baseSize;
    return { 
      ...f, 
      x: isLongValidity ? REGD_VALIDITY_LONG_TEXT_X : baseX, 
      y: p?.y ?? templateDefaults.y ?? f.dy, 
      w: p?.w ?? templateDefaults.w ?? f.dw, 
      h: p?.h ?? templateDefaults.h ?? f.dh, 
      size,
      bold: !(f.isQR || f.isSig),
    };
  });
  const selectedResolved = selectedField ? resolved.find((f) => f.key === selectedField) : null;

  const persistLayout = (next: Record<string, any>) => {
    setLayout(next);
  };

  const updateSelectedField = (key: 'x' | 'y' | 'w' | 'h' | 'fontSize', value: string) => {
    if (!selectedField) return;
    const parsed = parseFloat(value);
    if (Number.isNaN(parsed)) return;
    const clamped =
      key === 'fontSize'
        ? Math.max(4, Math.min(28, parsed))
        : key === 'w'
        ? Math.max(0.08, parsed)
        : key === 'h'
        ? Math.max(0.05, parsed)
        : Math.max(0, parsed);
    persistLayout({
      ...layout,
      [selectedField]: {
        ...(layout[selectedField] ?? {}),
        [key]: +clamped.toFixed(key === 'fontSize' ? 1 : 4),
      },
    });
  };

  const onCanvasMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isLayoutEditing || (!draggingField && !resizingField && !fontSizingField)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect) return;
    const scaleX = rect.width / PREVIEW_W;
    const scaleY = rect.height / PREVIEW_H;

    if (draggingField) {
      const field = resolved.find((f) => f.key === draggingField);
      if (!field) return;
      const rawPxX = e.clientX - rect.left - dragOffset.x;
      const rawPxY = e.clientY - rect.top - dragOffset.y;
      const maxLeftPx = rect.width - field.w * PREVIEW_PPI * scaleX;
      const maxTopPx = rect.height - field.h * PREVIEW_PPI * scaleY;
      const nextX = +(Math.max(0, Math.min(rawPxX, maxLeftPx)) / (PREVIEW_PPI * scaleX)).toFixed(4);
      const nextY = +(Math.max(0, Math.min(rawPxY, maxTopPx)) / (PREVIEW_PPI * scaleY)).toFixed(4);
      persistLayout({
        ...layout,
        [draggingField]: { ...(layout[draggingField] ?? {}), x: nextX, y: nextY },
      });
    }

    if (resizingField) {
      const dx = e.clientX - resizeStart.mouseX;
      const dy = e.clientY - resizeStart.mouseY;
      const nextW = +Math.max(0.08, resizeStart.w + dx / (PREVIEW_PPI * scaleX)).toFixed(4);
      const nextH = +Math.max(0.05, resizeStart.h + dy / (PREVIEW_PPI * scaleY)).toFixed(4);
      persistLayout({
        ...layout,
        [resizingField]: { ...(layout[resizingField] ?? {}), w: nextW, h: nextH },
      });
    }

    if (fontSizingField) {
      const dy = e.clientY - fontSizeStart.mouseY;
      const deltaPt = -(dy / 4);
      const nextFont = +Math.max(4, Math.min(28, fontSizeStart.fontSize + deltaPt)).toFixed(1);
      persistLayout({
        ...layout,
        [fontSizingField]: { ...(layout[fontSizingField] ?? {}), fontSize: nextFont },
      });
    }
  };

  return (
    <>
      {/* UI Preview — A4 scaled to 330×467px */}
      <div className="w-full h-full flex bg-white">
        <div
          id="rc-card-preview"
          className="relative bg-white font-sans overflow-hidden border-r border-slate-200"
          style={{ width: `${PREVIEW_W}px`, height: `${PREVIEW_H}px` }}
          onMouseMove={onCanvasMouseMove}
          onMouseUp={() => {
            const d = draggingField;
            const r = resizingField;
            const f = fontSizingField;
            if (d) track('ve_layout_drag_end', { field: d });
            if (r) track('ve_layout_resize_end', { field: r });
            if (f) track('ve_layout_font_adjust_end', { field: f });
            setDraggingField(null);
            setResizingField(null);
            setFontSizingField(null);
          }}
          onMouseLeave={() => {
            setDraggingField(null);
            setResizingField(null);
            setFontSizingField(null);
          }}
        >
          {/* Background reference scan image for calibration */}
          {isLayoutEditing && (
            <>
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  backgroundImage: `url(/calibration-bg.png)`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  backgroundRepeat: 'no-repeat',
                  opacity: 0.5,
                  mixBlendMode: 'multiply',
                }}
              />
              <div
                className="absolute inset-0 pointer-events-none bg-blue-600/[0.03] mix-blend-color"
              />
            </>
          )}

          {resolved.map((f, i) => {
          const left = f.x * PREVIEW_PPI;
          const top  = f.y * PREVIEW_PPI;
          const width = f.w * PREVIEW_PPI;
          const height = f.h * PREVIEW_PPI;

          const onFieldMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
            if (!isLayoutEditing) return;
            if ((e.target as HTMLElement).dataset.resizeHandle) return;
            if ((e.target as HTMLElement).dataset.fontHandle) return;
            e.preventDefault();
            e.stopPropagation();
            setSelectedField(f.key);
            setDraggingField(f.key);
            const rect = e.currentTarget.parentElement?.getBoundingClientRect();
            if (!rect) return;
            const scaleX = rect.width / PREVIEW_W;
            const scaleY = rect.height / PREVIEW_H;
            setDragOffset({ x: e.clientX - rect.left - left * scaleX, y: e.clientY - rect.top - top * scaleY });
          };

          const onResizeMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
            if (!isLayoutEditing) return;
            e.preventDefault();
            e.stopPropagation();
            setSelectedField(f.key);
            setResizingField(f.key);
            setResizeStart({ mouseX: e.clientX, mouseY: e.clientY, w: f.w, h: f.h });
          };

          const onFontSizeMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
            if (!isLayoutEditing || f.isQR || f.isSig) return;
            e.preventDefault();
            e.stopPropagation();
            setSelectedField(f.key);
            setFontSizingField(f.key);
            setFontSizeStart({ mouseY: e.clientY, fontSize: f.size || 6 });
          };

          if (f.isQR) return (
            <div
              key={i}
              className={`absolute ${isLayoutEditing ? 'cursor-move' : ''}`}
              style={{ left, top, width, height, border: isLayoutEditing ? '1px dashed #2563eb' : 'none' }}
              onMouseDown={onFieldMouseDown}
            >
              <QRCodeSVG value={qrPayload} size={width} level="L" />
              {isLayoutEditing && (
                <div
                  data-resize-handle="1"
                  onMouseDown={onResizeMouseDown}
                  className="absolute w-3 h-3 bg-blue-600 border border-white rounded-full"
                  style={{ right: -6, bottom: -6, cursor: 'nwse-resize' }}
                />
              )}
            </div>
          );
          if (f.isSig) return signature ? (
            <div
              key={i}
              className={`absolute ${isLayoutEditing ? 'cursor-move' : ''}`}
              style={{
                left,
                top,
                width,
                height,
                border: isLayoutEditing ? '1px dashed #9333ea' : 'none',
                background: isLayoutEditing ? 'rgba(147,51,234,0.07)' : 'transparent',
              }}
              onMouseDown={onFieldMouseDown}
            >
              <img src={signature} className="w-full h-full object-contain mix-blend-multiply" />
              {isLayoutEditing && (
                <div
                  data-resize-handle="1"
                  onMouseDown={onResizeMouseDown}
                  className="absolute w-3 h-3 bg-purple-600 border border-white rounded-full"
                  style={{ right: -6, bottom: -6, cursor: 'nwse-resize' }}
                />
              )}
            </div>
          ) : null;
          return (
            <div
              key={i}
              className={`absolute leading-tight font-bold ${isLayoutEditing ? 'cursor-move' : ''}`}
              style={{ 
                left, top, width, height, 
                fontSize: `${(f.size / 72) * PREVIEW_PPI}px`, 
                color: '#111', 
                fontFamily: 'Arial, Helvetica, sans-serif',
                whiteSpace: f.key === 'address' || f.key === 'hypothecatedTo' ? 'pre-line' : 'nowrap',
                letterSpacing: '0.02em',
                lineHeight: f.key === 'address' || f.key === 'hypothecatedTo' ? '1.15' : '1',
                border: isLayoutEditing ? `1px dashed ${selectedField === f.key ? '#0f172a' : '#64748b'}` : 'none',
                background: isLayoutEditing ? 'rgba(255,255,255,0.2)' : 'transparent',
              }}
              onMouseDown={onFieldMouseDown}
            >
              {f.value}
              {isLayoutEditing && (
                <>
                  <div
                    data-resize-handle="1"
                    onMouseDown={onResizeMouseDown}
                    className="absolute w-3 h-3 bg-slate-700 border border-white rounded-full"
                    style={{ right: -6, bottom: -6, cursor: 'nwse-resize' }}
                  />
                  <div
                    data-font-handle="1"
                    onMouseDown={onFontSizeMouseDown}
                    className="absolute w-3 h-3 bg-emerald-600 border border-white rounded-full"
                    style={{ right: -6, top: -6, cursor: 'ns-resize' }}
                    title="Drag up/down to change font size"
                  />
                </>
              )}
            </div>
          );
          })}
          {isLayoutEditing && (
            <div className="absolute left-3 bottom-3 px-3 py-2 rounded-lg bg-slate-900/80 text-white text-[10px] font-bold tracking-wide pointer-events-none">
              Drag field to move. Bottom-right handle: resize box. Top-right green handle: resize font.
            </div>
          )}
        </div>
        {isLayoutEditing && (
          <div className="w-[300px] h-full bg-slate-50 p-4 overflow-y-auto">
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-3">
              <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 mb-2">Field Inspector</div>
              {selectedResolved ? (
                <>
                  <div className="text-xs font-bold text-slate-800 mb-3">{selectedResolved.key}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[10px] font-bold text-slate-500">
                      X (in)
                      <input
                        type="number"
                        step="0.001"
                        value={selectedResolved.x}
                        onChange={(e) => updateSelectedField('x', e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-semibold text-slate-700 bg-white"
                      />
                    </label>
                    <label className="text-[10px] font-bold text-slate-500">
                      Y (in)
                      <input
                        type="number"
                        step="0.001"
                        value={selectedResolved.y}
                        onChange={(e) => updateSelectedField('y', e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-semibold text-slate-700 bg-white"
                      />
                    </label>
                    <label className="text-[10px] font-bold text-slate-500">
                      W (in)
                      <input
                        type="number"
                        step="0.001"
                        value={selectedResolved.w}
                        onChange={(e) => updateSelectedField('w', e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-semibold text-slate-700 bg-white"
                      />
                    </label>
                    <label className="text-[10px] font-bold text-slate-500">
                      H (in)
                      <input
                        type="number"
                        step="0.001"
                        value={selectedResolved.h}
                        onChange={(e) => updateSelectedField('h', e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-semibold text-slate-700 bg-white"
                      />
                    </label>
                  </div>
                  {!selectedResolved.isQR && !selectedResolved.isSig && (
                    <>
                      <label className="block text-[10px] font-bold text-slate-500 mt-2">
                        Font Size (pt)
                        <input
                          type="number"
                          step="0.1"
                          value={selectedResolved.size}
                          onChange={(e) => updateSelectedField('fontSize', e.target.value)}
                          className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-semibold text-slate-700 bg-white"
                        />
                      </label>
                    </>
                  )}
                </>
              ) : (
                <div className="text-[11px] text-slate-500 font-medium">
                  Select any field on the card to edit its values here.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Hidden A4 print target — shifted off-screen but display:block for html2canvas */}
      <div id="rc-a4-print" style={{ position: 'fixed', left: '-9999px', top: '-9999px', width: '794px', height: '1123px', background: 'white', display: 'block' }}>
        {resolved.map((f, i) => {
          // Use 96 DPI for stable conversion
          const px = (v: number) => `${v * 96}px`;
          
          if (f.isQR) return (
            <div key={i} className="a4-field" style={{ position: 'absolute', left: px(f.x), top: px(f.y), width: px(f.w), height: px(f.h) }}>
              <QRCodeSVG value={qrPayload} size={f.w * 96} level="L" />
            </div>
          );
          if (f.isSig) return signature ? (
            <img key={i} src={signature} className="a4-field object-contain mix-blend-multiply"
              style={{ position: 'absolute', left: px(f.x), top: px(f.y), width: px(f.w), height: px(f.h) }} />
          ) : null;
          return (
            <div key={i} className="a4-field"
              style={{
                position: 'absolute', left: px(f.x), top: px(f.y),
                width: px(f.w), height: px(f.h),
                fontSize: `${f.size}pt`, 
                fontFamily: 'Arial, Helvetica, sans-serif',
                fontWeight: 700,
                color: '#111',
                textTransform: 'none',
                whiteSpace: f.key === 'address' || f.key === 'hypothecatedTo' ? 'pre-line' : 'nowrap',
                letterSpacing: '0.03em',
                lineHeight: f.key === 'address' || f.key === 'hypothecatedTo' ? '1.15' : '1',
              }}>
              {f.value}
            </div>
          );
        })}
      </div>
    </>
  );
}



function FormInput({ label, name, placeholder, type = "text", formData, onChange, onBlur, maxLength }: any) {
  return (
    <div className="space-y-3">
      <label className="block text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 ml-1">{label}</label>
      <input
        type={type}
        name={name}
        value={formData[name] || ''}
        onChange={onChange}
        onBlur={onBlur}
        maxLength={maxLength}
        placeholder={placeholder}
        className="w-full bg-slate-50/50 border border-slate-100 rounded-2xl px-6 py-5 font-bold focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-100/20 outline-none transition-all placeholder:text-slate-200 text-sm shadow-sm"
      />
    </div>
  );
}

function FormSection({ step, formData, onChange, onFieldBlur, onSign, signature }: any) {
  if (step === 0) return (
    <div className="grid grid-cols-2 gap-8">
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Regn No" name="regnNo" placeholder="HR26EB5601" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Regn Date" name="regnDate" placeholder="DD-MM-YYYY" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Chassis No" name="chassisNo" placeholder="Full Chassis Number" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Engine No" name="engineNo" placeholder="Full Engine Number" />
    </div>
  );
  if (step === 1) return (
    <div className="grid grid-cols-2 gap-8">
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Manufacturer" name="manufacturer" placeholder="Maruti Suzuki" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Model" name="modelNo" placeholder="Brezza VDI" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Fuel" name="fuel" placeholder="Petrol" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Colour" name="colour" placeholder="Pearl White" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Body Type" name="bodyType" placeholder="Hatchback" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Class" name="vehicleClass" placeholder="Motor Car" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Mfg. Date" name="manufacturingDt" placeholder="As printed / MM/YYYY if applicable" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Validity" name="regdValidity" placeholder="DD-MM-YYYY" />
    </div>
  );
  if (step === 2) return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-8">
        <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Regd. Owner" name="regdOwner" placeholder="Full Name" />
        <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="S/D/W Of" name="swdOf" placeholder="Father/Husband Name" />
      </div>
      <div className="space-y-3">
        <label className="block text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 ml-1">Permanent Address</label>
        <textarea
          name="address"
          value={formData.address || ''}
          onChange={onChange}
          onBlur={onFieldBlur}
          rows={3}
          placeholder="Detailed residential address..."
          className="w-full bg-slate-50/50 border border-slate-100 rounded-3xl p-6 font-bold outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-100/20 transition-all text-sm shadow-sm placeholder:text-slate-200"
        />
      </div>
    </div>
  );
  if (step === 3) return (
    <div className="grid grid-cols-2 gap-8">
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Cubic Cap" name="cubicCapacity" placeholder="CC" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Seat Cap" name="seatCapacity" placeholder="Total" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Stand Cap" name="standCapacity" placeholder="Total" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Unladen Wt" name="unladenWt" placeholder="kg" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Wheelbase" name="wheelBase" placeholder="mm" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="RLW (laden)" name="rlw" placeholder="Laden weight kg" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="No. of Cyl" name="noOfCyc" placeholder="Cylinders" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Owner Serial" name="ownerSerial" placeholder="e.g. 01" />
    </div>
  );
  if (step === 4) return (
    <div className="grid grid-cols-2 gap-8">
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Authority" name="issuingAuthority" placeholder="Per RC" />
      <FormInput formData={formData} onChange={onChange} onBlur={onFieldBlur} label="Hypothecation" name="hypothecatedTo" placeholder="Per RC" />
      <div className="space-y-3">
        <label className="block text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 ml-1">Signature</label>
        <div className="relative">
          <input type="file" accept="image/*" onChange={onSign} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
          <div className="w-full bg-slate-50/50 border border-slate-100 rounded-2xl px-6 py-5 font-bold text-center text-slate-400 group-hover:bg-white transition-all text-sm truncate">
            {signature ? 'Signature Uploaded' : 'Upload Signature'}
          </div>
        </div>
      </div>
    </div>
  );
  return null;
}
