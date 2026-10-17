export async function openNotebookProperties(page) {
  const panel = page.locator('aside.panvas-properties-panel');
  if (!await panel.count()) await page.getByRole('button', { name: 'Open page and view inspector', exact: true }).click();
  await panel.waitFor(); return panel;
}
export async function closeNotebookProperties(page) {
  const panel = page.locator('aside.panvas-properties-panel');
  if (await panel.count()) {
    // Below xl the sheet covers the toolbar toggle. Use its existing Close
    // control; wide layouts keep the inspector toggle available instead.
    const close = panel.getByRole('button', { name: 'Close Page Properties', exact: true });
    if (await close.isVisible()) await close.click();
    else await page.getByRole('button', { name: 'Open page and view inspector', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
  }
}
export async function chooseWritingLayout(page, layout) {
  const panel = await openNotebookProperties(page);
  await panel.getByRole('group', { name: 'Writing layout', exact: true }).getByRole('button', { name: layout, exact: true }).click();
  return panel;
}
