#!/usr/bin/env node
/**
 * 自动截取小红书素材 7 张图片
 * Usage: npx puppeteer node promo/screenshot.mjs
 */
import puppeteer from 'puppeteer'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const htmlPath = resolve(__dirname, 'xiaohongshu.html')
const outputDir = resolve(__dirname, 'images')

import { mkdirSync } from 'fs'
mkdirSync(outputDir, { recursive: true })

const browser = await puppeteer.launch({ headless: true })
const page = await browser.newPage()
await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 }) // 2x retina

await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
await page.waitForSelector('.slide')

const slides = await page.$$('.slide')
console.log(`Found ${slides.length} slides`)

for (let i = 0; i < slides.length; i++) {
  const path = resolve(outputDir, `cc-soul-${i + 1}.png`)
  await slides[i].screenshot({ path, type: 'png' })
  console.log(`✅ Saved: ${path}`)
}

await browser.close()
console.log(`\n🎉 Done! ${slides.length} images saved to ${outputDir}/`)
