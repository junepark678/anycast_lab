import { expect, test } from '@playwright/test';

test('opens the default demo on first load, then creates and restores an isolated project', async ({ page }) => {
  await page.goto('./');

  const projectName = page.locator('#root').getByRole('textbox', { name: 'Project name' });
  const nodes = page.locator('.react-flow__node');
  await expect(projectName).toHaveValue('Two-PoP anycast lab');
  await expect(nodes).toHaveCount(6);

  await page.getByRole('button', { name: 'Manage projects' }).click();
  let manager = page.getByRole('dialog', { name: 'Projects' });
  await expect(manager.getByRole('button', { name: 'Two-PoP anycast lab, current project' })).toBeDisabled();
  await manager.getByRole('radio', { name: /Blank lab/ }).click();
  await manager.getByRole('textbox', { name: 'Project name' }).fill('Project Alpha');
  await manager.getByRole('button', { name: 'Create project' }).click();

  await expect(manager).toBeHidden();
  await expect(projectName).toHaveValue('Project Alpha');
  await expect(nodes).toHaveCount(0);
  await page.getByRole('button', { name: /BIRD/ }).click();
  await expect(nodes).toHaveCount(1);
  await expect(page.getByText('Saved locally')).toBeVisible();

  await page.getByRole('button', { name: 'Manage projects' }).click();
  manager = page.getByRole('dialog', { name: 'Projects' });
  await manager.getByRole('button', { name: 'Open Two-PoP anycast lab' }).click();
  await expect(projectName).toHaveValue('Two-PoP anycast lab');
  await expect(nodes).toHaveCount(6);

  await page.getByRole('button', { name: 'Manage projects' }).click();
  manager = page.getByRole('dialog', { name: 'Projects' });
  await manager.getByRole('button', { name: 'Open Project Alpha' }).click();
  await expect(projectName).toHaveValue('Project Alpha');
  await expect(nodes).toHaveCount(1);

  await page.evaluate(() => localStorage.setItem(
    'anycast-lab:last-project',
    '00000000-0000-4000-8000-000000000000',
  ));
  await page.reload();
  await expect(projectName).toHaveValue('Project Alpha');
  await expect(nodes).toHaveCount(1);
});

test('renames, duplicates, exports, and deletes projects with in-app confirmation', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Manage projects' }).click();
  const manager = page.getByRole('dialog', { name: 'Projects' });

  await manager.getByRole('button', { name: 'Duplicate Two-PoP anycast lab' }).click();
  await expect(manager.getByText('Two-PoP anycast lab copy', { exact: true })).toBeVisible();
  await expect(manager.getByText('Current')).toBeVisible();

  await manager.getByRole('button', { name: 'Rename Two-PoP anycast lab copy' }).click();
  const rename = manager.getByRole('textbox', { name: 'New name for Two-PoP anycast lab copy' });
  await rename.fill('Frankfurt rehearsal');
  await rename.press('Enter');
  await expect(manager.getByText('Frankfurt rehearsal', { exact: true })).toBeVisible();
  await expect(manager.getByText('Revision 2', { exact: true })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await manager.getByRole('button', { name: 'Export Frankfurt rehearsal' }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('Frankfurt rehearsal.anycastlab');

  await manager.getByRole('button', { name: 'Delete Two-PoP anycast lab' }).click();
  const confirmation = manager.getByRole('group', { name: 'Delete Two-PoP anycast lab?' });
  await expect(confirmation).toContainText('This cannot be undone');
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmation).toBeHidden();

  await manager.getByRole('button', { name: 'Delete Two-PoP anycast lab' }).click();
  await manager.getByRole('group', { name: 'Delete Two-PoP anycast lab?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(manager.getByText('Two-PoP anycast lab', { exact: true })).toBeHidden();
  await manager.getByRole('button', { name: 'Close Projects' }).click();

  await page.reload();
  await expect(page.locator('#root').getByRole('textbox', { name: 'Project name' })).toHaveValue('Frankfurt rehearsal');
});

test('deleting the only project creates and restores a durable blank replacement', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Manage projects' }).click();
  const manager = page.getByRole('dialog', { name: 'Projects' });

  await manager.getByRole('button', { name: 'Delete Two-PoP anycast lab' }).click();
  await manager.getByRole('group', { name: 'Delete Two-PoP anycast lab?' })
    .getByRole('button', { name: 'Delete' }).click();

  await expect(page.locator('#root').getByRole('textbox', { name: 'Project name' })).toHaveValue('Untitled lab');
  await expect(manager.getByText('1 project')).toBeVisible();
  await expect(manager.getByRole('button', { name: 'Untitled lab, current project' })).toBeVisible();

  await manager.getByRole('button', { name: 'Close Projects' }).click();
  await page.reload();
  await expect(page.locator('#root').getByRole('textbox', { name: 'Project name' })).toHaveValue('Untitled lab');
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
});

test('keeps IndexedDB project management working when localStorage is denied', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = function getItem(): string | null {
      throw new DOMException('Storage denied', 'SecurityError');
    };
    Storage.prototype.setItem = function setItem(): void {
      throw new DOMException('Storage denied', 'SecurityError');
    };
  });
  await page.goto('./');
  await expect(page.locator('#root').getByRole('textbox', { name: 'Project name' })).toHaveValue('Two-PoP anycast lab');
  await expect(page.getByRole('button', { name: 'Manage projects' })).toBeEnabled();

  await page.locator('#root').getByRole('textbox', { name: 'Project name' }).fill('No localStorage lab');
  await expect(page.getByText('Unsaved')).toBeVisible();
  await expect(page.getByText('Saved locally')).toBeVisible();
  await page.reload();
  await expect(page.locator('#root').getByRole('textbox', { name: 'Project name' })).toHaveValue('No localStorage lab');
});

test('rejects a stale save from a second tab instead of overwriting newer work', async ({ context, page }) => {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Manage projects' })).toBeEnabled();

  const secondPage = await context.newPage();
  await secondPage.goto('./');
  await expect(secondPage.getByRole('button', { name: 'Manage projects' })).toBeEnabled();

  await page.locator('#root').getByRole('textbox', { name: 'Project name' }).fill('First tab wins');
  await expect(page.getByText('Unsaved')).toBeVisible();
  await expect(page.getByText('Saved locally')).toBeVisible();

  await secondPage.locator('#root').getByRole('textbox', { name: 'Project name' }).fill('Stale second tab');
  await expect(secondPage.getByText('Save failed')).toBeVisible();
  await secondPage.reload();
  await expect(secondPage.locator('#root').getByRole('textbox', { name: 'Project name' })).toHaveValue('First tab wins');
});

test('keeps project management usable in a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto('./');
  await page.getByRole('button', { name: 'Manage projects' }).click();

  const manager = page.getByRole('dialog', { name: 'Projects' });
  await expect(manager).toBeVisible();
  const box = await manager.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.width).toBeLessThanOrEqual(375);
  await expect(manager.getByRole('searchbox', { name: 'Search projects' })).toBeVisible();
  await expect(manager.getByRole('button', { name: 'Create project' })).toBeVisible();
});
