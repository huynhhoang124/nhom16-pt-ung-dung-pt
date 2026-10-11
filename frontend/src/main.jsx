import { createRoot } from 'react-dom/client';
import App from './App.jsx';
// Font đóng gói vào bản build: chạy offline (phòng thi không có mạng) vẫn đúng font, đủ dấu tiếng Việt.
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import './style.css';

createRoot(document.getElementById('root')).render(<App />);
