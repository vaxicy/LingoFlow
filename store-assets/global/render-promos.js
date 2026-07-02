const path = require('path');
const { chromium } = require('playwright');

const shots = [
  { id: 'top-promo', filename: 'top-promo-1400x560.png', width: 1400, height: 560 },
  { id: 'small-promo', filename: 'small-promo-440x280.png', width: 440, height: 280 },
];

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  const htmlPath = path.resolve(__dirname, 'render-promos.html');

  for (const shot of shots) {
    const page = await browser.newPage({
      viewport: { width: shot.width, height: shot.height },
      deviceScaleFactor: 1,
    });
    await page.goto(`file://${htmlPath.replace(/\\/g, '/')}`);
    await page.locator(`#${shot.id}`).screenshot({
      path: path.resolve(__dirname, shot.filename),
    });
    await page.close();
  }

  await browser.close();
})();
