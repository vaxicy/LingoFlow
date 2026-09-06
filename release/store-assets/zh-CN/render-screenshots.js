const path = require('path');
const { chromium } = require('playwright');

const shots = [
  ['screenshot-01-bilingual', '01-bilingual-mode.png'],
  ['screenshot-02-selection', '02-selection-translation.png'],
  ['screenshot-03-engines', '03-translation-engines.png'],
  ['screenshot-04-library', '04-vocabulary-history.png'],
  ['screenshot-05-support', '05-privacy-support.png'],
];

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const htmlPath = path.resolve(__dirname, 'render-screenshots.html');
  await page.goto(`file://${htmlPath.replace(/\\/g, '/')}`);

  for (const [id, filename] of shots) {
    const element = page.locator(`#${id}`);
    await element.screenshot({ path: path.resolve(__dirname, 'screenshots', filename) });
  }

  await browser.close();
})();
