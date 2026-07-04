const { test, expect } = require('@playwright/test');

test('la page publique expose une entrée rapide et des règles progressives', async ({ page }) => {
  await page.goto('/');

  const quickGuest = page.locator('#auth-quick-guest');
  if (test.info().project.name.startsWith('mobile')) await expect(quickGuest).toBeVisible();
  else await expect(quickGuest).toBeHidden();

  await page.locator('.auth-intro [data-about]').click();
  await expect(page.locator('#about-modal')).toBeVisible();
  await expect(page.locator('#about-modal details')).toHaveCount(3);
  await expect(page.locator('#about-modal details[open]')).toHaveCount(0);
  await expect(page.locator('#about-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#about-modal')).toBeHidden();
});

test('un invité arrive directement dans le quiz découverte', async ({ page }) => {
  await page.goto('/');
  const entry = test.info().project.name.startsWith('mobile')
    ? page.locator('#auth-quick-guest')
    : page.locator('#guest-login-btn');

  await entry.click();

  await expect(page.locator('#view-quiz')).toBeVisible();
  await expect(page.locator('#view-play')).toBeHidden();
  await expect(page.locator('#gm-tag')).toContainText('Mode découverte');
  await expect(page.locator('#gm-hint')).toContainText('aucun score ni progrès sauvegardé');
  await expect(page.locator('#next-btn')).toContainText('Démarrer');
});

test('les protections HTTP et les contraintes de mot de passe sont actives', async ({ page, request }) => {
  const response = await request.get('/api/health');
  expect(response.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['x-powered-by']).toBeUndefined();

  await page.goto('/');
  await page.locator('[data-tab="register"]').click();
  await expect(page.locator('#register-password')).toHaveAttribute('minlength', '8');
  await expect(page.locator('#register-password')).toHaveAttribute('maxlength', '128');
});
