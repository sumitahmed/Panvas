export async function openNotebookProperties(page) {
  const panel = page.locator('aside.panvas-properties-panel');
  if (!await panel.count()) await page.getByRole('button', { name: 'Open page and view inspector', exact: true }).click();
  await panel.waitFor(); return panel;
}
export async function closeNotebookProperties(page) {
  if (await page.locator('aside.panvas-properties-panel').count()) await page.getByRole('button', { name: 'Open page and view inspector', exact: true }).click();
}
export async function chooseWritingLayout(page, layout) {
  const panel = await openNotebookProperties(page);
  await panel.getByRole('group', { name: 'Writing layout', exact: true }).getByRole('button', { name: layout, exact: true }).click();
  return panel;
}
