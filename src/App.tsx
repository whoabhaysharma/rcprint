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
      let base64Image = '';

      if (file.type === 'application/pdf') {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({
          data: arrayBuffer,
          useSystemFonts: true,
          disableFontFace: true
        });
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 2.5 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not create canvas context');
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        await page.render({ canvasContext: context, viewport, canvas }).promise;
        base64Image = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
      } else {
        const reader = new FileReader();
        base64Image = await new Promise((resolve) => {
          reader.onload = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(file);
        });
      }

      const res = await fetch('/api/extractRcData', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64Image, customPrompt })
      });

      if (!res.ok) throw new Error('Failed to extract data: ' + await res.text());
      const extractedData = await res.json();
      setFormData(prev => ({ ...prev, ...extractedData }));
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
      
      await addDoc(collection(db, 'registrations'), { ...formData, userId: user!.uid, userEmail: user!.email, createdAt: serverTimestamp() });
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
                  <FormSection step={1} formData={formData} onChange={handleInputChange} />
                  <FormSection step={2} formData={formData} onChange={handleInputChange} />
                  <FormSection step={3} formData={formData} onChange={handleInputChange} />
                  <FormSection step={4} formData={formData} onChange={handleInputChange} onSign={handleSignatureChange} signature={signature} />
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
                <div className="absolute top-8 right-8 flex gap-4 z-40 bg-white/80 backdrop-blur-xl p-2 rounded-2xl border border-slate-200/50 shadow-sm no-print">
                  <button onClick={() => setZoom(z => Math.max(0.4, z - 0.1))} className="p-3 text-slate-400"><ZoomOut size={18} /></button>
                  <span className="text-[11px] font-black text-slate-500 min-w-[45px] text-center tabular-nums self-center">{Math.round(zoom * 100)}%</span>
                  <button onClick={() => setZoom(z => Math.min(2, z + 0.1))} className="p-3 text-slate-400"><ZoomIn size={18} /></button>
                </div>
                <div className="flex-1 overflow-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:24px_24px] flex items-center justify-center p-12">
                  {/* A4 preview: 210mm/297mm → scale to fit. A4 ratio = 1:1.414 */}
                  <motion.div
                    animate={{ scale: zoom }}
                    className="shadow-[0_40px_80px_-20px_rgba(0,0,0,0.15)] bg-white ring-1 ring-slate-200 relative"
                    style={{ width: '330px', height: '467px', overflow: 'hidden', flexShrink: 0 }}
                  >
                    <CardPreview data={formData} signature={signature} />
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

function CardPreview({ data, signature }: any) {
  // 1 inch = 244.57px on this 856px-wide canvas (856/3.5 = 244.57)
  const PPI = 244.57;

  // Load calibrated positions from localStorage (set by Calibrator tool)
  const getLayout = () => {
    try {
      const saved = localStorage.getItem('rc_calibration_layout');
      if (saved) return JSON.parse(saved);
    } catch {}
    return null;
  };

  const L = getLayout();
  const pos = (key: string, defaultX: number, defaultY: number, defaultSize: number) => {
    const p = L?.[key];
    return { x: p?.x ?? defaultX, y: p?.y ?? defaultY, size: p?.fontSize ?? defaultSize };
  };

  const Value = ({ x, y, size, bold, value }: any) => (
    <div
      className={`absolute leading-none uppercase whitespace-nowrap ${bold ? 'font-bold' : 'font-semibold'}`}
      style={{
        left: `${x * PPI}px`,
        top: `${y * PPI}px`,
        fontSize: `${(size / 72) * PPI}px`,
        color: '#111',
        fontFamily: 'Arial, sans-serif',
      }}
    >
      {value}
    </div>
  );

  // A4 preview dimensions (px)
  const PREVIEW_W = 330;
  const PREVIEW_H = 467; // 330 * (11.69/8.27)
  const PREVIEW_PPI = PREVIEW_W / 8.27; // ~39.9 px/in on preview
  const QR_PREVIEW = Math.round(0.70 * PREVIEW_PPI);
  const QR_PRINT   = Math.round(0.70 * 96); // 96dpi for print

  // Build a unified field list from calibration positions
  type FieldDef = { key: string; value: string; bold?: boolean; isQR?: boolean; isSig?: boolean;
                    dx: number; dy: number; dw: number; dh: number; dSize: number };
  const FDEFS: FieldDef[] = [
    { key: 'regnNo',          dx: 0.5704, dy: 0.0474, dw: 1.1, dh: 0.1, dSize: 8,   bold: true,  value: data.regnNo },
    { key: 'regdOwner',       dx: 0.5704, dy: 0.1445, dw: 1.0793, dh: 0.0911, dSize: 7,   bold: true,  value: data.regdOwner },
    { key: 'swdOf',           dx: 0.5694, dy: 0.2337, dw: 1.0498, dh: 0.0793, dSize: 7,                value: data.swdOf },
    { key: 'regnDate',        dx: 0.5694, dy: 0.4181, dw: 0.8793, dh: 0.0752, dSize: 6.5,              value: data.regnDate },
    { key: 'colour',          dx: 0.5694, dy: 0.4908, dw: 0.8321, dh: 0.0723, dSize: 6.5,              value: data.colour },
    { key: 'fuel',            dx: 0.5694, dy: 0.5624, dw: 0.8793, dh: 0.0722, dSize: 6.5,              value: data.fuel },
    { key: 'vehicleClass',    dx: 0.5694, dy: 0.6322, dw: 0.8616, dh: 0.0752, dSize: 6.5,              value: data.vehicleClass },
    { key: 'bodyType',        dx: 0.5694, dy: 0.7097, dw: 0.8645, dh: 0.0723, dSize: 6.5,              value: data.bodyType },
    { key: 'manufacturer',    dx: 0.5694, dy: 0.7795, dw: 1.2937, dh: 0.0752, dSize: 6,                value: data.manufacturer },
    { key: 'chassisNo',       dx: 0.5694, dy: 0.8481, dw: 1.3262, dh: 0.0811, dSize: 6.5,              value: data.chassisNo },
    { key: 'engineNo',        dx: 0.5694, dy: 0.9268, dw: 1.3173, dh: 0.0752, dSize: 6.5,              value: data.engineNo },
    { key: 'modelNo',         dx: 0.5694, dy: 1.0025, dw: 1.3646, dh: 0.0782, dSize: 6,   bold: true,  value: data.modelNo },
    { key: 'manufacturingDt', dx: 1.8363, dy: 0.3972, dw: 0.4285, dh: 0.09, dSize: 6.5,              value: data.manufacturingDt },
    { key: 'regdValidity',    dx: 2.8797, dy: 0.4002, dw: 0.5962, dh: 0.0959, dSize: 6.5,              value: data.regdValidity },
    { key: 'hypothecatedTo',  dx: 1.6964, dy: 1.1218, dw: 0.9, dh: 0.09, dSize: 6.5,              value: data.hypothecatedTo },
    { key: 'unladenWt',       dx: 2.908, dy: 1.1653, dw: 0.597, dh: 0.0841, dSize: 6,                value: data.unladenWt },
    { key: 'cubicCapacity',   dx: 2.9081, dy: 1.2504, dw: 0.5793, dh: 0.0723, dSize: 6,                value: data.cubicCapacity },
    { key: 'wheelBase',       dx: 2.908, dy: 1.3239, dw: 0.5498, dh: 0.0752, dSize: 6,                value: data.wheelBase },
    { key: 'rlw',             dx: 2.908, dy: 1.3973, dw: 0.5498, dh: 0.0811, dSize: 6,                value: data.rlw },
    { key: 'seatCapacity',    dx: 1.6911, dy: 1.3046, dw: 0.35, dh: 0.09, dSize: 6.5,              value: data.seatCapacity },
    { key: 'standCapacity',   dx: 1.693, dy: 1.3902, dw: 0.35, dh: 0.09, dSize: 6.5,              value: data.standCapacity },
    { key: 'noOfCyc',         dx: 2.2859, dy: 1.2957, dw: 0.35, dh: 0.09, dSize: 6.5,              value: data.noOfCyc },
    { key: 'ownerSerial',     dx: 2.2848, dy: 1.3873, dw: 0.35, dh: 0.09, dSize: 6.5,              value: data.ownerSerial },
    { key: 'address',         dx: 1.443, dy: 1.5462, dw: 1.5004, dh: 0.2191, dSize: 6,                value: data.address },
    { key: 'issuingAuthority',dx: 1.7278, dy: 1.88, dw: 0.7612, dh: 0.103, dSize: 7,   bold: true,  value: data.issuingAuthority },
    { key: 'qrCode',          dx: 0.0734, dy: 1.0935, dw: 0.9954, dh: 1.0013, dSize: 0,   isQR: true,  value: '' },
    { key: 'signature',       dx: 2.6447, dy: 1.8643, dw: 0.8, dh: 0.12, dSize: 0,   isSig: true, value: '' },
  ];


  // Resolve each field's position from calibration or default
  const resolved = FDEFS.map(f => {
    const p = L?.[f.key];
    return { 
      ...f, 
      x: p?.x ?? f.dx, 
      y: p?.y ?? f.dy, 
      w: p?.w ?? f.dw, 
      h: p?.h ?? f.dh, 
      size: p?.fontSize ?? f.dSize 
    };
  });

  return (
    <>
      {/* UI Preview — A4 scaled to 330×467px */}
      <div
        id="rc-card-preview"
        className="relative bg-white font-sans overflow-hidden"
        style={{ width: `${PREVIEW_W}px`, height: `${PREVIEW_H}px` }}
      >
        {resolved.map((f, i) => {
          const left = f.x * PREVIEW_PPI;
          const top  = f.y * PREVIEW_PPI;
          const width = f.w * PREVIEW_PPI;
          const height = f.h * PREVIEW_PPI;

          if (f.isQR) return (
            <div key={i} className="absolute" style={{ left, top, width, height }}>
              <QRCodeSVG value={JSON.stringify(data)} size={width} level="L" />
            </div>
          );
          if (f.isSig) return signature ? (
            <img key={i} src={signature} className="absolute object-contain mix-blend-multiply"
              style={{ left, top, width, height }} />
          ) : null;
          return (
            <div key={i} className={`absolute leading-tight uppercase ${f.bold ? 'font-bold' : 'font-semibold'}`}
              style={{ 
                left, top, width, height, 
                fontSize: `${(f.size / 72) * PREVIEW_PPI}px`, 
                color: '#111', 
                fontFamily: 'Arial, Helvetica, sans-serif',
                whiteSpace: 'nowrap',
                letterSpacing: '0.02em'
              }}>
              {f.value}
            </div>
          );
        })}
      </div>

      {/* Hidden A4 print target — shifted off-screen but display:block for html2canvas */}
      <div id="rc-a4-print" style={{ position: 'fixed', left: '-9999px', top: '-9999px', width: '794px', height: '1123px', background: 'white', display: 'block' }}>
        {resolved.map((f, i) => {
          // Use 96 DPI for stable conversion
          const px = (v: number) => `${v * 96}px`;
          
          if (f.isQR) return (
            <div key={i} className="a4-field" style={{ position: 'absolute', left: px(f.x), top: px(f.y), width: px(f.w), height: px(f.h) }}>
              <QRCodeSVG value={JSON.stringify(data)} size={f.w * 96} level="L" />
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
                fontWeight: f.bold ? 700 : 500, 
                color: '#111',
                textTransform: 'uppercase', 
                whiteSpace: 'nowrap',
                letterSpacing: '0.03em',
                lineHeight: '1',
              }}>
              {f.value}
            </div>
          );
        })}
      </div>
    </>
  );
}



function FormInput({ label, name, placeholder, type = "text", formData, onChange }: any) {
  return (
    <div className="space-y-3">
      <label className="block text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 ml-1">{label}</label>
      <input
        type={type}
        name={name}
        value={formData[name] || ''}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full bg-slate-50/50 border border-slate-100 rounded-2xl px-6 py-5 font-bold focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-100/20 outline-none transition-all placeholder:text-slate-200 text-sm shadow-sm"
      />
    </div>
  );
}

function FormSection({ step, formData, onChange, onSign, signature }: any) {
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
      <FormInput formData={formData} onChange={onChange} label="Mfg. Date" name="manufacturingDt" placeholder="MM/YYYY" />
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
      <FormInput formData={formData} onChange={onChange} label="Authority" name="issuingAuthority" placeholder="SDM Name" />
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
