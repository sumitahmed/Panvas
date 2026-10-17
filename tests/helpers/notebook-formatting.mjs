// Keep the historical source-comparison runs usable while exercising the
// current palette through its visible UI in current-implementation runs.
export async function clearNotebookHighlight(page) {
  const legacy = page.getByRole('button', { name: 'No background', exact: true });
  if (await legacy.count()) return legacy.click();
  if (await page.getByRole('dialog', { name: 'Text formatting options', exact: true }).count()) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Highlight color', exact: true }).click();
  await page.getByRole('menu', { name: 'Highlight color palette', exact: true }).getByRole('menuitemradio', { name: 'None', exact: true }).click();
}

export async function chooseNotebookTextColor(page, kind, value) {
  const label = kind === 'highlight' ? 'Highlight color' : 'Text color';
  const legacy = page.locator(`input[aria-label="${label}"]`).first();
  if (await legacy.count()) return legacy.fill(value);
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByLabel(`Custom ${label.toLowerCase()}`, { exact: true }).fill(value);
  await page.keyboard.press('Escape');
}
