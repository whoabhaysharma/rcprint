import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { MessageDialogProvider } from './components/message-dialog';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MessageDialogProvider>
      <App />
    </MessageDialogProvider>
  </StrictMode>,
);
