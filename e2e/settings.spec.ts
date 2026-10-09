/**
 * The Settings page, end to end, against a server of its own: these tests set
 * a host password, which would lock every other test out of the shared one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { closePagesAfterEachTest } from './tidy';

closePagesAfterEachTest();

const PORT = 3221;
const BASE = `http://localhost:${PORT}`;
const SHOTS = 'e2e/.artifacts/shots';
let server: ChildProcess;

test.beforeAll(async () => {
  server = spawn('node', ['apps/server/dist/index.js'], {
    env: { ...process.env, PORT: String(PORT), MEDIA_DIR: 'e2e/.artifacts/media', LOG_LEVEL: 'warn', PUBLIC_URL: 'https://old.example.com' },
    stdio: 'ignore',
  });
  await expect(async () => expect((await fetch(`${BASE}/api/health`)).ok).toBe(true)).toPass({ timeout: 15_000 });
});
test.afterAll(() => void server.kill());

test('an administrator runs the server from the Settings page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  // An open server says so on the dashboard and points at the fix.
  await page.goto(`${BASE}/host`);
  await page.getByRole('link', { name: 'Set a password in Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  // The address that used to come from PUBLIC_URL was carried over.
  const address = page.getByLabel('Players’ address');
  await expect(address).toHaveValue('https://old.example.com');
  await page.screenshot({ path: `${SHOTS}/settings-open.png`, fullPage: true });

  // --- ordinary settings: validated as you type, applied the moment they are saved
  await address.fill('buzz.example.com/join');
  await expect(page.getByText('Enter the address only')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'full address' })).toBeVisible();
  await address.fill('https://buzz.example.com');
  await page.getByLabel('Default format').selectOption({ label: 'Quick Play' });
  await page.getByLabel('Keep idle games (hours)').fill('48');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  await expect(page.getByRole('cell', { name: /Players’ address: https:\/\/old\.example\.com → https:\/\/buzz\.example\.com/ })).toBeVisible();

  // The New game page now opens on the chosen format, and the TV lobby shows the new address.
  await page.getByRole('link', { name: 'New game' }).click();
  await expect(page.getByRole('radio', { name: /Quick Play/ })).toBeChecked();
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page).toHaveURL(/\/host\/game\/[A-Z]{4}$/);
  const tv = await context.newPage();
  await tv.goto(`${BASE}/tv/${page.url().slice(-4)}`);
  await expect(tv.locator('.tv-lobby__url')).toHaveText('buzz.example.com');
  await tv.close();

  // --- the password: set it, and the server is locked from then on
  await page.goto(`${BASE}/host/settings`);
  const newPassword = page.locator('input[autocomplete="new-password"]').first();
  await newPassword.fill('short');
  await expect(page.getByRole('button', { name: 'Set password' })).toBeDisabled();
  await newPassword.fill('correct horse');
  await page.getByLabel('Type it again').fill('correct horse');
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByText('This device')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Host password set' })).toBeVisible();

  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(`${BASE}/host/settings`);
  await expect(stranger.getByRole('heading', { name: 'Host sign-in' })).toBeVisible();
  await stranger.getByLabel('Host password').fill('not the password');
  await stranger.getByRole('button', { name: 'Sign in' }).click();
  await expect(stranger.getByRole('alert')).toHaveText('Wrong password');
  await stranger.getByLabel('Host password').fill('correct horse');
  await stranger.getByRole('button', { name: 'Sign in' }).click();
  await expect(stranger.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

  // --- changing it needs the current one, and signs every other device out
  await page.reload();
  await expect(page.locator('.mg-devices li')).toHaveCount(2);
  await page.getByLabel('Current password').fill('wrong guess');
  await page.getByLabel('New password').fill('battery staple');
  await page.getByLabel('Type it again').fill('battery staple');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'not the current password' })).toBeVisible();
  await page.getByLabel('Current password').fill('correct horse');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('.mg-devices li')).toHaveCount(1);
  await expect(page.getByRole('cell', { name: /Host password changed/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/settings-locked.png`, fullPage: true });
  await stranger.reload();
  await expect(stranger.getByRole('heading', { name: 'Host sign-in' })).toBeVisible();

  // Nothing secret reaches the browser: not the hash, not other devices' tokens.
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('buzzoff.admin')!) as string);
  const seen = await (await page.request.get(`${BASE}/api/settings`, { headers: { authorization: `Bearer ${token}` } })).text();
  expect(seen).not.toMatch(/scrypt|battery staple|tokenHash/);
  expect(seen).not.toContain(token);

  // --- signing out
  await page.getByRole('button', { name: 'Sign out here' }).click();
  await expect(page.getByRole('heading', { name: 'Host sign-in' })).toBeVisible();
  await page.getByLabel('Host password').fill('battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
