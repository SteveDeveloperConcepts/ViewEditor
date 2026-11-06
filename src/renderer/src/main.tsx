import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initLibrary } from './store/library';
import './styles/base.css';
import './styles/components.css';
import './styles/app.css';
import './styles/editor.css';

void initLibrary();
createRoot(document.getElementById('root')!).render(<App />);
