/**
 * Render the app icon.
 *
 *   npx electron scripts/make-icon.cjs
 *
 * The mark is the mockup's own logo glyph — two arrows swapping places — on the app's chrome
 * colour. Drawn as SVG and rasterised by Electron, so there is no image-toolchain dependency
 * just to produce one icon.
 *
 * Writes build/icon.png at 512x512, which electron-builder converts to .ico for Windows.
 */
const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const SIZE = 512;

// Scaled up from the 12x12 glyph in docs/mockup.html, on the app's own --chrome background
// with the --steel stroke, so the icon reads as part of the same design.
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2E4C6D"/>
      <stop offset="100%" stop-color="#141C28"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect x="8" y="8" width="496" height="496" rx="106" fill="none" stroke="#3C6389" stroke-width="10"/>
  <g fill="none" stroke="#8FB6D9" stroke-width="34" stroke-linecap="round" stroke-linejoin="round">
    <path d="M128 192h256M128 192l72-72M128 192l72 72"/>
    <path d="M384 320H128M384 320l-72-72M384 320l-72 72"/>
  </g>
</svg>`.trim();

app.disableHardwareAcceleration();

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });

  const html = `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;background:transparent;width:${SIZE}px;height:${SIZE}px;overflow:hidden}</style>
    ${svg}`;

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // Give the renderer a beat to paint before capturing, or the PNG comes out blank.
  await new Promise((r) => setTimeout(r, 900));

  const image = await win.webContents.capturePage();
  mkdirSync(join(__dirname, "..", "build"), { recursive: true });

  const out = join(__dirname, "..", "build", "icon.png");
  writeFileSync(out, image.toPNG());
  console.log(`icon written: ${out} (${image.getSize().width}x${image.getSize().height})`);

  app.quit();
});
