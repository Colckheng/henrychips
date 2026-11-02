import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { recoverRuns } from './run-store.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
document.documentElement.lang = 'zh-CN';
void recoverRuns();
createRoot(root).render(<StrictMode><App /></StrictMode>);
