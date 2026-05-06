/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { jsPDF } from 'jspdf';
import { QRCodeSVG, QRCodeCanvas } from 'qrcode.react';
import {
  RotateCcw, Upload, ClipboardCheck, Car, User, Settings,
  ShieldCheck, MapPin, Sparkles, Edit3, CheckCircle2,
  AlertCircle, ChevronRight, ChevronLeft, Search, Printer,
  ZoomIn, ZoomOut, Sliders
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as pdfjsLib from 'pdfjs-dist';
import html2canvas from 'html2canvas';
import confetti from 'canvas-confetti';
import { auth, provider, db } from './firebase';
import { signInWithPopup, onAuthStateChanged, signOut, User as FirebaseUser } from 'firebase/auth';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import Calibrator from './Calibrator';


// PDF.js worker setup
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

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

type AppMode = 'manual' | 'auto';
type AppView = 'mode-selection' | 'form' | 'preview' | 'success';

const CARD_WIDTH_MM = 85.6;
const CARD_HEIGHT_MM = 53.98;
const CARD_ASPECT = CARD_WIDTH_MM / CARD_HEIGHT_MM;
const CARD_MOCKUP_URL = 'https://file60.b-cdn.net/card-mockup.png';
const LAYOUT_STORAGE_KEY = 'rc_calibration_layout';
const TEMPLATE_STORAGE_KEY = 'rc_global_template_layout';
/** Mfg date + regd validity: toward mockup labels (card inches). */
const MFG_VALIDITY_X_NUDGE_IN = -0.028;
const MFG_VALIDITY_Y_NUDGE_IN = 0.018;
const REGD_VALIDITY_LONG_TEXT_X = 2.58 + MFG_VALIDITY_X_NUDGE_IN;
/** Seat/stand/cyl/serial + unladen/CC/wheelbase/RLW vs mockup (card inches). */
const SPEC_GRID_X_NUDGE_IN = -0.028;
const SPEC_GRID_Y_NUDGE_IN = 0.018;
/** Shift value text down vs grey mockup labels (card inches). */
const MAIN_VALUE_Y_NUDGE_IN = 0.017;
/** QR plate ~4.5% smaller, centered in prior box. */
const QR_LAYOUT_BASE = { x: 0.0553, y: 1.0935, w: 0.9894, h: 0.905 } as const;
const QR_SCALE = 0.955;
const DEFAULT_TEMPLATE_LAYOUT: Record<string, Partial<{ x: number; y: number; w: number; h: number; fontSize: number; bold: boolean }>> = {
  regnNo: { x: 0.5537, y: 0.0421 + MAIN_VALUE_Y_NUDGE_IN, w: 0.8292, h: 0.1301, fontSize: 5 },
  regdOwner: { x: 0.5523, y: 0.1265 + MAIN_VALUE_Y_NUDGE_IN, fontSize: 5 },
  swdOf: { x: 0.5513, y: 0.2097 + MAIN_VALUE_Y_NUDGE_IN, fontSize: 5 },
  regnDate: { x: 0.5634, y: 0.3759 + MAIN_VALUE_Y_NUDGE_IN, fontSize: 5 },
  colour: { x: 0.5633, y: 0.4547 + MAIN_VALUE_Y_NUDGE_IN, fontSize: 5 },
  fuel: { x: 0.5634, y: 0.5263 + MAIN_VALUE_Y_NUDGE_IN, fontSize: 5 },
  vehicleClass: { x: 0.5634, y: 0.5961 + MAIN_VALUE_Y_NUDGE_IN, fontSize: 5 },
  bodyType: { x: 0.5634, y: 0.6676 + MAIN_VALUE_Y_NUDGE_IN, fontSize: 5 },
  manufacturer: { x: 0.5634, y: 0.7374 + MAIN_VALUE_Y_NUDGE_IN, fontSize: 5 },
  chassisNo: { x: 0.5634, y: 0.818 + MAIN_VALUE_Y_NUDGE_IN, fontSize: 5 },
  engineNo: { x: 0.5634, y: 0.8967 + MAIN_VALUE_Y_NUDGE_IN, fontSize: 5 },
  modelNo: { x: 0.5634, y: 0.9784 + MAIN_VALUE_Y_NUDGE_IN, fontSize: 5 },
  manufacturingDt: { x: 1.8724 + MFG_VALIDITY_X_NUDGE_IN, y: 0.3911 + MFG_VALIDITY_Y_NUDGE_IN, fontSize: 5 },
  seatCapacity: { x: 1.7091 + SPEC_GRID_X_NUDGE_IN, y: 1.2926 + SPEC_GRID_Y_NUDGE_IN, fontSize: 5 },
  standCapacity: { x: 1.711 + SPEC_GRID_X_NUDGE_IN, y: 1.3601 + SPEC_GRID_Y_NUDGE_IN, fontSize: 5 },
  noOfCyc: { x: 2.322 + SPEC_GRID_X_NUDGE_IN, y: 1.2837 + SPEC_GRID_Y_NUDGE_IN, fontSize: 5 },
  ownerSerial: { x: 2.3209 + SPEC_GRID_X_NUDGE_IN, y: 1.3632 + SPEC_GRID_Y_NUDGE_IN, fontSize: 5 },
  unladenWt: { x: 2.9477 + SPEC_GRID_X_NUDGE_IN, y: 1.1292 + SPEC_GRID_Y_NUDGE_IN, w: 0.3081, h: 0.0841, fontSize: 5 },
  cubicCapacity: { x: 2.9473 + SPEC_GRID_X_NUDGE_IN, y: 1.2083 + SPEC_GRID_Y_NUDGE_IN, w: 0.2904, h: 0.0843, fontSize: 5 },
  wheelBase: { x: 2.9467 + SPEC_GRID_X_NUDGE_IN, y: 1.2878 + SPEC_GRID_Y_NUDGE_IN, w: 0.2549, h: 0.0872, fontSize: 5 },
  rlw: { x: 2.9501 + SPEC_GRID_X_NUDGE_IN, y: 1.3733 + SPEC_GRID_Y_NUDGE_IN, w: 0.3271, h: 0.0992, fontSize: 5 },
  hypothecatedTo: { x: 1.6964, y: 1.1218, w: 0.9, h: 0.135, fontSize: 5 },
  address: { x: 1.4731, y: 1.5582, fontSize: 5 },
  issuingAuthority: { x: 1.463, y: 1.868, fontSize: 5 },
  qrCode: {
    x: QR_LAYOUT_BASE.x + (QR_LAYOUT_BASE.w * (1 - QR_SCALE)) / 2,
    y: QR_LAYOUT_BASE.y + (QR_LAYOUT_BASE.h * (1 - QR_SCALE)) / 2,
    w: QR_LAYOUT_BASE.w * QR_SCALE,
    h: QR_LAYOUT_BASE.h * QR_SCALE,
  },
  regdValidity: { x: 2.9304 + MFG_VALIDITY_X_NUDGE_IN, y: 0.3701 + MFG_VALIDITY_Y_NUDGE_IN, w: 0.4397, h: 0.132, fontSize: 5 },
};

const sanitizeExtractedValue = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

/** Manufacturing month/year for RC: always MM/YYYY (two-digit month). */
const formatManufacturingDtMmYyyy = (raw: string): string => {
  const s = raw.trim();
  if (!s) return '';
  let m = s.match(/^(\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    const month = parseInt(m[1], 10);
    const year = parseInt(m[2], 10);
    if (month >= 1 && month <= 12 && year >= 1900 && year <= 2100) {
      return `${String(month).padStart(2, '0')}/${year}`;
    }
  }
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
      return `${String(month).padStart(2, '0')}/${year}`;
    }
  }
  m = s.match(/^(\d{4})[\/\-](\d{1,2})$/);
  if (m) {
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (month >= 1 && month <= 12 && year >= 1900 && year <= 2100) {
      return `${String(month).padStart(2, '0')}/${year}`;
    }
  }
  return s;
};

/** PREFIX + LOCATION: if no known office token before place, default PREFIX is SDM. */
const ISSUING_AUTH_OFFICE_PREFIX =
  /^(RTA|SDM|RTO|DTO|ARTO|MLO|DHO|ADO|RLA|ASST\.?|JT\.?|DY\.?)\b/i;

const normalizeIssuingAuthority = (raw: string): string => {
  const s = raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (ISSUING_AUTH_OFFICE_PREFIX.test(s)) return s;
  return `SDM ${s}`;
};

const HYPO_LINE_MAX = 12;

/** If longer than HYPO_LINE_MAX chars, continue on new line(s); prefer breaking at spaces. */
const wrapHypothecatedToValue = (raw: string): string => {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s || s.length <= HYPO_LINE_MAX) return s;
  const parts: string[] = [];
  let rest = s;
  while (rest.length > HYPO_LINE_MAX) {
    let cut = HYPO_LINE_MAX;
    const sp = rest.lastIndexOf(' ', HYPO_LINE_MAX);
    if (sp > 2) cut = sp;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts.join('\n');
};

/** Maps API JSON to form fields using model output only (trim); validity/authority/class rules live in the extraction prompt. */
const normalizeExtractedData = (raw: Record<string, any>): Partial<FormData> => {
  const normalized: Record<string, any> = {};
  for (const key of FORM_KEYS) {
    const v = raw[key];
    if (key === 'cubicCapacity' && typeof v === 'number' && Number.isFinite(v)) {
      normalized[key] = String(v);
    } else if (key === 'manufacturingDt') {
      normalized[key] = formatManufacturingDtMmYyyy(sanitizeExtractedValue(v));
    } else if (key === 'issuingAuthority') {
      normalized[key] = normalizeIssuingAuthority(sanitizeExtractedValue(v));
    } else {
      normalized[key] = sanitizeExtractedValue(v);
    }
  }
  return normalized as Partial<FormData>;
};

export default function App() {
  // ── ALL hooks must be declared before any conditional return ──
  const [showCalibrator, setShowCalibrator] = useState(false);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [formData, setFormData] = useState<FormData>(initialData);
  const [view, setView] = useState<AppView>('mode-selection');
  const [isExtracting, setIsExtracting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [customPrompt, setCustomPrompt] = useState(() => localStorage.getItem('rcCustomPrompt') || '');
  const [showSettings, setShowSettings] = useState(false);
  const [isLayoutEditing, setIsLayoutEditing] = useState(false);
  const [layoutResetTick, setLayoutResetTick] = useState(0);
  const [templateSaveTick, setTemplateSaveTick] = useState(0);
  const [templateSaved, setTemplateSaved] = useState(false);
  const qrRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  useEffect(() => {
    localStorage.setItem('rcCustomPrompt', customPrompt);
  }, [customPrompt]);

  // ── Now safe to do conditional renders ──
  if (showCalibrator) return <Calibrator onBack={() => setShowCalibrator(false)} />;



  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleManufacturingDtBlur = () => {
    setFormData(prev => ({
      ...prev,
      manufacturingDt: formatManufacturingDtMmYyyy(prev.manufacturingDt || ''),
    }));
  };

  const handleIssuingAuthorityBlur = () => {
    setFormData(prev => ({
      ...prev,
      issuingAuthority: normalizeIssuingAuthority(prev.issuingAuthority || ''),
    }));
  };

  const handleSignatureChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setSignature(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsExtracting(true);
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve) => {
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      const [meta, base64Data = ''] = dataUrl.split(',');
      const mimeType = file.type || meta.match(/^data:(.*?);base64$/)?.[1] || 'application/octet-stream';

      const res = await fetch('/api/extractRcData', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64Data, mimeType, customPrompt })
      });

      if (!res.ok) throw new Error('Failed to extract data: ' + await res.text());
      const extractedData = await res.json();
      const normalizedData = normalizeExtractedData(extractedData || {});
      const found: Record<string, string> = {};
      const missing: string[] = [];
      for (const key of FORM_KEYS) {
        const value = normalizedData[key] ?? '';
        if (typeof value === 'string' && value.trim()) {
          found[key] = value;
        } else {
          missing.push(key);
        }
      }
      console.groupCollapsed('[RC Extraction] Field coverage');
      console.log('Raw response:', extractedData);
      console.log('Normalized response:', normalizedData);
      console.log('Found fields:', found);
      console.log('Missing fields:', missing);
      console.groupEnd();
      setFormData(prev => ({ ...prev, ...normalizedData }));
      setView('preview');
      confetti({ particleCount: 80, spread: 50, origin: { y: 0.8 }, colors: ['#2563eb', '#3b82f6', '#60a5fa'] });
    } catch (error) {
      console.error('Extraction error:', error);
      alert('AI Extraction failed.');
    } finally {
      setIsExtracting(false);
    }
  };

  const generatePDF = async () => {
    setIsGenerating(true);
    try {
      const element = document.getElementById('rc-a4-print');
      if (!element) return;

      // Temporarily make it visible to html2canvas (it can't capture display:none)
      const originalStyle = element.style.cssText;
      element.style.cssText = 'position:fixed; top:0; left:0; width:210mm; height:297mm; z-index:-1; display:block; background:white;';

      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        width: 794,  // ~210mm @ 96dpi
        height: 1123 // ~297mm @ 96dpi
      });

      // Restore hidden state
      element.style.cssText = originalStyle;

      const imgData = canvas.toDataURL('image/png');
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      doc.addImage(imgData, 'PNG', 0, 0, 210, 297);
      doc.save(`RC_${formData.regnNo || 'Vehicle'}.pdf`);
      
      await addDoc(collection(db, 'registrations'), {
        ...formData,
        manufacturingDt: formatManufacturingDtMmYyyy(formData.manufacturingDt || ''),
        issuingAuthority: normalizeIssuingAuthority(formData.issuingAuthority || ''),
        userId: user!.uid,
        userEmail: user!.email,
        createdAt: serverTimestamp(),
      });
      setView('success');
      confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
    } catch (error) {
      console.error('PDF error:', error);
    } finally {
      setIsGenerating(false);
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
        <button onClick={() => signInWithPopup(auth, provider)} className="px-8 py-5 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-[0.2em] text-[11px] hover:bg-blue-700 transition-all shadow-xl shadow-blue-500/20 active:scale-95 flex items-center gap-3">
          Authorize with Google
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FDFDFD] text-slate-900 font-sans">
      <AnimatePresence>
        {isExtracting && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] bg-slate-900/80 backdrop-blur-md flex flex-col items-center justify-center text-white p-6 text-center">
            <div className="relative mb-8">
              <div className="w-24 h-24 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Sparkles className="text-blue-500" size={32} />
              </div>
            </div>
            <h2 className="text-2xl font-black tracking-widest uppercase mb-2">Analyzing RC Card</h2>
            <p className="text-slate-400 font-medium max-w-xs">Our mission-critical AI is extracting your vehicle registration data...</p>
          </motion.div>
        )}
        {showSettings && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] bg-slate-900/80 backdrop-blur-md flex items-center justify-center p-6">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-white rounded-[2.5rem] p-8 max-w-lg w-full shadow-2xl">
              <h2 className="text-2xl font-black text-slate-900 mb-6">AI Rules Engine</h2>
              <textarea value={customPrompt} onChange={(e) => setCustomPrompt(e.target.value)} placeholder="Custom instructions for AI..." rows={5} className="w-full bg-slate-50 border border-slate-100 rounded-3xl p-6 font-bold outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-100/20 transition-all text-sm shadow-sm mb-8 resize-none" />
              <button onClick={() => setShowSettings(false)} className="w-full px-8 py-4 bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest text-xs">Save & Close</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="w-full relative">
        {view === 'mode-selection' && (
          <button onClick={() => setShowSettings(true)} className="absolute top-8 right-8 z-[60] w-14 h-14 bg-white text-slate-400 rounded-2xl flex items-center justify-center hover:text-blue-600 transition-all border border-slate-100 active:scale-90 shadow-sm">
            <Settings size={24} />
          </button>
        )}

        <AnimatePresence mode="wait">
          {view === 'mode-selection' ? (
            <motion.div key="selection" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-4xl mx-auto space-y-12 py-24 px-6 mt-12">
              <div className="text-center space-y-4">
                <h1 className="text-5xl font-black tracking-tight text-slate-900">Vehicle Enrollment</h1>
                <p className="text-slate-400 font-medium text-lg leading-relaxed text-center mx-auto max-w-sm">Scan RC or enter details manually.</p>
              </div>
              <div className="max-w-xl mx-auto relative h-[300px]">
                <input type="file" accept="application/pdf,image/*" onChange={handlePdfUpload} disabled={isExtracting} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                <div className="w-full h-full flex flex-col items-center justify-center p-12 text-center rounded-[3rem] border-[3px] border-dashed border-blue-200 bg-blue-50">
                  <Upload size={40} className="text-blue-600 mb-4" />
                  <h3 className="text-2xl font-black text-slate-900">Drop RC File Here</h3>
                </div>
              </div>
              <div className="text-center flex items-center justify-center gap-6">
                <button onClick={() => setView('form')} className="text-slate-400 font-black uppercase tracking-widest text-sm hover:text-slate-900">Enter Details Manually &rarr;</button>
                <span className="text-slate-200">|</span>
                <button onClick={() => setShowCalibrator(true)} className="flex items-center gap-2 text-purple-500 font-black uppercase tracking-widest text-sm hover:text-purple-700">
                  <Sliders size={14} /> Calibrate Layout
                </button>
              </div>
            </motion.div>
          ) : view === 'form' || view === 'preview' ? (
            <motion.div key="workspace" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col lg:flex-row h-screen overflow-hidden bg-[#FBFBFC]">
              <div className="lg:w-[460px] w-full h-full overflow-y-auto bg-white border-r border-slate-100 p-8 space-y-12 pb-44 no-print custom-scrollbar">
                <div className="flex items-center justify-between sticky top-0 bg-white/95 backdrop-blur-xl z-50 py-4 -translate-y-4 border-b border-slate-50">
                  <button onClick={() => setView('mode-selection')} className="text-slate-400 hover:text-slate-900 flex items-center gap-2 font-black uppercase text-[10px] tracking-widest bg-slate-50 px-4 py-2.5 rounded-xl border border-transparent">
                    <RotateCcw size={14} /> Back
                  </button>
                  <span className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-600">Unified Registry</span>
                </div>
                <div className="space-y-16">
                  <FormSection step={0} formData={formData} onChange={handleInputChange} />
                  <FormSection step={1} formData={formData} onChange={handleInputChange} onManufacturingDtBlur={handleManufacturingDtBlur} />
                  <FormSection step={2} formData={formData} onChange={handleInputChange} />
                  <FormSection step={3} formData={formData} onChange={handleInputChange} />
                  <FormSection step={4} formData={formData} onChange={handleInputChange} onIssuingAuthorityBlur={handleIssuingAuthorityBlur} onSign={handleSignatureChange} signature={signature} />
                </div>
                <div className="fixed bottom-0 left-0 lg:w-[460px] w-full p-6 bg-white/95 backdrop-blur-2xl border-t border-slate-100 z-50 flex gap-4 no-print">
                  <button
                    title="Print to A4"
                    onClick={() => {
                      const printEl = document.getElementById('rc-a4-print');
                      if (!printEl) return;
                      let stylesHtml = '';
                      for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
                        stylesHtml += node.outerHTML;
                      }
                      const printIframe = document.createElement('iframe');
                      printIframe.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:0;height:0;';
                      document.body.appendChild(printIframe);
                      const doc = printIframe.contentWindow?.document;
                      if (doc) {
                        doc.open();
                        doc.write(`<!DOCTYPE html><html><head>${stylesHtml}<style>
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
                        doc.close();
                        setTimeout(() => {
                          printIframe.contentWindow?.focus();
                          printIframe.contentWindow?.print();
                          setTimeout(() => { if (document.body.contains(printIframe)) document.body.removeChild(printIframe); }, 2000);
                        }, 600);
                      }
                    }}
                    className="w-16 h-16 bg-slate-100 text-slate-500 rounded-2xl flex items-center justify-center hover:bg-slate-200"
                  >
                    <Printer size={22} />
                  </button>
                  <button onClick={generatePDF} disabled={isGenerating} className="flex-1 h-16 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-widest shadow-xl flex items-center justify-center gap-4 hover:bg-blue-700">
                    {isGenerating ? 'Generating...' : 'Download Official RC'}
                  </button>
                </div>
              </div>

              <div className="flex-1 flex flex-col h-full bg-[#FAFAFB] relative overflow-hidden">
                <div className="absolute top-8 right-8 flex gap-3 z-40 bg-white/80 backdrop-blur-xl p-2 rounded-2xl border border-slate-200/50 shadow-sm no-print">
                  <button
                    onClick={() => setIsLayoutEditing(v => !v)}
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
              <button onClick={() => { setView('mode-selection'); setFormData(initialData); setSignature(null); }} className="w-full py-6 bg-slate-900 text-white rounded-[2rem] font-black uppercase tracking-widest hover:bg-black transition-all">Start New Enrollment</button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
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

  // Load calibrated positions from localStorage (set by Calibrator tool)
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

  const wrapAt = (value: string, chunkSize: number) => {
    if (!value) return '';
    const cleaned = value.trim();
    const chunks: string[] = [];
    for (let i = 0; i < cleaned.length; i += chunkSize) {
      chunks.push(cleaned.slice(i, i + chunkSize));
    }
    return chunks.join('\n');
  };

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

  // Build a unified field list from calibration positions
  type FieldDef = { key: string; value: string; bold?: boolean; isQR?: boolean; isSig?: boolean;
                    dx: number; dy: number; dw: number; dh: number; dSize: number };
  const FDEFS: FieldDef[] = [
    { key: 'regnNo',          dx: 0.5704, dy: 0.0474 + MAIN_VALUE_Y_NUDGE_IN, dw: 1.1, dh: 0.1, dSize: 8,   bold: true,  value: data.regnNo },
    { key: 'regdOwner',       dx: 0.5704, dy: 0.1445 + MAIN_VALUE_Y_NUDGE_IN, dw: 1.0793, dh: 0.0911, dSize: 7,   bold: true,  value: data.regdOwner },
    { key: 'swdOf',           dx: 0.5694, dy: 0.2337 + MAIN_VALUE_Y_NUDGE_IN, dw: 1.0498, dh: 0.0793, dSize: 7,                value: data.swdOf },
    { key: 'regnDate',        dx: 0.5694, dy: 0.4181 + MAIN_VALUE_Y_NUDGE_IN, dw: 0.8793, dh: 0.0752, dSize: 6.5,              value: data.regnDate },
    { key: 'colour',          dx: 0.5694, dy: 0.4908 + MAIN_VALUE_Y_NUDGE_IN, dw: 0.8321, dh: 0.0723, dSize: 6.5,              value: data.colour },
    { key: 'fuel',            dx: 0.5694, dy: 0.5624 + MAIN_VALUE_Y_NUDGE_IN, dw: 0.8793, dh: 0.0722, dSize: 6.5,              value: data.fuel },
    { key: 'vehicleClass',    dx: 0.5694, dy: 0.6322 + MAIN_VALUE_Y_NUDGE_IN, dw: 0.8616, dh: 0.0752, dSize: 6.5,              value: data.vehicleClass },
    { key: 'bodyType',        dx: 0.5694, dy: 0.7097 + MAIN_VALUE_Y_NUDGE_IN, dw: 0.8645, dh: 0.0723, dSize: 6.5,              value: data.bodyType },
    { key: 'manufacturer',    dx: 0.5694, dy: 0.7795 + MAIN_VALUE_Y_NUDGE_IN, dw: 1.2937, dh: 0.0752, dSize: 6,                value: data.manufacturer },
    { key: 'chassisNo',       dx: 0.5694, dy: 0.8481 + MAIN_VALUE_Y_NUDGE_IN, dw: 1.3262, dh: 0.0811, dSize: 6.5,              value: data.chassisNo },
    { key: 'engineNo',        dx: 0.5694, dy: 0.9268 + MAIN_VALUE_Y_NUDGE_IN, dw: 1.3173, dh: 0.0752, dSize: 6.5,              value: data.engineNo },
    { key: 'modelNo',         dx: 0.5694, dy: 1.0025 + MAIN_VALUE_Y_NUDGE_IN, dw: 1.3646, dh: 0.0782, dSize: 6,   bold: true,  value: data.modelNo },
    { key: 'manufacturingDt', dx: 1.8363 + MFG_VALIDITY_X_NUDGE_IN, dy: 0.3972 + MFG_VALIDITY_Y_NUDGE_IN, dw: 0.4285, dh: 0.09, dSize: 6.5,              value: formatManufacturingDtMmYyyy(data.manufacturingDt || '') },
    { key: 'regdValidity',    dx: 2.8797 + MFG_VALIDITY_X_NUDGE_IN, dy: 0.4002 + MFG_VALIDITY_Y_NUDGE_IN, dw: 0.5962, dh: 0.0959, dSize: 6.5,              value: data.regdValidity },
    { key: 'hypothecatedTo',  dx: 1.6964, dy: 1.1218, dw: 0.9, dh: 0.135, dSize: 5,   bold: true,  value: wrapHypothecatedToValue(data.hypothecatedTo || '') },
    { key: 'unladenWt',       dx: 2.908 + SPEC_GRID_X_NUDGE_IN, dy: 1.1653 + SPEC_GRID_Y_NUDGE_IN, dw: 0.597, dh: 0.0841, dSize: 6,                value: data.unladenWt },
    { key: 'cubicCapacity',   dx: 2.9081 + SPEC_GRID_X_NUDGE_IN, dy: 1.2504 + SPEC_GRID_Y_NUDGE_IN, dw: 0.5793, dh: 0.0723, dSize: 6,                value: data.cubicCapacity },
    { key: 'wheelBase',       dx: 2.908 + SPEC_GRID_X_NUDGE_IN, dy: 1.3239 + SPEC_GRID_Y_NUDGE_IN, dw: 0.5498, dh: 0.0752, dSize: 6,                value: data.wheelBase },
    { key: 'rlw',             dx: 2.908 + SPEC_GRID_X_NUDGE_IN, dy: 1.3973 + SPEC_GRID_Y_NUDGE_IN, dw: 0.5498, dh: 0.0811, dSize: 6,                value: data.rlw },
    { key: 'seatCapacity',    dx: 1.6911 + SPEC_GRID_X_NUDGE_IN, dy: 1.3046 + SPEC_GRID_Y_NUDGE_IN, dw: 0.35, dh: 0.09, dSize: 6.5,              value: data.seatCapacity },
    { key: 'standCapacity',   dx: 1.693 + SPEC_GRID_X_NUDGE_IN, dy: 1.3902 + SPEC_GRID_Y_NUDGE_IN, dw: 0.35, dh: 0.09, dSize: 6.5,              value: data.standCapacity },
    { key: 'noOfCyc',         dx: 2.2859 + SPEC_GRID_X_NUDGE_IN, dy: 1.2957 + SPEC_GRID_Y_NUDGE_IN, dw: 0.35, dh: 0.09, dSize: 6.5,              value: data.noOfCyc },
    { key: 'ownerSerial',     dx: 2.2848 + SPEC_GRID_X_NUDGE_IN, dy: 1.3873 + SPEC_GRID_Y_NUDGE_IN, dw: 0.35, dh: 0.09, dSize: 6.5,              value: data.ownerSerial },
    { key: 'address',         dx: 1.443, dy: 1.5462, dw: 1.5004, dh: 0.2191, dSize: 6,                value: data.address },
    { key: 'issuingAuthority',dx: 1.7278, dy: 1.88, dw: 0.7612, dh: 0.103, dSize: 7,   bold: true,  value: normalizeIssuingAuthority(data.issuingAuthority || '') },
    { key: 'qrCode',          dx: 0.0734 + (0.9954 * (1 - QR_SCALE)) / 2, dy: 1.0935 + (1.0013 * (1 - QR_SCALE)) / 2, dw: 0.9954 * QR_SCALE, dh: 1.0013 * QR_SCALE, dSize: 0,   isQR: true,  value: '' },
    { key: 'signature',       dx: 2.6447, dy: 1.8643, dw: 0.8, dh: 0.12, dSize: 0,   isSig: true, value: '' },
  ];


  // Resolve each field's position from calibration or default
  const resolved = FDEFS.map(f => {
    const templateDefaults = DEFAULT_TEMPLATE_LAYOUT[f.key] ?? {};
    const p = layout?.[f.key] ?? templateDefaults;
    const baseX = p?.x ?? templateDefaults.x ?? f.dx;
    const validityValue = (data.regdValidity || '').trim().toLowerCase();
    const isLongValidity = f.key === 'regdValidity' && validityValue.startsWith('as per fitness');
    return { 
      ...f, 
      x: isLongValidity ? REGD_VALIDITY_LONG_TEXT_X : baseX, 
      y: p?.y ?? templateDefaults.y ?? f.dy, 
      w: p?.w ?? templateDefaults.w ?? f.dw, 
      h: p?.h ?? templateDefaults.h ?? f.dh, 
      size: p?.fontSize ?? templateDefaults.fontSize ?? f.dSize,
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
          <img
            src={CARD_MOCKUP_URL}
            alt="RC card mockup"
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            draggable={false}
            crossOrigin="anonymous"
          />
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
              {f.key === 'address' ? wrapAt(String(f.value || ''), 30) : f.value}
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
              {f.key === 'address' ? wrapAt(String(f.value || ''), 30) : f.value}
            </div>
          );
        })}
      </div>
    </>
  );
}



function FormInput({ label, name, placeholder, type = "text", formData, onChange, onBlur }: any) {
  return (
    <div className="space-y-3">
      <label className="block text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 ml-1">{label}</label>
      <input
        type={type}
        name={name}
        value={formData[name] || ''}
        onChange={onChange}
        onBlur={onBlur}
        placeholder={placeholder}
        className="w-full bg-slate-50/50 border border-slate-100 rounded-2xl px-6 py-5 font-bold focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-100/20 outline-none transition-all placeholder:text-slate-200 text-sm shadow-sm"
      />
    </div>
  );
}

function FormSection({ step, formData, onChange, onManufacturingDtBlur, onIssuingAuthorityBlur, onSign, signature }: any) {
  if (step === 0) return (
    <div className="grid grid-cols-2 gap-8">
      <FormInput formData={formData} onChange={onChange} label="Regn No" name="regnNo" placeholder="HR26EB5601" />
      <FormInput formData={formData} onChange={onChange} label="Regn Date" name="regnDate" placeholder="DD-MM-YYYY" />
      <FormInput formData={formData} onChange={onChange} label="Chassis No" name="chassisNo" placeholder="Full Chassis Number" />
      <FormInput formData={formData} onChange={onChange} label="Engine No" name="engineNo" placeholder="Full Engine Number" />
    </div>
  );
  if (step === 1) return (
    <div className="grid grid-cols-2 gap-8">
      <FormInput formData={formData} onChange={onChange} label="Manufacturer" name="manufacturer" placeholder="Maruti Suzuki" />
      <FormInput formData={formData} onChange={onChange} label="Model" name="modelNo" placeholder="Brezza VDI" />
      <FormInput formData={formData} onChange={onChange} label="Fuel" name="fuel" placeholder="Petrol" />
      <FormInput formData={formData} onChange={onChange} label="Colour" name="colour" placeholder="Pearl White" />
      <FormInput formData={formData} onChange={onChange} label="Body Type" name="bodyType" placeholder="Hatchback" />
      <FormInput formData={formData} onChange={onChange} label="Class" name="vehicleClass" placeholder="Motor Car" />
      <FormInput formData={formData} onChange={onChange} onBlur={onManufacturingDtBlur} label="Mfg. Date" name="manufacturingDt" placeholder="MM/YYYY" />
      <FormInput formData={formData} onChange={onChange} label="Validity" name="regdValidity" placeholder="DD-MM-YYYY" />
    </div>
  );
  if (step === 2) return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-8">
        <FormInput formData={formData} onChange={onChange} label="Regd. Owner" name="regdOwner" placeholder="Full Name" />
        <FormInput formData={formData} onChange={onChange} label="S/D/W Of" name="swdOf" placeholder="Father/Husband Name" />
      </div>
      <div className="space-y-3">
        <label className="block text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 ml-1">Permanent Address</label>
        <textarea
          name="address"
          value={formData.address || ''}
          onChange={onChange}
          rows={3}
          placeholder="Detailed residential address..."
          className="w-full bg-slate-50/50 border border-slate-100 rounded-3xl p-6 font-bold outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-100/20 transition-all text-sm shadow-sm placeholder:text-slate-200"
        />
      </div>
    </div>
  );
  if (step === 3) return (
    <div className="grid grid-cols-2 gap-8">
      <FormInput formData={formData} onChange={onChange} label="Cubic Cap" name="cubicCapacity" placeholder="CC" />
      <FormInput formData={formData} onChange={onChange} label="Seat Cap" name="seatCapacity" placeholder="Total" />
      <FormInput formData={formData} onChange={onChange} label="Stand Cap" name="standCapacity" placeholder="Total" />
      <FormInput formData={formData} onChange={onChange} label="Unladen Wt" name="unladenWt" placeholder="kg" />
      <FormInput formData={formData} onChange={onChange} label="Wheelbase" name="wheelBase" placeholder="mm" />
      <FormInput formData={formData} onChange={onChange} label="RLW" name="rlw" placeholder="kg" />
      <FormInput formData={formData} onChange={onChange} label="No. of Cyl" name="noOfCyc" placeholder="Cylinders" />
      <FormInput formData={formData} onChange={onChange} label="Owner Serial" name="ownerSerial" placeholder="e.g. 01" />
    </div>
  );
  if (step === 4) return (
    <div className="grid grid-cols-2 gap-8">
      <FormInput formData={formData} onChange={onChange} onBlur={onIssuingAuthorityBlur} label="Authority" name="issuingAuthority" placeholder="e.g. SDM Gurgaon or RTA Gurgaon" />
      <FormInput formData={formData} onChange={onChange} label="Hypothecation" name="hypothecatedTo" placeholder="Bank Name" />
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
