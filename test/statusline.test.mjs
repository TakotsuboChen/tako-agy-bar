import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import {
  alignRight,
  formatCompactTwoLineOutput,
  getGradientColor,
  renderPlainBar,
  resolveCacheHitRate
} from '../hooks/custom-compact-statusline.mjs';
import { resolveConversationCtxCachePath } from '../hooks/lib/collectors/context.mjs';
import { getStatusLineCommand } from '../hooks/lib/core/settings.mjs';
import { getDisplayWidth, stripAnsi } from '../hooks/lib/renderers/ansi.mjs';
import { installTakoAgyBar } from '../install.mjs';
import { uninstallTakoAgyBar } from '../uninstall.mjs';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_SCRIPT = path.resolve(REPO_ROOT, '..', 'hooks', 'custom-compact-statusline.mjs');

test('getGradientColor interpolates smooth RGB stops from red -> yellow -> green', () => {
  assert.equal(getGradientColor(100, 0, 100), '\x1b[38;2;92;219;109m');
  assert.equal(getGradientColor(50, 0, 100), '\x1b[38;2;255;212;39m');
  assert.equal(getGradientColor(0, 0, 100), '\x1b[38;2;255;85;85m');

  // Cached [80, 100] sensitive scale
  assert.equal(getGradientColor(100, 80, 100), '\x1b[38;2;92;219;109m');
  assert.equal(getGradientColor(90, 80, 100), '\x1b[38;2;255;212;39m');
  assert.equal(getGradientColor(80, 80, 100), '\x1b[38;2;255;85;85m');
  assert.equal(getGradientColor(40, 80, 100), '\x1b[38;2;255;85;85m');
});

test('renderPlainBar produces 1/8-block sub-cell precision bars with invariant display width', () => {
  assert.equal(stripAnsi(renderPlainBar(0, 10)), '░░░░░░░░░░');
  assert.equal(stripAnsi(renderPlainBar(59.9, 10)), '██████░░░░');
  assert.equal(stripAnsi(renderPlainBar(79, 10)), '███████▉░░');
  assert.equal(stripAnsi(renderPlainBar(80, 10)), '████████░░');
  assert.equal(stripAnsi(renderPlainBar(150, 10)), '██████████');
  assert.equal(stripAnsi(renderPlainBar(-10, 10)), '░░░░░░░░░░');

  for (let p = 0; p <= 100; p += 0.5) {
    const rendered = renderPlainBar(p, 10, '\x1b[38;2;92;219;109m');
    assert.equal(getDisplayWidth(stripAnsi(rendered)), 10);
  }
});

test('resolveCacheHitRate computes exact ratio and falls back smoothly during transient nulls', () => {
  const fresh = resolveCacheHitRate({
    context_window: {
      current_usage: {
        input_tokens: 4900,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 95000
      }
    }
  });
  assert.equal(fresh.fresh, true);
  assert.equal(Number(fresh.pct.toFixed(1)), 95.0);

  const transientFallback = resolveCacheHitRate(
    { context_window: { current_usage: null } },
    { cache_hit_pct: 91.4, cache_read_input_tokens: 50000 }
  );
  assert.equal(transientFallback.fresh, false);
  assert.equal(transientFallback.pct, 91.4);

  const initialBlank = resolveCacheHitRate({}, null);
  assert.equal(initialBlank.pct, null);
});

test('formatCompactTwoLineOutput emits 4-line spaced right-aligned telemetry with soft-limit pct, bar, and colors', () => {
  const terminalWidth = 100;
  const output = formatCompactTwoLineOutput({
    cacheHitPct: 98.7,
    contextInfo: {
      totalInput: 399200,
      contextSize: 1048576,
      effectiveTokenCeiling: 512000,
      usedPctNum: 38.1
    },
    quotaInfo: { remaining_percentage: 63, refreshes_in: '4h 37m' },
    weeklyInfo: { remaining_percentage: 82, refreshes_in: '6d 9h' },
    barLength: 10,
    terminalWidth
  });

  const lines = output.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], '');
  assert.equal(lines[2], '');

  const plain1 = stripAnsi(lines[1]);
  const plain2 = stripAnsi(lines[3]);
  assert.equal(getDisplayWidth(plain1), terminalWidth);
  assert.equal(getDisplayWidth(plain2), terminalWidth);
  assert.match(plain1, /Cached 98\.7% \| Context 78\.0% ███████▊░░ 399\.2\/512\.0k$/);
  assert.match(plain2, /Five Hours 63% ██████▎░░░ 4h37m \| Weekly 82% ████████▎░ 6d9h$/);

  // Percentage, bar fill, and token numerator must all match the soft-limit ratio (399.2/512k => 78.0%, 62/80 eighths, rgb(255,141,65))
  const expectedSoftColor = getGradientColor(100 - (399200 / 512000) * 100, 0, 100);
  assert.equal(expectedSoftColor, '\x1b[38;2;255;141;65m');
  assert.ok(lines[1].includes(`${expectedSoftColor}\x1b[1m78.0%\x1b[0m ${expectedSoftColor}███████\x1b[0m${expectedSoftColor}\x1b[48;2;108;108;109m▊\x1b[0m░░ ${expectedSoftColor}399.2\x1b[0m/512.0k`));

  assert.equal(stripAnsi(alignRight('abc', 5)), '  abc');
});

test('resolveConversationCtxCachePath isolates blank or default conversation IDs', () => {
  assert.equal(resolveConversationCtxCachePath(''), '');
  assert.equal(resolveConversationCtxCachePath('default'), '');
  assert.equal(resolveConversationCtxCachePath('   '), '');
  assert.match(resolveConversationCtxCachePath('conv-123', '/tmp/home'), /ctx_conv-123\.json$/);
});

test('getStatusLineCommand formats safe cross-platform commands without Windows quote bugs', () => {
  assert.equal(
    getStatusLineCommand('C:\\Users\\Demo\\.gemini\\antigravity-cli\\hooks\\custom-compact-statusline.mjs', 'win32', 'C:\\Program Files\\nodejs\\node.exe'),
    'node C:\\Users\\Demo\\.gemini\\antigravity-cli\\hooks\\custom-compact-statusline.mjs'
  );
  assert.equal(
    getStatusLineCommand('C:\\Users\\First Last\\.gemini\\antigravity-cli\\hooks\\custom-compact-statusline.mjs', 'win32', 'C:\\Program Files\\nodejs\\node.exe'),
    'node --import file:///C:/Users/First%20Last/.gemini/antigravity-cli/hooks/custom-compact-statusline.mjs -e 0'
  );
  assert.equal(
    getStatusLineCommand('/home/user/.gemini/antigravity-cli/hooks/custom-compact-statusline.mjs', 'linux', '/home/user/.nvm/versions/node/v24.0.0/bin/node'),
    '/home/user/.nvm/versions/node/v24.0.0/bin/node /home/user/.gemini/antigravity-cli/hooks/custom-compact-statusline.mjs'
  );
});

test('blank startup input ignores ctx_default.json and prevents cross-session leakage', () => {
  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tako-agy-bar-blank-'));
  try {
    const tmpDir = path.join(probeHome, '.gemini', 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'ctx_default.json'),
      JSON.stringify({ total_input_tokens: 293800, used_percentage: 28.0 })
    );

    const probeEnv = { ...process.env, HOME: probeHome, USERPROFILE: probeHome, STATUSLINE_QUOTA_WAIT_MS: '50' };
    delete probeEnv.DISABLE_QUOTA_HOOK;
    delete probeEnv.ANTIGRAVITY_LS_ADDRESS;
    delete probeEnv.ANTIGRAVITY_CSRF_TOKEN;

    const res = spawnSync(process.execPath, [ENTRY_SCRIPT], {
      input: JSON.stringify({ conversation_id: '', terminal_width: 90 }),
      encoding: 'utf8',
      env: probeEnv,
      windowsHide: true
    });
    assert.equal(res.status, 0);
    const plain = stripAnsi(res.stdout);
    assert.match(plain, /Context 0\.0% ░░░░░░░░░░ 0\/256\.0k/);
  } finally {
    fs.rmSync(probeHome, { recursive: true, force: true });
  }
});

test('installTakoAgyBar and uninstallTakoAgyBar preserve existing settings and cleanly deploy/restore', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tako-agy-bar-install-'));
  try {
    const cliDir = path.join(fakeHome, '.gemini', 'antigravity-cli');
    const globalDir = path.join(fakeHome, '.gemini');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.mkdirSync(path.join(globalDir, 'tmp'), { recursive: true });

    const originalCliSettings = {
      model: 'Gemini 4 Hydrogen (XHigh)',
      ui: { language: 'zh-cn' },
      statusLine: {
        enabled: true,
        type: 'command',
        command: 'echo old-bar',
        padding: 1
      },
      customUserFlag: 'keep-me'
    };
    const originalGlobalSettings = {
      security: { auth: { selectedType: 'oauth-personal' } },
      ui: { language: 'zh-cn' }
    };

    const cliSettingsPath = path.join(cliDir, 'settings.json');
    const globalSettingsPath = path.join(globalDir, 'settings.json');
    fs.writeFileSync(cliSettingsPath, JSON.stringify(originalCliSettings, null, 2));
    fs.writeFileSync(globalSettingsPath, JSON.stringify(originalGlobalSettings, null, 2));
    fs.writeFileSync(path.join(globalDir, 'tmp', 'ctx_default.json'), '{"total_input_tokens":123}');

    const installRes = installTakoAgyBar({ homeDir: fakeHome, quiet: true });
    assert.equal(installRes.filesCount, 12);
    assert.equal(installRes.stackWithDefault, true);
    assert.equal(fs.existsSync(path.join(globalDir, 'tmp', 'ctx_default.json')), false);

    // Ensure BOM-free and unrelated settings preserved
    const rawCli = fs.readFileSync(cliSettingsPath);
    assert.equal(rawCli[0] === 0xef && rawCli[1] === 0xbb && rawCli[2] === 0xbf, false);
    const updatedCli = JSON.parse(rawCli.toString('utf8'));
    assert.equal(updatedCli.model, 'Gemini 4 Hydrogen (XHigh)');
    assert.equal(updatedCli.customUserFlag, 'keep-me');
    assert.equal(updatedCli.statusLine.enabled, true);
    assert.equal(updatedCli.statusLine.stack_with_default, true);
    assert.equal('padding' in updatedCli.statusLine, false);
    assert.match(updatedCli.statusLine.command, /custom-compact-statusline\.mjs/);

    const updatedGlobal = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf8'));
    assert.equal(updatedGlobal.security.auth.selectedType, 'oauth-personal');
    assert.equal(updatedGlobal.statusLine.stack_with_default, true);

    // Verify uninstall restores previous statusLine and removes deployed files
    const uninstallRes = uninstallTakoAgyBar({ homeDir: fakeHome, quiet: true });
    assert.equal(uninstallRes.restoredPrevious, true);
    assert.equal(uninstallRes.removedCount, 12);

    const restoredCli = JSON.parse(fs.readFileSync(cliSettingsPath, 'utf8'));
    assert.deepEqual(restoredCli.statusLine, originalCliSettings.statusLine);
    assert.equal(restoredCli.customUserFlag, 'keep-me');
    assert.equal(fs.existsSync(path.join(cliDir, 'hooks', 'custom-compact-statusline.mjs')), false);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
