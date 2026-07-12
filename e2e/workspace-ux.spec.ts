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

test('reconverges simulator routing tables after a live interface edit without reloading', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText(/Converged at/)).toBeVisible({ timeout: 10_000 });

  const consolePicker = page.getByRole('combobox', { name: 'Console appliance' });
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  const routeTables = page.locator('.console-panel .terminal-line--output');

  await consolePicker.selectOption('transit');
  await command.fill('show route');
  await command.press('Enter');
  await expect(routeTables.last()).toContainText(/203\.0\.113\.53\/32\s+via 192\.0\.2\.1/);

  await page.locator('html').evaluate((element) => element.setAttribute('data-no-reload', 'true'));
  await page.getByTestId('rf__node-pop-seoul').click();
  const addresses = page.locator('.inspector').getByRole('textbox', { name: 'eth0 addresses' });
  await addresses.fill('192.0.2.3/31');
  await expect(addresses).toHaveValue('192.0.2.3/31');

  await consolePicker.selectOption('transit');
  await page.getByRole('button', { name: 'Clear console' }).click();
  await command.fill('show route');
  await command.press('Enter');

  const updatedTable = routeTables.last();
  await expect(updatedTable).toContainText(/203\.0\.113\.53\/32\s+via 198\.51\.100\.1/);
  await expect(updatedTable).not.toContainText(/203\.0\.113\.53\/32\s+via 192\.0\.2\.1/);
  await expect(page.locator('html')).toHaveAttribute('data-no-reload', 'true');
});

test('propagates a live BIRD anycast prefix edit across simulator routing tables without reloading', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText(/Converged at/)).toBeVisible({ timeout: 10_000 });

  const consolePicker = page.getByRole('combobox', { name: 'Console appliance' });
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  const routeTables = page.locator('.console-panel .terminal-line--output');

  await consolePicker.selectOption('transit');
  await command.fill('show route');
  await command.press('Enter');
  await expect(routeTables.last()).toContainText(/203\.0\.113\.53\/32\s+via 192\.0\.2\.1/);

  await page.locator('html').evaluate((element) => element.setAttribute('data-no-reload', 'true'));
  await page.getByTestId('rf__node-pop-seoul').click();
  await page.getByRole('button', { name: 'Open native configuration' }).click();
  const config = page.getByRole('textbox', { name: '/etc/bird/bird.conf contents' });
  const original = await config.inputValue();
  expect(original).toContain('define ANYCAST_PREFIX = 203.0.113.53/32;');
  await config.fill(original.replace(
    'define ANYCAST_PREFIX = 203.0.113.53/32;',
    'define ANYCAST_PREFIX = 203.0.113.54/32;',
  ));
  await expect(config).toHaveValue(/define ANYCAST_PREFIX = 203\.0\.113\.54\/32;/);

  await consolePicker.selectOption('transit');
  await page.getByRole('button', { name: 'Clear console' }).click();
  await command.fill('show route');
  await command.press('Enter');

  const updatedTable = routeTables.last();
  await expect(updatedTable).toContainText(/203\.0\.113\.53\/32\s+via 198\.51\.100\.1/);
  await expect(updatedTable).toContainText(/203\.0\.113\.54\/32\s+via 192\.0\.2\.1/);
  await expect(updatedTable).not.toContainText(/203\.0\.113\.53\/32\s+via 192\.0\.2\.1/);
  await expect(page.locator('html')).toHaveAttribute('data-no-reload', 'true');
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

test('rejects unsupported and invalid appliance drop payloads without mutating the topology', async ({ page }) => {
  await page.goto('./');

  const canvas = page.getByTestId('topology-canvas');
  const nodes = page.locator('.react-flow__node');
  const initialCount = await nodes.count();

  await canvas.evaluate((element) => {
    const unsupported = new DataTransfer();
    unsupported.setData('application/json', JSON.stringify({ kind: 'bird' }));
    element.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 200,
      dataTransfer: unsupported,
    }));
    element.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 200,
      dataTransfer: unsupported,
    }));

    const invalidKind = new DataTransfer();
    invalidKind.setData('text/plain', 'definitely-not-an-appliance');
    element.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: 320,
      clientY: 220,
      dataTransfer: invalidKind,
    }));
    element.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: 320,
      clientY: 220,
      dataTransfer: invalidKind,
    }));
  });

  await expect(nodes).toHaveCount(initialCount);
  await expect(canvas).not.toHaveClass(/topology-canvas--drag-over/);
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

test('supports keyboard navigation and focus restoration in topology context menus', async ({ page }) => {
  await page.goto('./');

  const node = page.getByTestId('rf__node-pop-frankfurt');
  await node.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'PoP · Frankfurt actions' });
  const first = menu.getByRole('menuitem', { name: 'Open console' });
  const last = menu.getByRole('menuitem', { name: 'Delete node' });

  await expect(first).toBeFocused();
  await menu.press('ArrowUp');
  await expect(last).toBeFocused();
  await menu.press('ArrowDown');
  await expect(first).toBeFocused();
  await menu.press('End');
  await expect(last).toBeFocused();
  await menu.press('Escape');

  await expect(menu).toBeHidden();
  await expect(node).toBeFocused();
});

test('minimizes and restores both side toolbars while giving space back to the canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');

  const canvas = page.getByTestId('topology-canvas');
  const initial = await canvas.boundingBox();
  expect(initial).not.toBeNull();

  await page.getByRole('button', { name: 'Collapse workspace toolbar' }).click();
  await expect(page.getByRole('button', { name: 'Expand workspace toolbar' })).toBeVisible();
  const afterHeader = await canvas.boundingBox();
  expect(afterHeader).not.toBeNull();
  expect(afterHeader!.height).toBeGreaterThan(initial!.height + 10);

  await page.getByRole('button', { name: 'Collapse appliance palette' }).click();
  await expect(page.getByRole('button', { name: 'Expand appliance palette' })).toBeVisible();
  await expect(page.getByRole('button', { name: /BIRD/ })).toBeHidden();
  const afterPalette = await canvas.boundingBox();
  expect(afterPalette).not.toBeNull();
  expect(afterPalette!.width).toBeGreaterThan(initial!.width + 50);

  await page.getByRole('button', { name: 'Collapse details panel' }).click();
  await expect(page.getByRole('button', { name: 'Expand details panel' })).toBeVisible();
  const afterDetails = await canvas.boundingBox();
  expect(afterDetails).not.toBeNull();
  expect(afterDetails!.width).toBeGreaterThan(afterPalette!.width + 100);

  await page.getByRole('button', { name: 'Expand appliance palette' }).click();
  await expect(page.getByRole('button', { name: 'Collapse appliance palette' })).toBeVisible();
  await expect(page.getByRole('button', { name: /BIRD/ })).toBeVisible();
  await page.getByRole('button', { name: 'Expand details panel' }).click();
  await expect(page.getByRole('button', { name: 'Collapse details panel' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand workspace toolbar' }).click();
  await expect(page.getByRole('button', { name: 'Collapse workspace toolbar' })).toBeVisible();
});

test('persists the workspace side-panel layout locally', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');

  await page.getByRole('button', { name: 'Collapse appliance palette' }).click();
  await page.getByRole('button', { name: 'Collapse details panel' }).click();
  await page.getByRole('button', { name: 'Collapse workspace toolbar' }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('anycast-lab:workspace-layout:v1'))).not.toBeNull();
  await expect.poll(() => page.evaluate(() => {
    const value = localStorage.getItem('anycast-lab:workspace-layout:v1');
    return value ? JSON.parse(value) : null;
  })).toMatchObject({ paletteCollapsed: true, detailsCollapsed: true, headerCollapsed: true });

  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand appliance palette' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand details panel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand workspace toolbar' })).toBeVisible();

  await page.getByRole('button', { name: 'Expand appliance palette' }).click();
  await page.getByRole('button', { name: 'Expand details panel' }).click();
  await page.getByRole('button', { name: 'Expand workspace toolbar' }).click();
  await expect.poll(() => page.evaluate(() => {
    const value = localStorage.getItem('anycast-lab:workspace-layout:v1');
    return value ? JSON.parse(value) : null;
  })).toMatchObject({ paletteCollapsed: false, detailsCollapsed: false, headerCollapsed: false });
});

test('opens a BIRD configuration at 900px without horizontal overflow or collapsing the canvas', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto('./');

  await page.getByTestId('rf__node-pop-seoul').click();
  await page.getByRole('button', { name: 'Open native configuration' }).click();

  const editor = page.getByRole('region', { name: 'PoP · Seoul configuration' });
  const canvas = page.getByTestId('topology-canvas');
  const labMain = page.locator('.lab-main');
  await expect(editor).toBeVisible();
  await expect(page.getByRole('textbox', { name: '/etc/bird/bird.conf contents' })).toBeVisible();
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(300);

  const layout = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('.lab-main');
    const editor = document.querySelector<HTMLElement>('.config-workspace');
    if (!main || !editor) throw new Error('Expected the lab main and configuration workspace');
    const mainBounds = main.getBoundingClientRect();
    const editorBounds = editor.getBoundingClientRect();
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      mainClientWidth: main.clientWidth,
      mainScrollWidth: main.scrollWidth,
      editorLeft: editorBounds.left,
      editorRight: editorBounds.right,
      mainLeft: mainBounds.left,
      mainRight: mainBounds.right,
    };
  });

  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.mainScrollWidth).toBeLessThanOrEqual(layout.mainClientWidth + 1);
  expect(layout.editorLeft).toBeGreaterThanOrEqual(layout.mainLeft - 1);
  expect(layout.editorRight).toBeLessThanOrEqual(layout.mainRight + 1);
  await expect(labMain).toBeVisible();
});

test('keeps the mobile workspace usable with overlay side panels and no horizontal clipping', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');

  const canvas = page.getByTestId('topology-canvas');
  await expect(page.getByRole('button', { name: 'Expand appliance palette' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand details panel' })).toBeVisible();
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(300);
  const collapsedWidth = (await canvas.boundingBox())!.width;

  await page.getByRole('button', { name: 'Expand appliance palette' }).click();
  await expect(page.getByRole('button', { name: /BIRD/ })).toBeVisible();
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(collapsedWidth - 1);
  await page.getByRole('button', { name: 'Collapse appliance palette' }).click();

  await page.getByRole('button', { name: 'Expand details panel' }).click();
  await expect(page.getByRole('button', { name: 'Collapse details panel' })).toBeVisible();
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(collapsedWidth - 1);

  await expect.poll(() => page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }))).toEqual({ viewport: 390, content: 390 });
});

test('switches compact dock views without clipping their content', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');

  const compactViews = page.getByRole('navigation', { name: 'Compact dock views' });
  const consoleView = page.getByRole('region', { name: 'Console', exact: true });
  const activityView = page.getByRole('region', { name: 'Network activity' });
  await expect(compactViews).toBeVisible();
  await expect(consoleView).toBeVisible();
  await expect(activityView).toBeHidden();

  await compactViews.getByRole('button', { name: 'Activity' }).click();
  await expect(activityView).toBeVisible();
  await expect(consoleView).toBeHidden();
  await expect.poll(() => activityView.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await compactViews.getByRole('button', { name: 'Console' }).click();
  await expect(consoleView).toBeVisible();
  await expect(activityView).toBeHidden();
  await expect.poll(() => consoleView.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
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
