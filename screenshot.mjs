// Prism — Mobile RWD Screenshot Tool
// Usage: node screenshot.mjs [url]
// Captures screenshots at multiple device sizes

import puppeteer from 'puppeteer';
import { mkdirSync } from 'fs';
import { join } from 'path';

const URL = process.argv[2] || 'http://localhost:3000';
const OUT_DIR = join(import.meta.dirname, 'screen', 'rwd');

const DEVICES = [
  { name: 'iPhone-SE',           width: 320,  height: 568,  dpr: 2 },
  { name: 'iPhone-14',           width: 390,  height: 844,  dpr: 3 },
  { name: 'iPhone-16-Pro-Max',   width: 440,  height: 956,  dpr: 3 },
  { name: 'iPad-Mini',           width: 768,  height: 1024, dpr: 2 },
  { name: 'Desktop-1440',        width: 1440, height: 900,  dpr: 1 },
];

// Tabs to screenshot
const TABS = [
  { name: 'journal',  tab: 'journal' },
  { name: 'margin',   tab: 'margin' },
  { name: 'futures',  tab: 'futures' },
  { name: 'options',  tab: 'options' },
  { name: 'crypto',   tab: 'crypto' },
  { name: 'settings', tab: 'settings' },
];

async function run() {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  for (const device of DEVICES) {
    const page = await browser.newPage();
    await page.setViewport({
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.dpr,
      isMobile: device.width < 1024,
      hasTouch: device.width < 1024,
    });

    // Set dark color scheme
    await page.emulateMediaFeatures([
      { name: 'prefers-color-scheme', value: 'dark' },
    ]);

    console.log(`\n📱 ${device.name} (${device.width}x${device.height} @${device.dpr}x)`);

    // Load page
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await page.waitForSelector('#app', { timeout: 5000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500)); // wait for async renders

    for (const tab of TABS) {
      // Click tab
      const clicked = await page.evaluate((tabName) => {
        const btn = document.querySelector(`.main-tab[data-tab="${tabName}"]`);
        if (btn) { btn.click(); return true; }
        return false;
      }, tab.tab);

      if (!clicked) {
        console.log(`  ⏭ ${tab.name} — tab not found`);
        continue;
      }

      await new Promise(r => setTimeout(r, 800)); // wait for tab render

      // Full page screenshot
      const filename = `${device.name}_${tab.name}.png`;
      await page.screenshot({
        path: join(OUT_DIR, filename),
        fullPage: true,
      });
      console.log(`  ✅ ${filename}`);
    }

    await page.close();
  }

  await browser.close();
  console.log(`\n📁 Screenshots saved to: ${OUT_DIR}`);
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
