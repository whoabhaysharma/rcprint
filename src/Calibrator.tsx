/**
 * RC Form Field Calibrator — A4 Edition
 * Upload full A4 blank form, drag + RESIZE field boxes, save/export JSON.
 * Features: Zooming, Thin Borders, Precise Placement.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Download, Upload, Save, RotateCcw, Eye, EyeOff, ZoomIn, ZoomOut, Maximize } from 'lucide-react';

const A4_W_IN = 8.27;
const A4_H_IN = 11.69;

// Base width at 100% zoom
const BASE_CANVAS_W = 700;

const LS_KEY = 'rc_calibration_layout';

/** Seat/stand/cyl/serial + weight/CC/wheel/RLW; match App preview. */
const SPEC_GRID_X_NUDGE_IN = -0.028;
const SPEC_GRID_Y_NUDGE_IN = 0.018;
/** Match App preview: mfg + regd validity vs mockup. */
const MFG_VALIDITY_X_NUDGE_IN = -0.028;
const MFG_VALIDITY_Y_NUDGE_IN = 0.018;
/** Match App preview: nudge main column values down vs mockup labels. */
const MAIN_VALUE_Y_NUDGE_IN = 0.017;
const QR_SCALE = 0.955;
const QR_CAL_BASE = { x: 0.0734, y: 1.0935, w: 0.9954, h: 1.0013 } as const;

// x, y, w, h in inches; fontSize in pt
const DEFAULT_LAYOUT: Record<string, { x: number; y: number; w: number; h: number; fontSize: number }> = {
  "regnNo": { "x": 0.5704, "y": 0.0474 + MAIN_VALUE_Y_NUDGE_IN, "w": 1.1, "h": 0.1, "fontSize": 8 },
  "regdOwner": { "x": 0.5704, "y": 0.1445 + MAIN_VALUE_Y_NUDGE_IN, "w": 1.0793, "h": 0.0911, "fontSize": 7 },
  "swdOf": { "x": 0.5694, "y": 0.2337 + MAIN_VALUE_Y_NUDGE_IN, "w": 1.0498, "h": 0.0793, "fontSize": 7 },
  "regnDate": { "x": 0.5694, "y": 0.4181 + MAIN_VALUE_Y_NUDGE_IN, "w": 0.8793, "h": 0.0752, "fontSize": 6.5 },
  "colour": { "x": 0.5694, "y": 0.4908 + MAIN_VALUE_Y_NUDGE_IN, "w": 0.8321, "h": 0.0723, "fontSize": 6.5 },
  "fuel": { "x": 0.5694, "y": 0.5624 + MAIN_VALUE_Y_NUDGE_IN, "w": 0.8793, "h": 0.0722, "fontSize": 6.5 },
  "vehicleClass": { "x": 0.5694, "y": 0.6322 + MAIN_VALUE_Y_NUDGE_IN, "w": 0.8616, "h": 0.0752, "fontSize": 6.5 },
  "bodyType": { "x": 0.5694, "y": 0.7097 + MAIN_VALUE_Y_NUDGE_IN, "w": 0.8645, "h": 0.0723, "fontSize": 6.5 },
  "manufacturer": { "x": 0.5694, "y": 0.7795 + MAIN_VALUE_Y_NUDGE_IN, "w": 1.2937, "h": 0.0752, "fontSize": 6 },
  "chassisNo": { "x": 0.5694, "y": 0.8481 + MAIN_VALUE_Y_NUDGE_IN, "w": 1.3262, "h": 0.0811, "fontSize": 6.5 },
  "engineNo": { "x": 0.5694, "y": 0.9268 + MAIN_VALUE_Y_NUDGE_IN, "w": 1.3173, "h": 0.0752, "fontSize": 6.5 },
  "modelNo": { "x": 0.5694, "y": 1.0025 + MAIN_VALUE_Y_NUDGE_IN, "w": 1.3646, "h": 0.0782, "fontSize": 6 },
  "manufacturingDt": { "x": 1.8363 + MFG_VALIDITY_X_NUDGE_IN, "y": 0.3972 + MFG_VALIDITY_Y_NUDGE_IN, "w": 0.4285, "h": 0.09, "fontSize": 6.5 },
  "regdValidity": { "x": 2.8797 + MFG_VALIDITY_X_NUDGE_IN, "y": 0.4002 + MFG_VALIDITY_Y_NUDGE_IN, "w": 0.5962, "h": 0.0959, "fontSize": 6.5 },
  "hypothecatedTo": { "x": 1.6964, "y": 1.1218, "w": 0.9, "h": 0.09, "fontSize": 6.5 },
  "unladenWt": { "x": 2.908 + SPEC_GRID_X_NUDGE_IN, "y": 1.1653 + SPEC_GRID_Y_NUDGE_IN, "w": 0.597, "h": 0.0841, "fontSize": 6 },
  "cubicCapacity": { "x": 2.9081 + SPEC_GRID_X_NUDGE_IN, "y": 1.2504 + SPEC_GRID_Y_NUDGE_IN, "w": 0.5793, "h": 0.0723, "fontSize": 6 },
  "wheelBase": { "x": 2.908 + SPEC_GRID_X_NUDGE_IN, "y": 1.3239 + SPEC_GRID_Y_NUDGE_IN, "w": 0.5498, "h": 0.0752, "fontSize": 6 },
  "rlw": { "x": 2.908 + SPEC_GRID_X_NUDGE_IN, "y": 1.3973 + SPEC_GRID_Y_NUDGE_IN, "w": 0.5498, "h": 0.0811, "fontSize": 6 },
  "seatCapacity": { "x": 1.6911 + SPEC_GRID_X_NUDGE_IN, "y": 1.3046 + SPEC_GRID_Y_NUDGE_IN, "w": 0.35, "h": 0.09, "fontSize": 6.5 },
  "standCapacity": { "x": 1.693 + SPEC_GRID_X_NUDGE_IN, "y": 1.3902 + SPEC_GRID_Y_NUDGE_IN, "w": 0.35, "h": 0.09, "fontSize": 6.5 },
  "noOfCyc": { "x": 2.2859 + SPEC_GRID_X_NUDGE_IN, "y": 1.2957 + SPEC_GRID_Y_NUDGE_IN, "w": 0.35, "h": 0.09, "fontSize": 6.5 },
  "ownerSerial": { "x": 2.2848 + SPEC_GRID_X_NUDGE_IN, "y": 1.3873 + SPEC_GRID_Y_NUDGE_IN, "w": 0.35, "h": 0.09, "fontSize": 6.5 },
  "address": { "x": 1.443, "y": 1.5462, "w": 1.5004, "h": 0.2191, "fontSize": 6 },
  "qrCode": {
    "x": QR_CAL_BASE.x + (QR_CAL_BASE.w * (1 - QR_SCALE)) / 2,
    "y": QR_CAL_BASE.y + (QR_CAL_BASE.h * (1 - QR_SCALE)) / 2,
    "w": QR_CAL_BASE.w * QR_SCALE,
    "h": QR_CAL_BASE.h * QR_SCALE,
    "fontSize": 0,
  },
  "issuingAuthority": { "x": 1.7278, "y": 1.88, "w": 0.7612, "h": 0.103, "fontSize": 7 },
  "signature": { "x": 2.6447, "y": 1.8643, "w": 0.8, "h": 0.12, "fontSize": 0 },
};


const FIELDS: { key: string; label: string; color: string }[] = [
  { key: 'regnNo',          label: 'Regn. No.',      color: '#ef4444' },
  { key: 'regdOwner',       label: 'Owner Name',     color: '#ef4444' },
  { key: 'swdOf',           label: 'S/D/W of',       color: '#ef4444' },
  { key: 'regnDate',        label: 'Regn. Date',     color: '#2563eb' },
  { key: 'colour',          label: 'Colour',          color: '#2563eb' },
  { key: 'fuel',            label: 'Fuel',            color: '#2563eb' },
  { key: 'vehicleClass',    label: 'Vehicle Class',  color: '#2563eb' },
  { key: 'bodyType',        label: 'Body Type',      color: '#2563eb' },
  { key: 'manufacturer',    label: 'Manufacturer',   color: '#2563eb' },
  { key: 'chassisNo',       label: 'Chassis No.',    color: '#2563eb' },
  { key: 'engineNo',        label: 'Engine No.',     color: '#2563eb' },
  { key: 'modelNo',         label: 'Model No.',      color: '#2563eb' },
  { key: 'manufacturingDt', label: 'Mfg. Date',     color: '#7c3aed' },
  { key: 'regdValidity',    label: 'Validity',       color: '#7c3aed' },
  { key: 'hypothecatedTo',  label: 'Bank/Hyp',       color: '#d97706' },
  { key: 'unladenWt',       label: 'Unladen Wt',     color: '#059669' },
  { key: 'cubicCapacity',   label: 'CC',             color: '#059669' },
  { key: 'wheelBase',       label: 'Wheelbase',      color: '#059669' },
  { key: 'rlw',             label: 'RLW',            color: '#059669' },
  { key: 'seatCapacity',    label: 'Seat Cap',       color: '#0891b2' },
  { key: 'standCapacity',   label: 'Stand Cap',      color: '#0891b2' },
  { key: 'noOfCyc',         label: 'Cyl',            color: '#0891b2' },
  { key: 'ownerSerial',     label: 'Serial',         color: '#0891b2' },
  { key: 'address',         label: 'Address',        color: '#be185d' },
  { key: 'qrCode',          label: 'QR Code',        color: '#374151' },
  { key: 'issuingAuthority',label: 'Authority',      color: '#92400e' },
  { key: 'signature',       label: 'Signature',      color: '#92400e' },
];

type Layout = Record<string, { x: number; y: number; w: number; h: number; fontSize: number }>;

export default function Calibrator({ onBack }: { onBack: () => void }) {
  const [bgImage, setBgImage] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const canvasWidth = BASE_CANVAS_W * zoom;
  const canvasHeight = Math.round(canvasWidth * (A4_H_IN / A4_W_IN));
  const ppiX = canvasWidth / A4_W_IN;
  const ppiY = canvasHeight / A4_H_IN;

  const loadSaved = (): Layout => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        const out: Layout = {};
        for (const key of Object.keys(DEFAULT_LAYOUT)) {
          const d = DEFAULT_LAYOUT[key];
          const p = parsed[key] ?? {};
          out[key] = {
            x: p.x ?? d.x, y: p.y ?? d.y,
            w: p.w ?? d.w, h: p.h ?? d.h,
            fontSize: p.fontSize ?? d.fontSize,
          };
        }
        return out;
      }
    } catch { }
    return JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
  };

  const [layout, setLayout] = useState<Layout>(loadSaved);
  const [dragging, setDragging] = useState<string | null>(null);
  const [resizing, setResizing] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [resizeStart, setResizeStart] = useState({ mouseX: 0, mouseY: 0, w: 0, h: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [saved, setSaved] = useState(false);

  const onBoxMouseDown = useCallback((e: React.MouseEvent, key: string) => {
    if ((e.target as HTMLElement).dataset.resize) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(key);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pos = layout[key];
    setDragOffset({
      x: e.clientX - rect.left - pos.x * ppiX,
      y: e.clientY - rect.top - pos.y * ppiY,
    });
    setDragging(key);
  }, [layout, ppiX, ppiY]);

  const onResizeMouseDown = useCallback((e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(key);
    const pos = layout[key];
    setResizeStart({ mouseX: e.clientX, mouseY: e.clientY, w: pos.w, h: pos.h });
    setResizing(key);
  }, [layout]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    if (dragging) {
      const rawPx = e.clientX - rect.left - dragOffset.x;
      const rawPy = e.clientY - rect.top - dragOffset.y;
      const x = +Math.max(0, Math.min(rawPx, canvasWidth) / ppiX).toFixed(4);
      const y = +Math.max(0, Math.min(rawPy, canvasHeight) / ppiY).toFixed(4);
      setLayout(prev => ({ ...prev, [dragging]: { ...prev[dragging], x, y } }));
    }

    if (resizing) {
      const dx = e.clientX - resizeStart.mouseX;
      const dy = e.clientY - resizeStart.mouseY;
      const w = +Math.max(0.05, resizeStart.w + dx / ppiX).toFixed(4);
      const h = +Math.max(0.03, resizeStart.h + dy / ppiY).toFixed(4);
      setLayout(prev => ({ ...prev, [resizing]: { ...prev[resizing], w, h } }));
    }
  }, [dragging, resizing, dragOffset, resizeStart, ppiX, ppiY, canvasWidth, canvasHeight]);

  const onMouseUp = useCallback(() => {
    setDragging(null);
    setResizing(null);
  }, []);

  const saveToLocalStorage = () => {
    localStorage.setItem(LS_KEY, JSON.stringify(layout));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'rc_a4_layout.json'; a.click();
    URL.revokeObjectURL(url);
  };

  const resetLayout = () => { setLayout(JSON.parse(JSON.stringify(DEFAULT_LAYOUT))); setSelected(null); };

  const selField = FIELDS.find(f => f.key === selected);
  const selPos = selected ? layout[selected] : null;

  const updateField = (key: keyof typeof DEFAULT_LAYOUT[string], val: string) => {
    if (!selected) return;
    const n = parseFloat(val);
    if (!isNaN(n)) setLayout(prev => ({ ...prev, [selected]: { ...prev[selected], [key]: n } }));
  };

  return (
    <div className="min-h-screen bg-[#0a0c10] text-[#e1e4e8] flex flex-col font-sans select-none">
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="h-14 flex items-center gap-3 px-5 bg-[#161b22] border-b border-[#30363d] flex-shrink-0">
        <button onClick={onBack} className="text-[#8b949e] hover:text-white text-xs font-black uppercase tracking-widest pl-2">← Back</button>
        <div className="w-px h-6 bg-[#30363d]" />
        <span className="text-sm font-black uppercase tracking-widest">A4 Precision Calibrator</span>
        
        <div className="flex items-center bg-[#0d1117] rounded-lg border border-[#30363d] p-1 ml-4">
          <button onClick={() => setZoom(z => Math.max(0.5, z - 0.25))} className="p-1.5 hover:bg-[#21262d] rounded-md transition-colors"><ZoomOut size={14}/></button>
          <span className="px-3 text-[11px] font-bold text-[#8b949e] tabular-nums">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(4, z + 0.25))} className="p-1.5 hover:bg-[#21262d] rounded-md transition-colors"><ZoomIn size={14}/></button>
          <button onClick={() => setZoom(1)} className="p-1.5 hover:text-blue-400 ml-1" title="Reset Zoom"><Maximize size={12}/></button>
        </div>

        <div className="flex-1" />

        <label className="cursor-pointer flex items-center gap-2 px-3 py-2 bg-[#21262d] hover:bg-[#30363d] rounded-lg text-sm font-bold border border-[#30363d] transition-colors">
          <Upload size={13} /> Upload A4 Form Scan
          <input type="file" accept="image/*" className="hidden" onChange={e => {
            const file = e.target.files?.[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => setBgImage(ev.target?.result as string);
            reader.readAsDataURL(file);
          }} />
        </label>

        <button onClick={() => setShowLabels(v => !v)} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-bold border transition-colors ${showLabels ? 'bg-blue-900/50 border-blue-500/50 text-blue-400' : 'bg-[#21262d] border-[#30363d] text-[#8b949e]'}`}>
          {showLabels ? <Eye size={13} /> : <EyeOff size={13} />} Labels
        </button>

        <button onClick={resetLayout} className="flex items-center gap-2 px-3 py-2 bg-[#21262d] hover:bg-[#30363d] rounded-lg text-sm font-bold border border-[#30363d] text-amber-500/80 transition-colors">
          <RotateCcw size={13} /> Reset
        </button>

        <button onClick={saveToLocalStorage}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-black border uppercase tracking-widest transition-all ${saved ? 'bg-green-600 border-green-500 shadow-[0_0_20px_rgba(34,197,94,0.3)]' : 'bg-[#21262d] border-[#30363d] text-green-500'}`}>
          <Save size={13} /> {saved ? 'Saved!' : 'Save'}
        </button>

        <button onClick={exportJSON} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-black uppercase tracking-widest shadow-lg shadow-blue-900/20">
          <Download size={13} /> Export
        </button>
      </div>

      {/* ── Main Layout ──────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden" onMouseMove={onMouseMove} onMouseUp={onMouseUp}>

        {/* Viewport Area */}
        <div 
          ref={containerRef}
          className="flex-1 overflow-auto bg-[#0d1117] p-12 scrollbar-thin scrollbar-thumb-[#30363d] scrollbar-track-transparent h-full scroll-smooth"
        >
          <div
            ref={canvasRef}
            className="mx-auto bg-white relative transition-[width,height] duration-200"
            style={{
              width: `${canvasWidth}px`,
              height: `${canvasHeight}px`,
              boxShadow: '0 0 0 1px #30363d, 0 32px 64px rgba(0,0,0,0.5)',
            }}
          >
            {/* Form Image */}
            {bgImage ? (
              <img src={bgImage} alt="form" className="absolute inset-0 w-full h-full object-fill pointer-events-none" />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-[#8b949e] border-2 border-dashed border-[#30363d]">
                <Upload size={48} className="mb-4 opacity-20" />
                <p className="text-base font-bold">Waiting for A4 Scan...</p>
                <p className="text-xs mt-2 opacity-50">Upload a high-res JPG/PNG of your blank form</p>
              </div>
            )}

            {/* Grid Rules */}
            <svg className="absolute inset-0 pointer-events-none z-10" width="100%" height="100%">
              {/* Vertical Inch Lines */}
              {Array.from({ length: 9 }, (_, i) => (
                <line key={`v${i}`} x1={i * ppiX} y1={0} x2={i * ppiX} y2="100%" stroke="#e1e4e8" strokeWidth={1/zoom} strokeDasharray="4,4" opacity={0.3} />
              ))}
              {/* Horizontal Inch Lines */}
              {Array.from({ length: 12 }, (_, i) => (
                <line key={`h${i}`} x1={0} y1={i * ppiY} x2="100%" y2={i * ppiY} stroke="#e1e4e8" strokeWidth={1/zoom} strokeDasharray="4,4" opacity={0.3} />
              ))}
            </svg>

            {/* Ruler Numbers */}
            <div className="absolute top-0 left-0 right-0 h-4 flex pointer-events-none z-20">
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} style={{ width: ppiX }} className="border-r border-[#e1e4e8]/20 flex items-end justify-end pr-1 pb-0.5">
                  <span className="text-[7px] text-[#8b949e] font-mono leading-none">{i}</span>
                </div>
              ))}
            </div>

            {/* ── Drag/Resize Boxes ─────────────────────────────────── */}
            {FIELDS.map(field => {
              const pos = layout[field.key];
              if (!pos) return null;
              const isSel = selected === field.key;
              const left  = pos.x * ppiX;
              const top   = pos.y * ppiY;
              const width = pos.w * ppiX;
              const height = pos.h * ppiY;

              return (
                <div
                  key={field.key}
                  onMouseDown={e => onBoxMouseDown(e, field.key)}
                  className="absolute"
                  style={{
                    left, top, width, height,
                    border: `${1 / zoom}px solid ${field.color}`, // Ultra thin borders based on zoom
                    backgroundColor: isSel ? `${field.color}25` : `${field.color}08`,
                    cursor: dragging === field.key ? 'grabbing' : 'crosshair',
                    zIndex: isSel ? 100 : 50,
                  }}
                >
                  {showLabels && (
                    <div className="absolute -top-[1.2em] left-0 pointer-events-none overflow-visible whitespace-nowrap">
                      <span 
                        className="font-black tracking-tighter"
                        style={{ color: field.color, fontSize: Math.max(7, 9 / zoom), textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}
                      >
                        {field.label}
                      </span>
                    </div>
                  )}

                  {/* Corner Resize Handle */}
                  <div
                    data-resize="1"
                    onMouseDown={e => onResizeMouseDown(e, field.key)}
                    className="absolute"
                    style={{
                      right: -2, bottom: -2,
                      width: Math.max(4, 6/zoom), height: Math.max(4, 6/zoom),
                      backgroundColor: isSel ? field.color : 'transparent',
                      border: isSel ? 'none' : `${1/zoom}px solid ${field.color}`,
                      cursor: 'nwse-resize',
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Sidebar ────────────────────────────────────────────────────── */}
        <div className="w-80 bg-[#161b22] border-l border-[#30363d] flex flex-col">
          <div className="p-6 border-b border-[#30363d]">
            <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-[#8b949e] mb-5">Inspector</h2>
            
            {selField && selPos ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 bg-[#0d1117] p-3 rounded-lg border border-[#30363d]">
                  <div className="w-3 h-3 rounded-sm flex-shrink-0 shadow-sm" style={{ backgroundColor: selField.color }} />
                  <div className="font-bold text-xs truncate">{selField.label}</div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {(['x', 'y', 'w', 'h'] as const).map(k => (
                    <div key={k} className="space-y-1.5">
                      <label className="text-[9px] font-black uppercase tracking-widest text-[#484f58] ml-1">{k}</label>
                      <input
                        type="number" step="0.001" value={selPos[k]}
                        onChange={e => updateField(k, e.target.value)}
                        className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-3 py-1.5 font-bold text-xs text-white focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 outline-none transition-all tabular-nums"
                      />
                    </div>
                  ))}
                </div>

                <div className="space-y-1.5">
                  <label className="text-[9px] font-black uppercase tracking-widest text-[#484f58] ml-1">Font Size (pt)</label>
                  <input
                    type="number" step="0.5" value={selPos.fontSize}
                    onChange={e => updateField('fontSize', e.target.value)}
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-3 py-1.5 font-bold text-xs text-white focus:border-blue-500/50 outline-none transition-all tabular-nums"
                  />
                </div>
              </div>
            ) : (
              <div className="py-12 px-6 text-center border border-dashed border-[#30363d] rounded-xl">
                <p className="text-[11px] text-[#8b949e]">Select a block on the workspace to calibrate its metadata.</p>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-2 scrollbar-thin scrollbar-thumb-[#30363d] scrollbar-track-transparent">
            {FIELDS.map(f => {
              const p = layout[f.key];
              return (
                <button
                  key={f.key}
                  onClick={() => setSelected(f.key)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-md transition-all text-left group mb-0.5 ${selected === f.key ? 'bg-[#21262d] ring-1 ring-inset ring-[#30363d]' : 'hover:bg-[#1f242c]'}`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: f.color }} />
                    <span className={`text-[11px] font-bold truncate ${selected === f.key ? 'text-white' : 'text-[#8b949e]'}`}>{f.label}</span>
                  </div>
                  {p && <span className="text-[9px] font-mono text-[#484f58] group-hover:text-[#8b949e]">{p.x.toFixed(2)},{p.y.toFixed(2)}</span>}
                </button>
              );
            })}
          </div>

          <div className="p-6 bg-[#0d1117]/50 border-t border-[#30363d]">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
              <span className="text-[9px] font-black uppercase text-[#8b949e]">System Ready</span>
            </div>
            <p className="text-[10px] text-[#484f58] leading-relaxed">
              Use mouse wheel to zoom, or the toolbar controls. Click "Save" to apply changes globally.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
