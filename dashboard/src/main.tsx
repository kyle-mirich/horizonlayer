import '@fontsource-variable/manrope';
import '@fontsource-variable/recursive/casl.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { DashboardErrorBoundary } from './components/DashboardErrorBoundary';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Dashboard root element is missing');

createRoot(root).render(
  <StrictMode>
    <DashboardErrorBoundary>
      <App />
    </DashboardErrorBoundary>
  </StrictMode>
);
