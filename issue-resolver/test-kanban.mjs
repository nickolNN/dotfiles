import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:5101';
const ROOT = '/home/agent/workspace/.issue-resolver/workspaces/ec390f0c-e34e-41b0-868b-a4507098aecf';
const SHOT = `${ROOT}/screenshots`;
fs.mkdirSync(SHOT, { recursive: true });

const COLUMNS = ['Open', 'In Progress', 'Completed', 'Cancelled'];
const consoleErrors = [];
const pageErrors = [];
const scenarios = [];
const findings = [];

function record(name, expected, actual, ok, severity = 'major') {
  scenarios.push({ name, expected, actual });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) {
    console.log(`    expected: ${expected}`);
    console.log(`    actual:   ${actual}`);
    findings.push({ severity, title: name, detail: `expected: ${expected}\nactual: ${actual}` });
  }
}
const fmt = (b) => COLUMNS.map((c) => `${c}=[${b[c].join(', ')}]`).join(' | ');

async function shot(page, name, clip) {
  await page.screenshot({ path: `${SHOT}/${name}`, clip });
  console.log(`  shot: ${name}`);
}

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const email = page.locator('input[type=email]');
  const hasForm = await email.waitFor({ timeout: 8000 }).then(() => true, () => false);
  if (hasForm) {
    await email.fill('tester@example.com');
    await page.fill('input[type=password]', 'password123');
    await page.click('button[type=submit]');
    await page.waitForSelector('input[type=email]', { state: 'detached', timeout: 20000 });
  }
}

async function openBoard(page) {
  await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
  await page.waitForSelector('h2:has-text("Kanban Board")', { timeout: 20000 });
  await page.waitForTimeout(1000);
}

const colLoc = (page, col) => page.locator(`div[role=group][aria-label="${col}"]`);
const cardLoc = (page, col, i) => colLoc(page, col).locator('div[aria-label*=", priority "]').nth(i);

async function readBoard(page) {
  const board = {};
  for (const col of COLUMNS) {
    const cards = colLoc(page, col).locator('div[aria-label*=", priority "]');
    const n = await cards.count();
    board[col] = [];
    for (let i = 0; i < n; i++) {
      board[col].push((await cards.nth(i).getAttribute('aria-label')).split(', priority ')[0]);
    }
  }
  return board;
}

async function storeState(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('mock_data_tasks');
    if (!raw) return null;
    const tasks = JSON.parse(raw);
    const out = {};
    for (const col of ['open', 'in_progress', 'completed', 'cancelled']) {
      out[col] = tasks
        .filter((t) => t.status === col)
        .sort((a, b) => a.position - b.position)
        .map((t) => `${t.title}@${t.position}`);
    }
    return out;
  });
}
const fmtStore = (s) => s ? Object.entries(s).map(([k, v]) => `${k}=[${v.join(', ')}]`).join(' | ') : 'no store';

async function drag(page, fromCol, fromIdx, toX, toY, midShot, midCheck) {
  console.log(`  drag ${fromCol}#${fromIdx} -> (${toX}, ${toY})`);
  const loc = cardLoc(page, fromCol, fromIdx);
  await loc.scrollIntoViewIfNeeded();
  let box = await loc.boundingBox();
  if (toY < 0 || toY > 900) {
    await page.evaluate((y) => window.scrollTo(0, y - 450), toY);
    await page.waitForTimeout(200);
    box = await loc.boundingBox();
  }
  console.log(`  src box: x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}`);
  console.log(`  store before: ${fmtStore(await storeState(page))}`);
  const sx = box.x + box.width / 2;
  const sy = box.y + 10;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(sx + ((toX - sx) * i) / steps, sy + ((toY - sy) * i) / steps);
    await page.waitForTimeout(12);
  }
  await page.mouse.move(toX, toY);
  await page.waitForTimeout(200);
  if (midCheck) console.log(`  mid-drag: ${await midCheck(page)}`);
  if (midShot) await shot(page, midShot);
  await page.mouse.up();
  await page.waitForTimeout(2000);
  console.log(`  store after:  ${fmtStore(await storeState(page))}`);
}

async function cardBox(page, col, i) {
  return cardLoc(page, col, i).boundingBox();
}

function uniqueTitlePick(board) {
  const counts = {};
  for (const col of COLUMNS) for (const t of board[col]) counts[t] = (counts[t] ?? 0) + 1;
  for (const col of COLUMNS) {
    const i = board[col].findIndex((t) => counts[t] === 1);
    if (i >= 0) return { title: board[col][i], col, idx: i };
  }
  return null;
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900} });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/api/tasks')) {
      console.log(`  NET ${r.url()} <- ${r.postData()}`);
    }
  });

  await login(page);
  await openBoard(page);

  let board = await readBoard(page);
  console.log('  board:', fmt(board));
  await shot(page, '01-initial-board.png');
  console.log('initial:', fmt(board));

  {
    const col = COLUMNS.find((c) => board[c].length >= 2);
    if (!col) {
      record('S1 8px gap between cards', 'two consecutive cards in a column are 8px apart', 'no column has 2+ cards', false, 'major');
    } else {
      const b0 = await cardBox(page, col, 0);
      const b1 = await cardBox(page, col, 1);
      const gap = b1.y - (b0.y + b0.height);
      record(
        `S1 8px vertical gap between cards (${col})`,
        'gap between consecutive cards == 8px',
        `gap == ${gap}px (card0 bottom ${b0.y + b0.height}, card1 top ${b1.y})`,
        gap >= 7 && gap <= 9,
        'major',
      );
      await shot(page, '02-gap-zoom.png', { x: b0.x - 20, y: b0.y - 40, width: b0.width + 40, height: b0.height + b1.height + 60 });
    }
  }

  {
    const pick = uniqueTitlePick(board);
    if (!pick) {
      record('S2 drop above hovered card', 'card lands at hovered card index', 'no unique title available', false, 'major');
    } else {
      const tgt = COLUMNS.find((c) => c !== pick.col && board[c].length >= 2 && !board[c].includes(pick.title));
      if (!tgt) {
        record('S2 drop above hovered card', 'card lands at hovered card index', 'no suitable target column', false, 'major');
      } else {
        const b = await cardBox(page, tgt, 1);
        const before = board[tgt].slice();
        const expected = [before[0], pick.title, ...before.slice(1)];
        let midDragClass = '';
        await drag(
          page,
          pick.col,
          pick.idx,
          b.x + b.width / 2,
          b.y - 4,
          '05-drag-indicator.png',
          async (p) => {
            midDragClass = (await p.locator(`div[role=group][aria-label="${tgt}"]`).getAttribute('class')) ?? '';
            return `target column (${tgt}) classes: ${midDragClass}`;
          },
        );
        board = await readBoard(page);
  console.log('  board:', fmt(board));
        const actual = board[tgt];
        record(
          `S2 cross-column drop above hovered card (${pick.col} → ${tgt}, over card #1)`,
          `target column == [${expected.join(', ')}]`,
          `target column == [${actual.join(', ')}]`,
          JSON.stringify(actual) === JSON.stringify(expected),
          'major',
        );
        record(
          'S2b drop indicator: target column highlighted (ring-2 ring-primary) while dragging over it',
          'mid-drag target column class contains ring-2 ring-primary',
          `mid-drag class == "${midDragClass}"`,
          midDragClass.includes('ring-2') && midDragClass.includes('ring-primary'),
          'minor',
        );
        await shot(page, '03-drop-above-after.png');
      }
    }
  }

  {
    const pick = uniqueTitlePick(board);
    if (!pick) {
      record('S3 drop below hovered card', 'card lands at hovered index + 1', 'no unique title available', false, 'major');
    } else {
      const tgt = COLUMNS.find((c) => c !== pick.col && board[c].length >= 2 && !board[c].includes(pick.title));
      if (!tgt) {
        record('S3 drop below hovered card', 'card lands at hovered index + 1', 'no suitable target column', false, 'major');
      } else {
        const b = await cardBox(page, tgt, 1);
        const before = board[tgt].slice();
        const expected = [before[0], before[1], pick.title, ...before.slice(2)];
        await drag(page, pick.col, pick.idx, b.x + b.width / 2, b.y + b.height + 4);
        board = await readBoard(page);
  console.log('  board:', fmt(board));
        const actual = board[tgt];
        record(
          `S3 cross-column drop below hovered card (${pick.col} → ${tgt}, over card #1)`,
          `target column == [${expected.join(', ')}]`,
          `target column == [${actual.join(', ')}]`,
          JSON.stringify(actual) === JSON.stringify(expected),
          'major',
        );
        await shot(page, '04-drop-below-after.png');
      }
    }
  }

  {
    const pick = uniqueTitlePick(board);
    if (!pick) {
      record('S4 drop on column background → end of column', 'card appended at column end', 'no unique title available', false, 'major');
    } else {
      const tgt = COLUMNS.find((c) => c !== pick.col && board[c].length >= 1 && !board[c].includes(pick.title));
      if (!tgt) {
        record('S4 drop on column background → end of column', 'card appended at column end', 'no suitable target column', false, 'major');
      } else {
        const b = await cardBox(page, tgt, board[tgt].length - 1);
        const colBox = await colLoc(page, tgt).boundingBox();
        console.log(`  S4 tgt=${tgt} lastCardBox=(${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}) colBox=(${Math.round(colBox.x)},${Math.round(colBox.y)},${Math.round(colBox.width)},${Math.round(colBox.height)})`);
        const toY = Math.min(b.y + b.height + 14, colBox.y + colBox.height - 10);
        const expected = [...board[tgt], pick.title];
        await drag(page, pick.col, pick.idx, b.x + b.width / 2, toY);
        board = await readBoard(page);
  console.log('  board:', fmt(board));
        const actual = board[tgt];
        record(
          `S4 drop below last card (${pick.col} → ${tgt}) → end of column`,
          `target column == [${expected.join(', ')}]`,
          `target column == [${actual.join(', ')}]`,
          JSON.stringify(actual) === JSON.stringify(expected),
          'major',
        );
        await shot(page, '06-drop-background-after.png');
      }
    }
  }

  {
    let emptyCol = COLUMNS.find((c) => board[c].length === 0);
    if (!emptyCol) {
      const smallest = COLUMNS.reduce((a, b) => (board[a].length <= board[b].length ? a : b));
      if (board[smallest].length === 1) {
        const pick = { title: board[smallest][0], col: smallest, idx: 0 };
        const donor = COLUMNS.find((c) => c !== smallest && board[c].length >= 1 && !board[c].includes(pick.title));
        const b = await cardBox(page, donor, board[donor].length - 1);
        await drag(page, smallest, 0, b.x + b.width / 2, b.y + b.height + 14);
        board = await readBoard(page);
  console.log('  board:', fmt(board));
        emptyCol = smallest;
      }
    }
    if (!emptyCol) {
      record('S5 drop into empty column → index 0', 'card becomes the only card in the column', 'could not create/find an empty column', false, 'major');
    } else {
      const stub = await colLoc(page, emptyCol).locator('[data-testid="kanban-empty-column"]').count();
      const pick = uniqueTitlePick(board);
      const colBox = await colLoc(page, emptyCol).boundingBox();
      await drag(page, pick.col, pick.idx, colBox.x + colBox.width / 2, colBox.y + colBox.height / 2);
      board = await readBoard(page);
  console.log('  board:', fmt(board));
      const actual = board[emptyCol];
      record(
        `S5 drop into empty column (${pick.title} → ${emptyCol}) → index 0`,
        `column == [${pick.title}]`,
        `column == [${actual.join(', ')}]`,
        JSON.stringify(actual) === JSON.stringify([pick.title]),
        'major',
      );
      record(
        `S5b empty column shows "No tasks" stub before the drop (${emptyCol})`,
        'stub with data-testid=kanban-empty-count/kanban-empty-column rendered',
        `stub count before drop == ${stub}`,
        stub === 1,
        'minor',
      );
      await shot(page, '07-empty-column-after.png');
    }
  }

  {
    const before = board;
    let after = null;
    let reloadError = null;
    try {
      await page.reload({ waitUntil: 'networkidle' });
      await login(page);
      await openBoard(page);
      after = await readBoard(page);
    } catch (e) {
      reloadError = e.message;
    }
    board = after ?? board;
    record(
      'S6 board state persists across reload (localStorage)',
      `board after reload == [${fmt(before)}]`,
      after ? `board after reload == [${fmt(after)}]` : `reload failed: ${reloadError}`,
      after !== null && JSON.stringify(after) === JSON.stringify(before),
      'major',
    );
    if (after) await shot(page, '08-after-reload.png');
  }

  {
    const store = await storeState(page);
    const dom = await readBoard(page);
    const map = { open: 'Open', in_progress: 'In Progress', completed: 'Completed', cancelled: 'Cancelled' };
    let ok = true;
    const mismatches = [];
    for (const [k, label] of Object.entries(map)) {
      const storeTitles = store[k].map((e) => e.split('@')[0]);
      if (JSON.stringify(dom[label]) !== JSON.stringify(storeTitles)) { ok = false; mismatches.push(`${label}: dom=[${dom[label].join(',')}] store=[${storeTitles.join(',')}]`); }
    }
    record(
      'S6b DOM order matches localStorage position order in every column (scattered positions render correctly)',
      'DOM card order == tasks sorted by position per column',
      ok ? 'all 4 columns match' : mismatches.join(' | '),
      ok,
      'major',
    );
  }

  {
    const col = COLUMNS.find((c) => board[c].length >= 3);
    if (!col) {
      record('S7 in-column reorder (D6 protected)', 'card moves within a 3+ column', 'no column with 3+ cards', false, 'major');
    } else {
      const title = `PW-Reorder-${Date.now() % 100000}`;
      await colLoc(page, col).getByRole('button', { name: '+ Add Task' }).click();
      const input = colLoc(page, col).locator('[data-testid="kanban-quick-add"]');
      await input.waitFor({ timeout: 5000 });
      await input.fill(title);
      await colLoc(page, col).getByRole('button', { name: 'Add', exact: true }).click();
      await page.waitForTimeout(2000);
      board = await readBoard(page);
  console.log('  board:', fmt(board));
      const fromIdx = board[col].indexOf(title);
      if (fromIdx < 0) {
        record('S7 in-column reorder (D6 protected)', 'quick-added card lands at column end', `"${title}" not found in ${col}: [${board[col].join(', ')}]`, false, 'major');
      } else {
        const b = await cardBox(page, col, 2);
        const before = board[col].filter((t) => t !== title);
        const expected = [...before.slice(0, 2), title, ...before.slice(2)];
        await drag(page, col, fromIdx, b.x + b.width / 2, b.y - 4);
        board = await readBoard(page);
  console.log('  board:', fmt(board));
        const actual = board[col];
        record(
          `S7 in-column reorder (${col}, from end to above card #2)`,
          `column == [${expected.join(', ')}]`,
          `column == [${actual.join(', ')}]`,
          JSON.stringify(actual) === JSON.stringify(expected),
          'major',
        );
        await shot(page, '09-in-column-reorder-after.png');
      }
    }
  }

  {
    const col = COLUMNS.find((c) => board[c].length >= 1) ?? COLUMNS[0];
    const title = `PW-Verify-${Date.now() % 100000}`;
    await colLoc(page, col).getByRole('button', { name: '+ Add Task' }).click();
    const input = colLoc(page, col).locator('[data-testid="kanban-quick-add"]');
    await input.waitFor({ timeout: 5000 });
    await input.fill(title);
    await colLoc(page, col).getByRole('button', { name: 'Add', exact: true }).click();
    await page.waitForTimeout(2000);
    board = await readBoard(page);
  console.log('  board:', fmt(board));
    const actual = board[col];
    const expected = [...board[col].filter((t) => t !== title), title];
    record(
      `S8 quick-add appends new task at column end (${col})`,
      `column ends with "${title}" (== [${expected.join(', ')}])`,
      `column == [${actual.join(', ')}]`,
      JSON.stringify(actual) === JSON.stringify(expected),
      'major',
    );
    await shot(page, '10-quick-add-after.png');
  }

  {
    const pick = uniqueTitlePick(board);
    if (!pick) {
      record('S11 card click navigates to task detail (D6)', 'clicking a card opens /tasks/:id', 'no unique card available', false, 'major');
    } else {
      await cardLoc(page, pick.col, pick.idx).click();
      let detailOk = false;
      let detailInfo = '';
      let detailUrl = '';
      try {
        await page.waitForURL(/\/tasks\//, { timeout: 10000 });
        detailUrl = page.url();
        const h1 = (await page.locator('h1').first().textContent()) ?? '';
        const titleValue = await page.locator('#title').inputValue();
        detailOk = h1.trim() === 'Edit Task' && titleValue === pick.title;
        detailInfo = `URL == ${detailUrl}, h1 == "${h1.trim()}", title input == "${titleValue}"`;
      } catch (e) {
        detailInfo = `navigation failed: ${e.message}`;
      }
      record(
        `S11 card click navigates to task detail (${pick.title})`,
        `URL /tasks/:id, h1 == "Edit Task", title input == "${pick.title}"`,
        detailInfo,
        detailOk,
        'major',
      );
      await shot(page, '12-task-detail-after-click.png');
      await page.goBack();
      await page.waitForSelector('h2:has-text("Kanban Board")', { timeout: 15000 });
      await page.waitForTimeout(500);
      board = await readBoard(page);
  console.log('  board:', fmt(board));
    }
  }

  {
    const beforeToggle = board;
    await page.getByRole('button', { name: 'Back to List' }).click();
    let listOk = false;
    let listH1 = '';
    try {
      await page.waitForSelector('h1:has-text("Tasks")', { timeout: 10000 });
      listH1 = (await page.locator('h1:has-text("Tasks")').textContent()) ?? '';
      const searchVisible = await page.getByPlaceholder('Search tasks...').isVisible();
      listOk = searchVisible;
    } catch (e) {
      listOk = false;
    }
    record(
      'S12 view toggle: "Back to List" shows the list view',
      'h1 "Tasks" + search input visible',
      `h1 == "${listH1}", list rendered == ${listOk}`,
      listOk,
      'minor',
    );
    await shot(page, '13-list-view.png');
    await page.getByRole('button', { name: 'Kanban Board' }).click();
    await page.waitForSelector('h2:has-text("Kanban Board")', { timeout: 10000 });
    await page.waitForTimeout(500);
    board = await readBoard(page);
  console.log('  board:', fmt(board));
    record(
      'S12b view toggle: "Kanban Board" button returns to the board with the same state',
      `board after round-trip == [${fmt(beforeToggle)}]`,
      `board after round-trip == [${fmt(board)}]`,
      JSON.stringify(board) === JSON.stringify(beforeToggle),
      'minor',
    );
  }

  {
    const store = await storeState(page);
    let ok = store !== null;
    const bad = [];
    if (store) {
      for (const [col, entries] of Object.entries(store)) {
        const positions = entries.map((e) => Number(e.split('@')[1]));
        if (!positions.every((p) => Number.isInteger(p) && p >= 0)) { ok = false; bad.push(`${col}=[${entries.join(', ')}]`); }
      }
    }
    record(
      'S9 persisted positions stay valid non-negative integers after all drops (store not corrupted)',
      'every task position in localStorage is a non-negative integer',
      ok ? `all valid: ${fmtStore(store)}` : `invalid: ${bad.join(' | ')}`,
      ok,
      'minor',
    );
  }

  record(
    'S10 no console errors or uncaught page errors during all interactions',
    'zero console.error / pageerror entries',
    `${consoleErrors.length} console errors, ${pageErrors.length} page errors${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''}${pageErrors.length ? ': ' + pageErrors.join(' | ') : ''}`,
    consoleErrors.length === 0 && pageErrors.length === 0,
    'major',
  );

  await shot(page, '11-final-board.png');

  const pass = findings.length === 0;
  const out = {
    status: pass ? 'pass' : 'fail',
    summary: '',
    scenarios,
    findings,
  };
  fs.writeFileSync(`${ROOT}/.issue-test-result.json`, JSON.stringify(out, null, 2));
  console.log(`\nRESULT: ${pass ? 'PASS' : 'FAIL'} — ${scenarios.length} scenarios, ${findings.length} findings`);
  await browser.close();
}

main().catch((e) => {
  console.error('FATAL:', e);
  try {
    fs.writeFileSync(
      `${ROOT}/.issue-test-result.json`,
      JSON.stringify({ status: 'fail', summary: `test harness fatal: ${e.message}`, scenarios, findings }, null, 2),
    );
  } catch {}
  process.exit(1);
});
