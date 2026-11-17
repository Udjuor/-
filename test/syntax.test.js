'use strict';
// Окно программы не загружается целиком в тестах: проверяем хотя бы, что код без синтаксических ошибок.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('код окна программы без синтаксических ошибок', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syntax-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const copy = path.join(dir, 'app.mjs');
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), copy);
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' }));
});
