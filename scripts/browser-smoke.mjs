import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { preview } from "vite";

const host = "127.0.0.1";
const port = 4173;
const htaccess = await readFile(
  new URL("../deploy/.htaccess", import.meta.url),
  "utf8",
);
const cspMatch = htaccess.match(
  /Header always set Content-Security-Policy "([^"\r\n]+)"/,
);
if (!cspMatch) throw new Error("Could not read the deployment CSP");

const configuredBaseUrl = process.env.OPENEARTH_SMOKE_BASE_URL?.trim();
const baseUrl = configuredBaseUrl
  ? new URL(configuredBaseUrl).href.replace(/\/+$/, "")
  : `http://${host}:${port}`;
const server = configuredBaseUrl
  ? undefined
  : await preview({
      preview: {
        host,
        port,
        strictPort: true,
        headers: { "Content-Security-Policy": cspMatch[1] },
      },
    });
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--enable-webgl",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) =>
    pageErrors.push(error.stack ?? error.message),
  );
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(`${baseUrl}/?view=copenhagen`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .locator(".cesium-viewer canvas")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  const errorPanel = page.locator(".cesium-widget-errorPanel");
  if (await errorPanel.isVisible()) {
    throw new Error(`Cesium startup error: ${await errorPanel.innerText()}`);
  }
  await page.locator('[data-place="denmark"]').click();
  await page.locator("#reset-view").click();
  if (!(await page.title()).startsWith("OpenEarth"))
    throw new Error("Unexpected browser title");
  if (pageErrors.length > 0)
    throw new Error(`Browser page errors:\n${pageErrors.join("\n")}`);
  if (consoleErrors.length > 0)
    throw new Error(`Browser console errors:\n${consoleErrors.join("\n")}`);

  const xrPage = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const xrPageErrors = [];
  xrPage.on("pageerror", (error) =>
    xrPageErrors.push(error.stack ?? error.message),
  );
  await xrPage.goto(`${baseUrl}/?xrPreview=4.5&lon=12.5683&lat=55.6761`, {
    waitUntil: "domcontentloaded",
  });
  const xrCanvas = xrPage.locator("#xr-globe");
  await xrCanvas.waitFor({ state: "visible", timeout: 30_000 });
  await xrPage.locator("body.xr-active").waitFor({ timeout: 30_000 });
  await xrPage.waitForTimeout(1_000);
  const screenshot = await xrCanvas.screenshot({
    type: "png",
    timeout: 10_000,
  });
  const pixelStats = await xrPage.evaluate(async (base64) => {
    const image = new globalThis.Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const sample = globalThis.document.createElement("canvas");
    sample.width = 64;
    sample.height = 36;
    const context = sample.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas is unavailable");
    context.drawImage(image, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    const colors = new Set();
    let minimum = 255;
    let maximum = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      minimum = Math.min(minimum, red, green, blue);
      maximum = Math.max(maximum, red, green, blue);
      colors.add(`${red >> 4}/${green >> 4}/${blue >> 4}`);
    }
    return { range: maximum - minimum, colors: colors.size };
  }, screenshot.toString("base64"));
  if (pixelStats.range < 32 || pixelStats.colors < 4)
    throw new Error(
      `XR preview canvas is blank or uniform (${JSON.stringify(pixelStats)})`,
    );
  if (xrPageErrors.length > 0)
    throw new Error(`XR preview page errors:\n${xrPageErrors.join("\n")}`);
  await xrPage.close();

  console.log("Chromium desktop and XR-preview smoke tests passed.");
} finally {
  await browser?.close();
  if (server) {
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
}
