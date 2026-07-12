import { expect, test } from '@playwright/test';

test('routes commands and scrollback to independent appliance consoles', async ({ page }) => {
  await page.goto('./');

  const consolePicker = page.getByRole('combobox', { name: 'Console appliance' });
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  const output = page.locator('.console-panel .terminal-output');

  await consolePicker.selectOption({ label: 'PoP · Seoul' });
  await command.fill('show protocols');
  await command.press('Enter');
  await expect(output).toContainText('PoP · Seoul$ show protocols');
  await expect(output).toContainText('Established');

  await consolePicker.selectOption({ label: 'PoP · Frankfurt' });
  await expect(output).not.toContainText('PoP · Seoul$ show protocols');
  await expect(output).not.toContainText('Established');
  await command.fill('show bgp summary');
  await command.press('Enter');
  await expect(output).toContainText('PoP · Frankfurt$ show bgp summary');
  await expect(output).toContainText('BGP router identifier');

  await consolePicker.selectOption({ label: 'PoP · Seoul' });
  await expect(output).toContainText('PoP · Seoul$ show protocols');
  await expect(output).not.toContainText('PoP · Frankfurt$ show bgp summary');
  await page.getByRole('button', { name: 'Clear console' }).click();
  await expect(output).toContainText('Console cleared');
  await expect(output).not.toContainText('show protocols');

  await consolePicker.selectOption({ label: 'PoP · Frankfurt' });
  await expect(output).toContainText('PoP · Frankfurt$ show bgp summary');
  await expect(output).toContainText('BGP router identifier');
});

test('drags a palette appliance to the exact canvas drop point', async ({ page }) => {
  await page.goto('./');

  const canvas = page.getByTestId('topology-canvas');
  const source = page.getByRole('button', { name: /BIRD/ });
  const nodes = page.locator('.react-flow__node');
  const initialCount = await nodes.count();
  const targetPosition = { x: 350, y: 145 };
  const canvasBounds = await canvas.boundingBox();
  expect(canvasBounds).not.toBeNull();

  await expect(source).toHaveAttribute('draggable', 'true');
  await source.dragTo(canvas, { targetPosition });
  await expect(nodes).toHaveCount(initialCount + 1);

  const added = nodes.last();
  await expect(added).toContainText('BIRD router');
  const addedBounds = await added.boundingBox();
  expect(addedBounds).not.toBeNull();
  expect(Math.abs(addedBounds!.x - (canvasBounds!.x + targetPosition.x))).toBeLessThan(5);
  expect(Math.abs(addedBounds!.y - (canvasBounds!.y + targetPosition.y))).toBeLessThan(5);
  await expect(page.getByRole('combobox', { name: 'Console appliance' })).toHaveValue(/bird-/);
});

test('provides node, link, and canvas right-click actions', async ({ page }) => {
  await page.goto('./');

  const frankfurt = page.getByTestId('rf__node-pop-frankfurt');
  await frankfurt.click({ button: 'right' });
  let menu = page.getByRole('menu', { name: 'PoP · Frankfurt actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Open console',
    'Open configuration',
    'Disable node',
    'Center in view',
    'Delete node',
  ]);
  await menu.getByRole('menuitem', { name: 'Open console' }).click();
  await expect(page.getByRole('combobox', { name: 'Console appliance' })).toHaveValue('pop-frankfurt');
  await expect(page.getByRole('textbox', { name: 'Terminal command' })).toBeFocused();

  await frankfurt.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Disable node' }).click();
  await expect(page.locator('.inspector').getByRole('button', { name: 'Enable' })).toBeVisible();

  const firstLink = page.locator('.react-flow__edge').first();
  await firstLink.click({ button: 'right' });
  menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Inspect link' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Disable link' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Delete link' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Disable link' }).click();
  await expect(firstLink).toHaveClass(/lab-edge--down/);

  const nodeCount = await page.locator('.react-flow__node').count();
  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 45, y: 45 } });
  menu = page.getByRole('menu', { name: 'Canvas actions' });
  await expect(menu.getByRole('menuitem', { name: 'Fit topology to view' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Add Client' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(nodeCount + 1);
});

test('keeps the console visually separate and gives the dock direct controls', async ({ page }) => {
  await page.goto('./');

  const consolePanel = page.getByRole('region', { name: 'Console', exact: true });
  const activityPanel = page.getByRole('region', { name: 'Network activity' });
  await expect(consolePanel).toBeVisible();
  await expect(activityPanel).toBeVisible();
  const consoleBounds = await consolePanel.boundingBox();
  const activityBounds = await activityPanel.boundingBox();
  expect(consoleBounds).not.toBeNull();
  expect(activityBounds).not.toBeNull();
  expect(consoleBounds!.x + consoleBounds!.width).toBeLessThanOrEqual(activityBounds!.x + 1);

  const dock = page.getByRole('region', { name: 'Console and activity dock' });
  const initialDockBounds = await dock.boundingBox();
  const resizeHandle = page.getByRole('separator', { name: 'Resize console and activity dock' });
  const handleBounds = await resizeHandle.boundingBox();
  expect(initialDockBounds).not.toBeNull();
  expect(handleBounds).not.toBeNull();
  await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y + 2);
  await page.mouse.down();
  await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y - 70, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await dock.boundingBox())?.height ?? 0).toBeGreaterThan(initialDockBounds!.height + 50);

  await page.getByRole('button', { name: 'Collapse console dock' }).click();
  await expect.poll(async () => Math.round((await dock.boundingBox())?.height ?? 0)).toBe(39);
  await page.getByRole('button', { name: 'Expand console dock' }).click();
  await expect(consolePanel).toBeVisible();
});

test('uses only explicit sans and monospace font stacks across rendered UI', async ({ page }) => {
  await page.goto('./');

  const audit = await page.locator('body').evaluate((body) => {
    const elements = [body, ...body.querySelectorAll<HTMLElement>('*')];
    const visible = elements.filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    const families = [...new Set(visible.map((element) => getComputedStyle(element).fontFamily))];
    const offenders = visible
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: element.textContent?.trim().slice(0, 40) ?? '',
        family: getComputedStyle(element).fontFamily,
      }))
      .filter(({ family }) => {
        const normalized = family.toLowerCase();
        const tokens = normalized.split(',').map((token) => token.trim().replace(/^['"]|['"]$/g, ''));
        return !normalized || normalized === 'initial' || normalized === 'unset'
          || tokens.includes('serif')
          || tokens.some((token) => ['times', 'times new roman', 'georgia', 'cambria'].includes(token));
      });
    return { families, offenders };
  });

  expect(audit.offenders).toEqual([]);
  expect(audit.families).toHaveLength(2);
  expect(audit.families.some((family) => family.includes('ui-sans-serif'))).toBe(true);
  expect(audit.families.some((family) => family.includes('ui-monospace'))).toBe(true);
});
