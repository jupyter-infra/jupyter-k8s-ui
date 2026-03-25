import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles';

// Import auth utilities for development (makes them available in browser console)
import './utils/auth';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
