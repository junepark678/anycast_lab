import { expect, test } from '@playwright/test';

test('opens the starter topology and edits a native config', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Two-PoP anycast lab');
  await expect(page.getByTestId('rf__node-pop-seoul')).toBeVisible();
  await page.getByTestId('rf__node-pop-seoul').click();
  await page.getByRole('button', { name: 'Open native configuration' }).click();
  await expect(page.getByRole('region', { name: 'PoP · Seoul configuration' })).toBeVisible();
  await expect(page.getByText('bird.conf', { exact: true })).toBeVisible();
});

test('runs the topology and traces the anycast service', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText(/Converged at/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Packet trace/ }).click();
  await page.getByRole('button', { name: 'Trace packet' }).click();
  await expect(page.locator('.trace-hop')).not.toHaveCount(0);
  await expect(page.locator('.trace-hop').filter({ hasText: 'PoP · Seoul' })).toBeVisible();
});

test('keeps Packet trace clickable at the compact desktop height', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('./');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText(/Converged at/)).toBeVisible({ timeout: 10_000 });

  const packetTrace = page.getByRole('button', { name: /Packet trace/ });
  await expect(packetTrace).toBeVisible();
  const centerIsUnobstructed = await packetTrace.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const topmostElement = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    return topmostElement !== null && button.contains(topmostElement);
  });
  expect(centerIsUnobstructed).toBe(true);

  await packetTrace.click();
  await expect(page.getByRole('button', { name: 'Trace packet' })).toBeVisible();
});

test('autosaves a project name to IndexedDB and restores it', async ({ page }) => {
  await page.goto('./');
  const name = page.getByRole('textbox', { name: 'Project name' });
  await name.fill('Persistent browser lab');
  await expect(page.getByText('Saved locally')).toBeVisible({ timeout: 5_000 });
  await page.reload();
  await expect(name).toHaveValue('Persistent browser lab');
});

test('flushes a pending autosave when the page is hidden or reloaded', async ({ page }) => {
  await page.goto('./');
  const name = page.getByRole('textbox', { name: 'Project name' });
  await name.fill('Immediate pagehide save');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Immediate pagehide save');
});

test('adds a new FRR appliance with a native configuration workspace', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: /FRRouting/ }).click();
  await expect(page.locator('.inspector').getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('FRR router');
  await page.getByRole('button', { name: 'Open native configuration' }).click();
  await expect(page.getByText('frr.conf', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByRole('status')).toContainText(/parsed successfully|has errors/);
});

test('edits interface addressing and adds an included config file', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('rf__node-pop-seoul').click();
  const addresses = page.getByRole('textbox', { name: 'eth0 addresses' });
  await addresses.fill('192.0.2.1/31, 2001:db8:1::1/64');
  await expect(addresses).toHaveValue('192.0.2.1/31, 2001:db8:1::1/64');
  const gateway = page.getByRole('textbox', { name: 'eth0 gateway' });
  await gateway.fill('192.0.2.0');
  await expect(gateway).toHaveValue('192.0.2.0');
  await page.getByRole('button', { name: 'Open native configuration' }).click();
  page.once('dialog', async (dialog) => dialog.accept('/etc/bird/filters.conf'));
  await page.getByRole('button', { name: 'Add config file' }).click();
  await expect(page.getByText('filters.conf', { exact: true })).toBeVisible();
});

test('exports and imports a byte-preserving project archive', async ({ page }) => {
  await page.goto('./');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.anycastlab$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  await page.locator('input[type=file]').setInputFiles(path!);
  await expect(page.getByRole('status')).toContainText('Imported Two-PoP anycast lab');
});

test('a pending same-ID autosave cannot overwrite an imported archive', async ({ page }) => {
  await page.goto('./');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const archive = await downloadPromise;
  const archivePath = await archive.path();
  expect(archivePath).toBeTruthy();

  await page.getByRole('textbox', { name: 'Project name' }).fill('Stale pre-import edit');
  await page.locator('input[type=file]').setInputFiles(archivePath!);
  await expect(page.getByRole('status')).toContainText('Imported Two-PoP anycast lab');
  await page.waitForTimeout(750);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Two-PoP anycast lab');
});

test('fails the Seoul path and reconverges traffic through Frankfurt', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText(/Converged at/)).toBeVisible({ timeout: 10_000 });
  const seoulLink = page.locator('.react-flow__edge').filter({ hasText: /^5 ms/ });
  await seoulLink.click();
  await page.getByRole('checkbox', { name: /Link state/ }).uncheck();
  await page.getByRole('button', { name: /Packet trace/ }).click();
  await page.getByRole('button', { name: 'Trace packet' }).click();
  await expect(page.locator('.trace-hop').filter({ hasText: 'PoP · Frankfurt' })).toBeVisible();
});

test('keeps native VM mode explicit and unavailable when no image is deployed', async ({ page }) => {
  await page.route('**/runtime/status.json', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ schemaVersion: 1, nativeV86: false }),
  }));
  await page.goto('./');
  await expect(page.getByRole('radio', { name: 'SIM' })).toBeChecked();
  const native = page.getByRole('radio', { name: 'NATIVE VM' });
  await expect(native).toBeDisabled();
  await expect(native).toHaveAttribute('title', /does not include the native VM image/);
});

test('selects and autosaves the version-pinned native VM fidelity', async ({ page }) => {
  await page.route('**/runtime/status.json', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      nativeV86: true,
      manifestSha256: 'a'.repeat(64),
      buildId: 'test-native-image',
      memoryBytes: 128 * 1024 * 1024,
    }),
  }));
  await page.goto('./');
  const native = page.getByRole('radio', { name: 'NATIVE VM' });
  await expect(native).toBeEnabled();
  await expect(native).toHaveAttribute('title', /768 MiB for 6 VMs/);
  await native.click();
  await expect(native).toBeChecked();
  await expect(page.getByText(/no compatibility fallback/)).toBeVisible();
  await page.getByTestId('rf__node-pop-seoul').click();
  await expect(page.locator('.runtime-card')).toContainText('BIRD 2.15.1 · native Linux VM');
  await expect(page.getByText('Native daemon · isolated VM')).toBeVisible();
  await expect(page.getByText('Saved locally')).toBeVisible({ timeout: 5_000 });
  await page.reload();
  await expect(page.getByRole('radio', { name: 'NATIVE VM' })).toBeChecked();
});
