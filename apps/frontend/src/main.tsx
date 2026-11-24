import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DialogProvider } from './components/Modal';
import { I18nProvider } from './i18n';
import { ToastProvider } from './lib/toast';
import './styles.css';
import './dashboard.css';
import './shell.css';
import './components.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <DialogProvider>
          <App />
        </DialogProvider>
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
