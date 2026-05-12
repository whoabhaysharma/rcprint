import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import PublicCreditTopup from './PublicCreditTopup.tsx';
import { MessageDialogProvider } from './components/message-dialog';
import { initAnalytics } from './analytics';
import './index.css';

void initAnalytics();

function isAddCreditsPath(): boolean {
  try {
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    return path === '/add-credits';
  } catch {
    return false;
  }
}

function Root() {
  const [publicTopup, setPublicTopup] = useState(isAddCreditsPath);
  useEffect(() => {
    const onPop = () => setPublicTopup(isAddCreditsPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return publicTopup ? <PublicCreditTopup /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MessageDialogProvider>
      <Root />
    </MessageDialogProvider>
  </StrictMode>,
);
