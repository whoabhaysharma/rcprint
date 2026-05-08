import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/src/components/ui/dialog';

export type ShowMessageFn = (message: string, title?: string) => void;

const MessageDialogContext = React.createContext<ShowMessageFn | null>(null);

export function MessageDialogProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState('Notice');
  const [message, setMessage] = React.useState('');

  const show = React.useCallback<ShowMessageFn>((msg, optionalTitle) => {
    setTitle(optionalTitle ?? 'Notice');
    setMessage(msg);
    setOpen(true);
  }, []);

  return (
    <MessageDialogContext.Provider value={show}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-6">
          <DialogHeader>
            <DialogTitle className="text-xl font-black tracking-tight text-slate-900">{title}</DialogTitle>
            <DialogDescription className="whitespace-pre-line pt-1 text-left text-sm font-medium leading-relaxed text-slate-600">
              {message}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-stretch">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="w-full rounded-2xl bg-slate-900 py-4 text-xs font-black uppercase tracking-widest text-white transition-colors hover:bg-black"
            >
              OK
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MessageDialogContext.Provider>
  );
}

export function useMessageDialog(): ShowMessageFn {
  const ctx = React.useContext(MessageDialogContext);
  if (!ctx) {
    throw new Error('useMessageDialog must be used within MessageDialogProvider');
  }
  return ctx;
}
