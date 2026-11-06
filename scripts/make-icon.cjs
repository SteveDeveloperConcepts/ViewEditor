// Draws the app icon. Run with: npm run icon
// electron-builder turns build/icon.png into the .ico and .icns files it needs.
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" style="display:block">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6a91ff"/>
      <stop offset="1" stop-color="#2f55d4"/>
    </linearGradient>
  </defs>
  <rect x="88" y="88" width="848" height="848" rx="190" fill="url(#bg)"/>
  <rect x="212" y="232" width="600" height="380" rx="56" fill="#fff"/>
  <path d="M452 340 L452 504 L592 422 Z" fill="#2f55d4" stroke="#2f55d4" stroke-width="26" stroke-linejoin="round"/>
  <rect x="212" y="668" width="250" height="72" rx="22" fill="#fff" opacity=".95"/>
  <rect x="490" y="668" width="146" height="72" rx="22" fill="#fff" opacity=".6"/>
  <rect x="664" y="668" width="148" height="72" rx="22" fill="#fff" opacity=".95"/>
  <rect x="540" y="636" width="16" height="136" rx="8" fill="#ffb020"/>
</svg>`;

const HTML = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${SVG}</body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  win.webContents.once('did-finish-load', () => {
    // A moment for the first real frame: the earliest paints are still blank.
    setTimeout(async () => {
      const image = await win.webContents.capturePage();
      const { width, height } = image.getSize();
      const dir = join(__dirname, '..', 'build');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'icon.png'), image.toPNG());
      console.log('wrote build/icon.png', width, height);
      app.quit();
    }, 600);
  });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
});
