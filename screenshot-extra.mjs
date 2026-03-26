import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(__dirname, 'xiaohongshu-extra.html');
const outDir = resolve(__dirname, 'xiaohongshu-images');
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1080, height: 1440, deviceScaleFactor: 2 });
await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 2000));

const cards = await page.$$('.C');
for (let i = 0; i < cards.length; i++) {
  const path = resolve(outDir, `13-场景-举一反三.png`);
  await cards[i].screenshot({ path, type: 'png' });
  console.log(`✅ 13-场景-举一反三.png`);
}

await browser.close();
