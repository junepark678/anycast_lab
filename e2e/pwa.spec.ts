import { expect, test } from '@playwright/test';

test('is installable, scoped to the lab, and reloads offline', async ({ page, context }) => {
  await page.goto('./');

  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    return { scope: ready.scope, scriptURL: ready.active?.scriptURL ?? '' };
  });
  expect(registration.scope).toBe(new URL('./', page.url()).href);
  expect(registration.scriptURL).toBe(new URL('sw.js', page.url()).href);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  const cdp = await context.newCDPSession(page);
  const manifest = await cdp.send('Page.getAppManifest');
  expect(manifest.errors).toEqual([]);
  expect(manifest.url).toBe(new URL('manifest.webmanifest', page.url()).href);
  const installabilityErrors = await cdp.send('Page.getInstallabilityErrors');
  expect(installabilityErrors.installabilityErrors).toEqual([]);

  const manifestData = await page.evaluate(async () => {
    const response = await fetch('manifest.webmanifest');
    return response.json() as Promise<{ name: string; display: string; start_url: string; scope: string; icons: Array<{ sizes: string; purpose: string }> }>;
  });
  expect(manifestData).toMatchObject({
    name: 'Anycast Lab',
    display: 'standalone',
    start_url: './',
    scope: './',
  });
  expect(manifestData.icons.some((icon) => icon.sizes === '192x192')).toBe(true);
  expect(manifestData.icons.some((icon) => icon.sizes === '512x512')).toBe(true);
  expect(manifestData.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).some((name) => name.startsWith('anycast-lab-')))).toBe(true);

  try {
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Two-PoP anycast lab');
    await expect(page.getByTestId('topology-canvas')).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
