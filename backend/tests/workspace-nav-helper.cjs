'use strict';

async function openWorkspacePage(page, key) {
  const button = page.locator(`.nav [data-page="${key}"]`);
  await button.waitFor({ state: 'attached' });
  const disclosure = page.locator('.nav-more:not([open])').filter({ has: page.locator(`[data-page="${key}"]`) });
  if (await disclosure.count()) await disclosure.locator('summary').click();
  await button.click();
}

module.exports = { openWorkspacePage };
