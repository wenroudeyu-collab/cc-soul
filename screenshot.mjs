import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(__dirname, 'xiaohongshu-cards.html');
const outDir = resolve(__dirname, 'xiaohongshu-images');

import { mkdirSync } from 'fs';
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1080, height: 1440, deviceScaleFactor: 2 });
await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

// Wait for fonts
await new Promise(r => setTimeout(r, 2000));

const cards = await page.$$('.C');
const names = [
  '01-封面', '02-场景-记住一切', '03-场景-不会附和', '04-场景-察言观色',
  '05-全功能对比', '06-六大核心系统', '07-场景-读懂报错',
  '08-场景-主动找你', '09-安装', '10-数据说话', '11-总结', '12-结语'
];

for (let i = 0; i < cards.length; i++) {
  const path = resolve(outDir, `${names[i]}.png`);
  await cards[i].screenshot({ path, type: 'png' });
  console.log(`✅ ${names[i]}.png`);
}

await browser.close();
console.log(`\n📁 图片保存在: ${outDir}`);
