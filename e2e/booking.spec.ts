import { expect, type Page, test } from '@playwright/test';

// Every test books on its own day, so tests stay independent while sharing one server.
async function open(page: Page, day: string, dealership = 'dlr-hcm') {
  await page.goto('/');
  await page.locator('#dealership').selectOption(dealership);
  await page.locator('#date').fill(day);
  await page.locator('#date').dispatchEvent('change');
  await expect(page.locator('#day-title')).toContainText(day);
}

async function book(page: Page, vehicle: string, service: string, time: string) {
  await page.locator('#vehicle').selectOption(vehicle);
  await page.locator('#service').selectOption(service);
  await page.locator('#time').selectOption(time);
  await page.locator('#book').click();
}

const result = (page: Page) => page.locator('#result');
const appointmentRows = (page: Page) => page.locator('#appointments tr');

test('shows reference data and the workshop for the selected dealership', async ({ page }) => {
  await open(page, '2030-04-01');
  await expect(page.locator('#service option')).toHaveCount(4);
  await expect(page.locator('#vehicle option')).toHaveCount(3);
  await expect(page.locator('#time option').first()).toHaveText('08:00'); // opening hours from the API
  await expect(page.locator('#time option').last()).toHaveText('16:45');
  const timeline = page.locator('#timeline');
  for (const name of ['Nguyen Van An', 'Tran Thi Binh', 'Le Minh Chi', 'Bay 1', 'Bay 2']) await expect(timeline).toContainText(name);
  await expect(appointmentRows(page)).toHaveText(['No appointments on this day.']);
});

test('checks availability before booking', async ({ page }) => {
  await open(page, '2030-04-02');
  await page.locator('#service').selectOption('svc-brake');
  await page.locator('#time').selectOption('09:00');
  await page.locator('#check').click();
  await expect(result(page)).toContainText('Available');
  await expect(result(page)).toContainText('Free qualified technicians: Nguyen Van An'); // only An has BRAKES
  await expect(appointmentRows(page)).toHaveText(['No appointments on this day.']); // checking does not book
});

test('books, rejects a conflict with its reason, and frees the slot on cancel', async ({ page }) => {
  await open(page, '2030-04-03');

  await book(page, 'veh-1', 'svc-brake', '09:00');
  await expect(result(page)).toContainText('Confirmed');
  await expect(result(page)).toContainText('Technician: Nguyen Van An | Bay: Bay 1');
  await expect(appointmentRows(page)).toHaveCount(1);
  await expect(page.locator('#timeline .block')).toHaveCount(2); // one block on An's lane, one on Bay 1's
  await expect(page.locator('#timeline .block').first()).toContainText('09:00 Volkswagen Golf');

  await book(page, 'veh-2', 'svc-brake', '10:00'); // An is busy until 10:30
  await expect(result(page)).toContainText('NO_TECHNICIAN_AVAILABLE');
  await expect(appointmentRows(page)).toHaveCount(1);

  await appointmentRows(page).first().getByRole('button', { name: 'Cancel' }).click();
  await expect(result(page)).toContainText('Appointment cancelled');
  await expect(appointmentRows(page).first()).toContainText('CANCELLED');
  await expect(appointmentRows(page).first().getByRole('button', { name: 'Cancel' })).toBeDisabled();

  await book(page, 'veh-2', 'svc-brake', '10:00'); // now possible
  await expect(result(page)).toContainText('Technician: Nguyen Van An');
});

test('assigns the next free technician and bay, then reports when bays run out', async ({ page }) => {
  await open(page, '2030-04-04');
  await book(page, 'veh-1', 'svc-oil', '09:00');
  await expect(result(page)).toContainText('Technician: Nguyen Van An | Bay: Bay 1');
  await book(page, 'veh-3', 'svc-oil', '09:00');
  await expect(result(page)).toContainText('Technician: Tran Thi Binh | Bay: Bay 2');
  await book(page, 'veh-2', 'svc-oil', '09:30'); // Chi is free, but both bays are taken
  await expect(result(page)).toContainText('NO_BAY_AVAILABLE');
});

test('explains requests that can never be booked', async ({ page }) => {
  await open(page, '2030-04-05', 'dlr-hn');
  await book(page, 'veh-1', 'svc-ev', '09:00'); // nobody at Ha Noi is EV qualified
  await expect(result(page)).toContainText('NO_QUALIFIED_TECHNICIAN');
  await book(page, 'veh-1', 'svc-oil', '16:30'); // would finish 17:30
  await expect(result(page)).toContainText('OUTSIDE_OPENING_HOURS');
});

test('logs every API call with its status', async ({ page }) => {
  await open(page, '2030-04-06', 'dlr-hn');
  await book(page, 'veh-1', 'svc-oil', '09:00');
  await book(page, 'veh-2', 'svc-oil', '09:00');
  const log = page.locator('#log');
  await expect(log).toContainText('POST /appointments  -> 201');
  await expect(log).toContainText('POST /appointments  -> 409  NO_TECHNICIAN_AVAILABLE');
});

test('fits a phone screen without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await open(page, '2030-04-07');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
