const { chromium } = require("playwright");

async function scrapeSite(url, label) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(url, { timeout: 30000, waitUntil: "networkidle" });
    await page.waitForTimeout(3000);

    // Try to find and click review links
    const reviewLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a[href]"))
        .filter((a) => /отзыв|review|rating/i.test(a.textContent + a.href))
        .map((a) => ({
          text: a.textContent.trim().substring(0, 80),
          href: a.href,
        }))
        .slice(0, 10);
    });
    console.log(`=== ${label} - REVIEW LINKS ===`);
    console.log(JSON.stringify(reviewLinks, null, 2));

    // If there's a review page, navigate to it
    if (reviewLinks.length > 0 && reviewLinks[0].href) {
      const reviewUrl = reviewLinks[0].href.startsWith("http")
        ? reviewLinks[0].href
        : url + reviewLinks[0].href;
      if (reviewUrl !== url) {
        await page.goto(reviewUrl, {
          timeout: 30000,
          waitUntil: "networkidle",
        });
        await page.waitForTimeout(3000);
      }
    }

    const body = await page.evaluate(() =>
      document.body?.innerText?.substring(0, 3000),
    );
    console.log(`=== ${label} - BODY ===`);
    console.log(body);
  } finally {
    await browser.close();
  }
}

(async () => {
  await scrapeSite("https://flawery.ru", null, "FLAWERY");
  console.log("\n===\n");
  await scrapeSite("https://rus-buket.ru", null, "RUS-BUKET");
  console.log("\n===\n");
  await scrapeSite("https://megaflowers.ru", null, "MEGAFLOWERS");
  console.log("\n===\n");
  await scrapeSite("https://flor2u.ru", null, "FLOR2U");
})();
