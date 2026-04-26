/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { jsPDF } from 'jspdf';
import { QRCodeSVG } from 'qrcode.react';
import {
  RotateCcw, Upload, ClipboardCheck, Car, User, Settings,
  ShieldCheck, MapPin, Sparkles, Edit3, CheckCircle2,
  AlertCircle, ChevronRight, ChevronLeft, Search, Printer,
  ZoomIn, ZoomOut
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as pdfjsLib from 'pdfjs-dist';
import html2canvas from 'html2canvas';
import confetti from 'canvas-confetti';
import { auth, provider, db } from './firebase';
import { signInWithPopup, onAuthStateChanged, signOut, User as FirebaseUser } from 'firebase/auth';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

// PDF.js worker setup - using a more robust URL for the worker
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
  regnNo: '',
  regnDate: '',
  manufacturer: '',
  fuel: '',
  vehicleClass: '',
  bodyType: '',
  chassisNo: '',
  engineNo: '',
  modelNo: '',
  regdOwner: '',
  swdOf: '',
  address: '',
  cubicCapacity: '',
  seatCapacity: '',
  standCapacity: '',
  wheelBase: '',
  unladenWt: '',
  noOfCyc: '',
  ownerSerial: '',
  taxPaidUpTo: '',
  regdValidity: '',
  colour: '',
  rlw: '',
  issuingAuthority: 'SDM GURUGRAM',
  purpose: 'PERSONAL',
  hypothecatedTo: '',
  manufacturingDt: '',
};

type AppMode = 'manual' | 'auto';
type AppView = 'mode-selection' | 'form' | 'preview' | 'success';

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

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
    localStorage.setItem('rcCustomPrompt', customPrompt);
  }, [customPrompt]);

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
        // Load the PDF document
        const loadingTask = pdfjsLib.getDocument({
          data: arrayBuffer,
          useSystemFonts: true,
          disableFontFace: true
        });
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 2.5 }); // Higher scale for better OCR
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        if (!context) throw new Error('Could not create canvas context');

        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await page.render({
          canvasContext: context,
          viewport,
          canvas
        }).promise;

        base64Image = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
      } else {
        // Handle images directly
        const reader = new FileReader();
        base64Image = await new Promise((resolve) => {
          reader.onload = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(file);
        });
      }

      const res = await fetch('/api/extractRcData', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ base64Image, customPrompt })
      });

      if (!res.ok) {
        throw new Error('Failed to extract data: ' + await res.text());
      }

      const extractedData = await res.json();

      // Merge with initial data to ensure all keys exist
      setFormData(prev => ({
        ...prev,
        ...extractedData,
        // Ensure non-string values are handled if any (though prompt asks for JSON)
      }));

      // Move to preview view to show the result
      setView('preview');
      confetti({
        particleCount: 80,
        spread: 50,
        origin: { y: 0.8 },
        colors: ['#2563eb', '#3b82f6', '#60a5fa']
      });
    } catch (error) {
      console.error('Extraction error:', error);
      let errorMsg = 'AI Extraction failed.';
      if (error instanceof Error) {
        if (error.message.includes('fetch')) {
          errorMsg = 'Network error: Failed to reach AI service or load worker.';
        } else {
          errorMsg = `Extraction error: ${error.message}`;
        }
      }
      alert(errorMsg);
    } finally {
      setIsExtracting(false);
    }
  };

  const generatePDF = async () => {
    setIsGenerating(true);
    try {
      const element = document.getElementById('rc-card-preview');
      if (!element) return;

      const canvas = await html2canvas(element, { scale: 3, useCORS: true, backgroundColor: '#ffffff' });
      const imgData = canvas.toDataURL('image/png');

      const doc = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: [85.6, 53.98] // ID-1 format
      });

      doc.addImage(imgData, 'PNG', 0, 0, 85.6, 53.98);
      doc.save(`RC_${formData.regnNo || 'Vehicle'}.pdf`);

      await addDoc(collection(db, 'registrations'), {
        ...formData,
        userId: user!.uid,
        userEmail: user!.email,
        createdAt: serverTimestamp()
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
        <button
          onClick={() => signInWithPopup(auth, provider)}
          className="px-8 py-5 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-[0.2em] text-[11px] hover:bg-blue-700 transition-all shadow-xl shadow-blue-500/20 active:scale-95 flex items-center gap-3"
        >
          Authorize with Google
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FDFDFD] text-slate-900 font-sans">
      <AnimatePresence>
        {isExtracting && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-slate-900/80 backdrop-blur-md flex flex-col items-center justify-center text-white p-6 text-center"
          >
            <div className="relative mb-8">
              <div className="w-24 h-24 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Sparkles className="text-blue-500" size={32} />
              </div>
            </div>
            <h2 className="text-2xl font-black tracking-widest uppercase mb-2">Analyzing RC Card</h2>
            <p className="text-slate-400 font-medium max-w-xs">Our mission-critical AI is extracting your vehicle registration data...</p>

            <div className="mt-12 flex gap-2">
              {[0, 1, 2].map(i => (
                <motion.div
                  key={i}
                  animate={{ scale: [1, 1.5, 1], opacity: [0.3, 1, 0.3] }}
                  transition={{ repeat: Infinity, duration: 1, delay: i * 0.2 }}
                  className="w-3 h-3 bg-blue-500 rounded-full shadow-[0_0_15px_rgba(59,130,246,0.5)]"
                />
              ))}
            </div>
          </motion.div>
        )}

        {showSettings && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-slate-900/80 backdrop-blur-md flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="bg-white rounded-[2.5rem] p-8 max-w-lg w-full shadow-2xl"
            >
              <div className="flex items-center gap-4 mb-6">
                <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center">
                  <Settings size={28} />
                </div>
                <h2 className="text-2xl font-black text-slate-900">AI Rules Engine</h2>
              </div>
              <p className="text-slate-500 font-medium mb-6 leading-relaxed">Define custom instructions in plain English to guide the AI extraction (e.g., custom date formatting or parsing logic).</p>

              <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="e.g. Always format dates as '1 Jan 2024'. Ensure addresses include commas."
                rows={5}
                className="w-full bg-slate-50 border border-slate-100 rounded-3xl p-6 font-bold outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-100/20 transition-all text-sm shadow-sm placeholder:text-slate-300 mb-8 resize-none"
              />

              <div className="flex justify-end gap-4">
                <button
                  onClick={() => setShowSettings(false)}
                  className="px-8 py-4 bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-black transition-all active:scale-95"
                >
                  Save & Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="w-full relative">
        {view === 'mode-selection' && (
          <button
            onClick={() => setShowSettings(true)}
            title="AI Rule Configuration"
            className="absolute top-8 right-8 z-[60] w-14 h-14 bg-white text-slate-400 rounded-[1.25rem] flex items-center justify-center hover:text-blue-600 hover:shadow-2xl hover:shadow-blue-500/10 transition-all border border-slate-100 active:scale-90 shadow-sm"
          >
            <Settings size={24} />
          </button>
        )}

        <AnimatePresence mode="wait">
          {view === 'mode-selection' ? (
            <motion.div
              key="selection"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="max-w-4xl mx-auto space-y-12 py-24 px-6 mt-12"
            >
              <div className="text-center space-y-4">
                <h1 className="text-5xl font-black tracking-tight text-slate-900">Vehicle Enrollment</h1>
                <p className="text-slate-400 max-w-sm mx-auto font-medium text-lg leading-relaxed">Choose your registration method to begin. Use AI for instant setup.</p>
              </div>

              <div className="max-w-2xl mx-auto mt-12 relative group h-[400px]">
                <input
                  type="file"
                  accept="application/pdf,image/*"
                  onChange={handlePdfUpload}
                  disabled={isExtracting}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                  title=""
                />
                <div className={`w-full h-full flex flex-col items-center justify-center p-12 text-center rounded-[3rem] border-[3px] border-dashed transition-all duration-300 ${isExtracting ? 'border-blue-300 bg-blue-50/50' : 'border-blue-200 bg-blue-50 hover:bg-blue-100 hover:border-blue-400'}`}>
                  <div className="w-24 h-24 bg-white text-blue-600 rounded-[2rem] flex items-center justify-center mb-8 shadow-xl shadow-blue-500/10 group-hover:scale-110 transition-transform duration-500 shadow-blue-100">
                    {isExtracting ? <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" /> : <Upload size={40} />}
                  </div>
                  <h3 className="text-3xl font-black mb-3 text-slate-900">Drop RC File Here</h3>
                  <p className="text-slate-500 font-medium text-lg">or click to browse from your device</p>
                  <p className="text-[11px] font-black text-blue-600 mt-8 uppercase tracking-[0.2em] bg-white px-6 py-2.5 rounded-full shadow-sm">AI Auto Scan Priority</p>
                </div>
              </div>

              <div className="text-center mt-12 pb-12 z-20 relative">
                <button
                  onClick={() => setView('form')}
                  className="text-slate-400 font-black uppercase tracking-widest text-sm hover:text-slate-900 transition-colors"
                >
                  Or enter details manually &rarr;
                </button>
              </div>
            </motion.div>
          ) : view === 'form' || view === 'preview' ? (
            <motion.div
              key="workspace"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col lg:flex-row h-screen overflow-hidden bg-[#FBFBFC]"
            >
              {/* Left Col: Form Sidebar */}
              <div className="lg:w-[460px] w-full h-full overflow-y-auto bg-white border-r border-slate-100 p-8 space-y-12 pb-44 scroll-smooth custom-scrollbar no-print">
                <div className="flex items-center justify-between mb-8 sticky top-0 bg-white/95 backdrop-blur-xl z-50 py-4 -translate-y-4 border-b border-slate-50">
                  <button
                    onClick={() => setView('mode-selection')}
                    className="text-slate-400 hover:text-slate-900 flex items-center gap-2 font-black uppercase text-[10px] tracking-widest transition-colors bg-slate-50 px-4 py-2.5 rounded-xl border border-transparent hover:border-slate-200"
                  >
                    <RotateCcw size={14} /> Back
                  </button>
                  <div className="flex gap-3 items-center">
                    <div className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
                    <span className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-600">Unified Registry</span>
                  </div>
                </div>

                <div className="space-y-24">
                  <section>
                    <h2 className="text-2xl font-black mb-10 flex items-center gap-4 text-slate-800 tracking-tight">
                      <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shadow-[0_8px_16px_-4px_rgba(37,99,235,0.1)]">
                        <ShieldCheck size={28} />
                      </div>
                      Identity
                    </h2>
                    <FormSection step={0} formData={formData} onChange={handleInputChange} />
                  </section>

                  <section>
                    <h2 className="text-2xl font-black mb-10 flex items-center gap-4 text-slate-800 tracking-tight">
                      <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shadow-[0_8px_16px_-4px_rgba(37,99,235,0.1)]">
                        <Car size={28} />
                      </div>
                      Vehicle
                    </h2>
                    <FormSection step={1} formData={formData} onChange={handleInputChange} />
                  </section>

                  <section>
                    <h2 className="text-2xl font-black mb-10 flex items-center gap-4 text-slate-800 tracking-tight">
                      <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shadow-[0_8px_16px_-4px_rgba(37,99,235,0.1)]">
                        <User size={28} />
                      </div>
                      Owner
                    </h2>
                    <FormSection step={2} formData={formData} onChange={handleInputChange} />
                  </section>

                  <section>
                    <h2 className="text-2xl font-black mb-10 flex items-center gap-4 text-slate-800 tracking-tight">
                      <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shadow-[0_8px_16px_-4px_rgba(37,99,235,0.1)]">
                        <Settings size={28} />
                      </div>
                      Technical
                    </h2>
                    <FormSection step={3} formData={formData} onChange={handleInputChange} />
                  </section>

                  <section>
                    <h2 className="text-2xl font-black mb-10 flex items-center gap-4 text-slate-800 tracking-tight">
                      <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shadow-[0_8px_16px_-4px_rgba(37,99,235,0.1)]">
                        <MapPin size={28} />
                      </div>
                      Authority
                    </h2>
                    <FormSection step={4} formData={formData} onChange={handleInputChange} onSign={handleSignatureChange} signature={signature} />
                  </section>
                </div>

                {/* Sidebar Action Menu */}
                <div className="fixed bottom-0 left-0 lg:w-[460px] w-full p-6 bg-white/95 backdrop-blur-2xl border-t border-slate-100 z-50 flex gap-4 no-print">
                  <button
                    title="Print Pre-Printed Values Only"
                    onClick={() => {
                      const cardEl = document.getElementById('rc-card-preview');
                      if (!cardEl) return;

                      let stylesHtml = '';
                      for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
                        stylesHtml += node.outerHTML;
                      }

                      const printIframe = document.createElement('iframe');
                      printIframe.style.position = 'absolute';
                      printIframe.style.top = '-9999px';
                      printIframe.style.left = '-9999px';
                      printIframe.style.width = '0px';
                      printIframe.style.height = '0px';
                      document.body.appendChild(printIframe);

                      const doc = printIframe.contentWindow?.document;
                      if (doc) {
                        doc.open();
                        doc.write(`
                        <!DOCTYPE html>
                        <html>
                          <head>
                            ${stylesHtml}
                            <style>
                              @page { size: A4 portrait; margin: 0; }
                              body { 
                                margin: 0; 
                                background: white; 
                                -webkit-print-color-adjust: exact !important; 
                                print-color-adjust: exact !important; 
                              }
                              .print-invisible { visibility: hidden !important; color: transparent !important; }
                              .no-print { display: none !important; }
                              #rc-card-preview {
                                position: absolute !important;
                                top: 15mm !important;
                                left: 15mm !important;
                                transform: scale(0.8) !important;
                                transform-origin: top left !important;
                                box-shadow: none !important;
                                border: none !important;
                                background: transparent !important;
                              }
                            </style>
                          </head>
                          <body>
                            ${cardEl.outerHTML}
                          </body>
                        </html>
                      `);
                        doc.close();

                        setTimeout(() => {
                          try {
                            printIframe.contentWindow?.focus();
                            printIframe.contentWindow?.print();
                          } catch (e) {
                            console.error("Print failed:", e);
                          }
                          setTimeout(() => {
                            if (document.body.contains(printIframe)) {
                              document.body.removeChild(printIframe);
                            }
                          }, 2000);
                        }, 500);
                      }
                    }}
                    className="w-[72px] h-16 shrink-0 bg-slate-100 text-slate-500 rounded-2xl flex flex-col items-center justify-center hover:bg-slate-200 hover:text-slate-800 transition-all active:scale-95 border border-slate-200/50"
                  >
                    <Printer size={22} />
                  </button>
                  <button
                    onClick={generatePDF}
                    disabled={isGenerating}
                    className="flex-1 h-16 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-[0.25em] shadow-[0_20px_40px_-10px_rgba(37,99,235,0.3)] flex items-center justify-center gap-4 hover:bg-blue-700 transition-all text-xs group active:scale-95"
                  >
                    {isGenerating ? <div className="w-6 h-6 border-4 border-white/30 border-t-white rounded-full animate-spin" /> : <ClipboardCheck size={20} className="group-hover:rotate-12 transition-transform" />}
                    Download Official RC
                  </button>
                </div>
              </div>

              {/* Right Col: Infinity Preview Canvas */}
              <div className="flex-1 flex flex-col h-full bg-[#FAFAFB] relative overflow-hidden">
                {/* Floating Tool Controls */}
                <div className="absolute top-8 left-8 right-8 flex justify-end items-center z-40 pointer-events-none no-print">
                  <div className="flex items-center gap-4 bg-white/80 backdrop-blur-xl p-2 rounded-2xl border border-slate-200/50 shadow-sm pointer-events-auto">
                    <button
                      onClick={() => setZoom(z => Math.max(0.4, z - 0.1))}
                      className="p-3 hover:bg-slate-50 rounded-xl transition-colors text-slate-400 active:scale-90"
                    >
                      <ZoomOut size={18} />
                    </button>
                    <div className="h-4 w-px bg-slate-100 mx-1" />
                    <span className="text-[11px] font-black text-slate-500 min-w-[45px] text-center tabular-nums">{Math.round(zoom * 100)}%</span>
                    <div className="h-4 w-px bg-slate-100 mx-1" />
                    <button
                      onClick={() => setZoom(z => Math.min(2.5, z + 0.1))}
                      className="p-3 hover:bg-slate-50 rounded-xl transition-colors text-slate-400 active:scale-90"
                    >
                      <ZoomIn size={18} />
                    </button>
                    <button
                      onClick={() => setZoom(1)}
                      className="ml-2 px-3 py-1.5 bg-slate-900 text-white text-[9px] font-black rounded-lg hover:bg-black transition-colors"
                    >
                      RESET
                    </button>
                  </div>
                </div>

                {/* Infinite Scrollable Stage */}
                <div className="flex-1 overflow-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:24px_24px] custom-scrollbar">
                  <div className="min-w-full min-h-full flex items-center justify-center p-40">
                    <motion.div
                      initial={false}
                      animate={{ scale: zoom }}
                      transition={{ type: "tween", ease: "easeInOut", duration: 0.25 }}
                      className="transform-gpu shadow-[0_100px_150px_-50px_rgba(0,0,0,0.15)] rounded-[2.5rem] bg-white ring-1 ring-slate-200"
                    >
                      <CardPreview data={formData} signature={signature} />
                    </motion.div>
                  </div>
                </div>

                {/* Aesthetic Overlay Elements */}
                <div className="absolute bottom-8 left-8 right-8 flex justify-between items-end pointer-events-none z-40 no-print">
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2 opacity-40">
                      <div className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                      <span className="text-[8px] font-black uppercase tracking-[0.5em] text-slate-600">Digital Twin Sync Active</span>
                    </div>
                    <div className="flex items-center gap-2 opacity-40">
                      <div className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                      <span className="text-[8px] font-black uppercase tracking-[0.5em] text-slate-600">Encrypted Metadata Guard</span>
                    </div>
                  </div>

                  <div className="text-right opacity-30">
                    <p className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">Virtual Environment 4.0</p>
                    <p className="text-[8px] font-bold text-slate-400 mt-1">RENDER_LATENCY: 4.2ms</p>
                  </div>
                </div>

                {/* Corner Vignette */}
                <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_50%_50%,transparent_50%,rgba(0,0,0,0.02)_100%)] no-print" />
              </div>
            </motion.div>
          ) : view === 'success' ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-white rounded-[3rem] p-16 text-center shadow-2xl border border-slate-50 max-w-lg mx-auto mt-24"
            >
              <div className="w-24 h-24 bg-green-500 text-white rounded-full flex items-center justify-center mx-auto mb-8 shadow-2xl shadow-green-100">
                <CheckCircle2 size={48} />
              </div>
              <h2 className="text-4xl font-black mb-4 text-slate-900">All Set!</h2>
              <p className="text-slate-400 mb-12 text-lg font-medium leading-relaxed">Your vehicle RC card has been successfully generated and is ready.</p>
              <button
                onClick={() => { setView('mode-selection'); setFormData(initialData); setSignature(null); }}
                className="w-full py-6 bg-slate-900 text-white rounded-[2rem] font-black uppercase tracking-widest hover:bg-black transition-all shadow-2xl shadow-slate-200"
              >
                Start New Enrollment
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* Hidden QR Source */}
        <div ref={qrRef} className="hidden">
          <QRCodeSVG value={JSON.stringify(formData)} size={128} level="H" />
        </div>
      </div>
    </div>
  );
}

function ModeCard({ title, desc, icon, onClick, highlight, isLoading, onFileSelect }: any) {
  return (
    <div
      onClick={!isLoading ? onClick : undefined}
      className={`relative p-10 rounded-[3rem] cursor-pointer transition-all border-2 overflow-hidden group ${highlight ? 'bg-blue-600 border-blue-600 text-white shadow-2xl shadow-blue-100' : 'bg-white border-slate-100 hover:border-blue-200 text-slate-900'}`}
    >
      <div className="relative z-10">
        <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-6 transition-transform group-hover:scale-110 ${highlight ? 'bg-white text-blue-600' : 'bg-blue-50 text-blue-600'}`}>
          {isLoading ? <div className="w-6 h-6 border-4 border-blue-200 border-t-white rounded-full animate-spin" /> : icon}
        </div>
        <h3 className="text-2xl font-black mb-2">{title}</h3>
        <p className={`font-medium ${highlight ? 'text-blue-100' : 'text-slate-400'}`}>{desc}</p>

        {highlight && (
          <>
            <input type="file" id="rc-upload" className="hidden" accept="application/pdf,image/*" onChange={onFileSelect} disabled={isLoading} />
            <label htmlFor="rc-upload" className="mt-8 block w-full py-4 bg-white text-blue-600 rounded-2xl text-center font-black uppercase tracking-widest shadow-xl cursor-pointer hover:bg-blue-50 transition-all">
              {isLoading ? 'Scanning...' : 'Select File'}
            </label>
          </>
        )}
      </div>
      {highlight && <div className="absolute -right-20 -top-20 w-64 h-64 bg-white/10 rounded-full blur-3xl" />}
    </div>
  );
}

function CardPreview({ data, signature }: any) {
  const Field = ({ label, value, isBold }: any) => (
    <div className="flex gap-2 w-full leading-[1.3] text-[13px]">
      <span className="text-gray-700 w-[110px] shrink-0 font-medium print-invisible">{label}</span>
      <span className={`${isBold ? 'font-black text-[13.5px] text-gray-900' : 'font-bold text-gray-800'} uppercase truncate whitespace-nowrap overflow-hidden text-ellipsis`}>{value}</span>
    </div>
  );

  return (
    <div id="rc-card-preview" className="relative w-[856px] h-[540px] bg-white rounded-3xl overflow-hidden font-sans shadow-none border border-transparent mx-auto">
      {/* Background aesthetics */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden no-print">
        {/* Wavy gradients resembling state background lines */}
        <div className="absolute w-[180%] h-[180%] -left-[40%] text-center top-[-40%]" style={{
          background: 'radial-gradient(circle at 70% 30%, rgba(180,240,180,0.4) 0%, rgba(255,220,120,0.1) 40%, transparent 60%)'
        }}>
          <svg viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none" className="opacity-20 animate-[pulse_10s_ease-in-out_infinite]">
            <path d="M0,50 Q25,25 50,50 T100,50 T150,50" fill="none" stroke="#2563eb" strokeWidth="0.2" />
            <path d="M0,60 Q30,30 60,60 T120,60 T180,60" fill="none" stroke="#16a34a" strokeWidth="0.2" />
            <path d="M0,70 Q35,35 70,70 T140,70 T210,70" fill="none" stroke="#d97706" strokeWidth="0.2" />
            <path d="M0,45 Q20,20 40,45 T80,45 T120,45" fill="none" stroke="#ea580c" strokeWidth="0.2" />
            <path d="M0,55 Q25,35 50,55 T100,55 T150,55" fill="none" stroke="#059669" strokeWidth="0.2" />
            <path d="M0,65 Q30,45 60,65 T120,65 T180,65" fill="none" stroke="#0284c7" strokeWidth="0.2" />
          </svg>
        </div>

        {/* Map outline approximation */}
        <div className="absolute top-[10%] bottom-[10%] left-[20%] right-[20%] opacity-20 border-[3px] border-gray-400 rounded-[30%] blur-[1px]"></div>

        {/* HR Logo Watermark */}
        <div className="absolute right-[40px] top-[180px] w-[70px] h-[70px] rounded-full border-4 border-gray-400 opacity-60 flex items-center justify-center bg-transparent backdrop-blur-sm shadow-inner">
          <span className="font-extrabold text-gray-500 text-3xl tracking-tighter">HR</span>
        </div>

        {/* Form-23A text */}
        <div className="absolute right-4 top-1/2 -translate-y-[40px] rotate-90 text-gray-500 tracking-[0.3em] text-lg origin-bottom transform translate-x-full">
          Form-23A
        </div>
      </div>

      <div className="relative z-10 w-full h-[540px] p-8 flex flex-col pt-10">
        {/* Serial Top Right */}
        <div className="absolute top-8 right-12 text-2xl font-black tracking-widest text-[#555] opacity-80">
          <span className="print-invisible">HR</span>{data.ownerSerial || '937133'}
        </div>

        {/* Main Data Split */}
        <div className="flex w-full mt-2 relative z-20">
          {/* Left Values */}
          <div className="w-[58%] flex flex-col space-y-[2px]">
            <Field label="Regn. Number" value={data.regnNo || 'HR26EB5601'} isBold />
            <Field label="Regd. Owner" value={data.regdOwner || 'NEERAJ KUMAR'} isBold />
            <Field label="S/D/W of" value={data.swdOf || 'BIJENDER SINGH'} isBold />
            <Field label="Purpose" value={data.purpose || ''} isBold />
            <Field label="Regn. Date" value={data.regnDate || '02-09-2019'} isBold />
            <Field label="Colour" value={data.colour || 'PEARL ARCTIC WHITE'} />
            <Field label="Fuel" value={data.fuel || 'PETROL'} />
            <Field label="Vehicle Class" value={data.vehicleClass || 'Motor Car'} />
            <Field label="Body Type" value={data.bodyType || 'SALOON CAR'} />
            <Field label="Manufacturar" value={data.manufacturer || 'MARUTI SUZUKI INDIA LTD'} />
            <Field label="Chassis No." value={data.chassisNo || 'MA3NYFB1SKE547342'} />
            <Field label="Engine No." value={data.engineNo || 'D13A-5830650'} />
            <Field label="Model No." value={data.modelNo || 'MARUTI VITARA BREZZA VDI'} />
          </div>

          {/* Right Floating Fields */}
          <div className="w-[42%] relative">
            <div className="absolute left-[30%] top-6 flex flex-col gap-[35px]">
              <div className="flex flex-col">
                <span className="text-gray-700 text-[13px] font-medium leading-none mb-1 print-invisible">Tax Paid Up To</span>
                <span className="font-bold text-[13px] uppercase">{data.taxPaidUpTo || ''}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-gray-700 text-[13px] font-medium leading-none mb-1 print-invisible">Regd. Validity</span>
                <span className="font-bold text-[13px] uppercase">{data.regdValidity || ''}</span>
              </div>
            </div>

            <div className="absolute left-[-20%] top-[70px] text-[13px] flex gap-2 w-48">
              <span className="text-gray-700 font-medium print-invisible">Manufacturing Dt.</span>
              <span className="font-bold uppercase">{data.manufacturingDt || ''}</span>
            </div>
          </div>
        </div>

        {/* Lower Values & QR */}
        <div className="absolute bottom-6 left-8 right-10 flex gap-6 z-20">
          {/* QR Code container */}
          <div className="w-[200px] h-[200px] bg-white border border-gray-100 flex items-center justify-center shrink-0 self-end qr-container">
            <QRCodeSVG
              value={JSON.stringify(data)}
              size={190}
              level="L"
              includeMargin={false}
            />
          </div>

          {/* Metrics Grid */}
          <div className="flex-1 flex flex-col gap-2 pt-2 justify-end pb-1 pr-6">
            <div className="flex mb-1">
              <span className="w-[110px] text-gray-700 font-medium text-[13px] print-invisible">Hypothecated To</span>
              <span className="font-black text-[13px] uppercase">{data.hypothecatedTo || 'ICICI BANK LTD'}</span>
            </div>

            <div className="flex w-full mb-1">
              <div className="flex gap-2 w-[40%]">
                <span className="text-gray-700 text-[13px] font-medium w-[100px] print-invisible">Seat. Capacity</span>
                <span className="font-bold text-[13px]">{data.seatCapacity || '5'}</span>
              </div>
              <div className="flex gap-2 w-[35%] pl-4">
                <span className="text-gray-700 text-[13px] font-medium w-[80px] print-invisible">No. of Cyc</span>
                <span className="font-bold text-[13px]">{data.noOfCyc || '4'}</span>
              </div>
              <div className="flex gap-2 w-[25%] opacity-0"></div>
            </div>

            <div className="flex w-full mb-2">
              <div className="flex gap-2 w-[40%]">
                <span className="text-gray-700 text-[13px] font-medium w-[100px] print-invisible">Stand. Capacity</span>
                <span className="font-bold text-[13px]">{data.standCapacity || '0'}</span>
              </div>
              <div className="flex gap-2 w-[35%] pl-4">
                <span className="text-gray-700 text-[13px] font-medium w-[80px] print-invisible">Owner Serial</span>
                <span className="font-bold text-[13px]">{data.ownerSerial || '01'}</span>
              </div>
              <div className="flex gap-2 w-[25%] opacity-0"></div>
            </div>

            {/* Floating Right Metrics Block */}
            <div className="absolute right-4 bottom-[85px] w-[210px] flex gap-[2px] flex-col z-[25]">
              <div className="flex w-full text-[13px] leading-snug">
                <span className="text-gray-700 font-medium w-[120px] print-invisible">Unladen Wt</span>
                <span className="font-bold ml-auto">{data.unladenWt || '1180'}</span>
              </div>
              <div className="flex w-full text-[13px] leading-snug">
                <span className="text-gray-700 font-medium w-[120px] print-invisible">Cubic Capacity</span>
                <span className="font-bold ml-auto">{data.cubicCapacity || '1248.00'}</span>
              </div>
              <div className="flex w-full text-[13px] leading-snug">
                <span className="text-gray-700 font-medium w-[120px] print-invisible">Wheel Base</span>
                <span className="font-bold ml-auto">{data.wheelBase || '2580'}</span>
              </div>
              <div className="flex w-full text-[13px] leading-snug">
                <span className="text-gray-700 font-medium w-[120px] print-invisible">R.L.W</span>
                <span className="font-bold ml-auto">{data.rlw || '1680'}</span>
              </div>
            </div>

            {/* Address */}
            <div className="flex mb-3 items-start mt-1">
              <span className="w-[60px] text-gray-700 font-medium text-[13px] shrink-0 pt-0.5 print-invisible">Address</span>
              <span className="font-black text-[13.5px] max-w-[320px] leading-[1.25] uppercase tracking-wide">
                {data.address || 'H NO 123 A KHERA DEWATROAD DEWA COLONY, Gurgaon, HR , 122001'}
              </span>
            </div>

            {/* Authority signatures */}
            <div className="flex w-full mt-auto mr-12 items-end justify-between px-6 pt-2">
              <div className="flex flex-col items-center">
                <span className="font-bold text-[13px] mb-[-2px] uppercase tracking-wide">{data.issuingAuthority || 'SDM GURUGRAM'}</span>
                <span className="text-[12px] text-gray-700 print-invisible">Issuing Authority</span>
              </div>
              <div className="flex flex-col items-end pr-2 text-right relative min-h-[40px] justify-end">
                {signature ? (
                  <img src={signature} alt="Sign" className="absolute bottom-4 right-2 h-16 w-32 object-contain mix-blend-multiply opacity-90 scale-125" />
                ) : (
                  <div className="border-b-[1.5px] border-gray-600 w-[140px] mb-1 opacity-50 no-print"></div>
                )}
                <span className="text-[12px] text-gray-700 relative z-10 pt-1 print-invisible">Signature of Issuing Authority</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
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
      <FormInput formData={formData} onChange={onChange} label="Unladen Wt" name="unladenWt" placeholder="kg" />
      <FormInput formData={formData} onChange={onChange} label="Wheelbase" name="wheelBase" placeholder="mm" />
    </div>
  );
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-8">
        <FormInput formData={formData} onChange={onChange} label="Tax Paid Up To" name="taxPaidUpTo" placeholder="Date" />
        <FormInput formData={formData} onChange={onChange} label="Regd. Validity" name="regdValidity" placeholder="Date" />
      </div>
      <div>
        <label className="block text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 mb-6 ml-1">Authority Signature</label>
        <label className="flex flex-col items-center justify-center w-full min-h-[160px] bg-slate-50/50 border-2 border-dashed border-slate-200 rounded-[2.5rem] cursor-pointer hover:bg-blue-50/50 hover:border-blue-200 transition-all shadow-sm">
          <input type="file" className="hidden" onChange={onSign} accept="image/*" />
          {signature ? (
            <div className="relative group/sig">
              <img src={signature} alt="Sign" className="max-h-24 object-contain" />
              <div className="absolute inset-0 bg-blue-600/10 opacity-0 group-hover/sig:opacity-100 transition-opacity flex items-center justify-center rounded-xl">
                <span className="text-[10px] font-black text-blue-600 bg-white px-3 py-1 rounded-full shadow-sm">REPLACE</span>
              </div>
            </div>
          ) : (
            <div className="text-center group">
              <div className="bg-white p-5 rounded-2xl shadow-sm mb-3 mx-auto inline-block group-hover:scale-110 transition-transform">
                <Upload size={28} className="text-blue-500" />
              </div>
              <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.3em]">Tap to Upload Security Mark</p>
            </div>
          )}
        </label>
      </div>
    </div>
  );
}
