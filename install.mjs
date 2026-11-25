#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  readJsonWithBOMDefenseSync,
  writeFileSyncAndVerifyNoBOM
} from './hooks/lib/core/fs-utils.mjs';
import { getStatusLineCommand } from './hooks/lib/core/settings.mjs';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_HOOKS_DIR = path.join(REPO_ROOT, 'hooks');
const ENTRY_FILENAME = 'custom-compact-statusline.mjs';
const BACKUP_FILENAME = '.tako-agy-bar-backup.json';

function parseArgs(argv) {
  const opts = {
    homeDir: os.homedir(),
    stackWithDefault: true,
    dryRun: false,
    quiet: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--no-stack') {
      opts.stackWithDefault = false;
    } else if (arg === '--stack') {
      opts.stackWithDefault = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--quiet' || arg === '-q') {
      opts.quiet = true;
    } else if (arg === '--home' && i + 1 < argv.length) {
      const val = argv[++i];
      if (!val || !val.trim()) throw new Error('Invalid --home value: directory path cannot be empty');
      opts.homeDir = path.resolve(val);
    } else if (arg.startsWith('--home=')) {
      const val = arg.slice('--home='.length);
      if (!val || !val.trim()) throw new Error('Invalid --home value: directory path cannot be empty');
      opts.homeDir = path.resolve(val);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Tako AGY Bar Installer

Usage:
  node install.mjs [options]

Options:
  --home <dir>   Override target home directory (default: current user home)
  --no-stack     Replace built-in status line instead of stacking below it
  --dry-run      Preview planned changes without writing files
  --quiet, -q    Minimal output
  --help, -h     Show this help message`);
}

function listAllFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listAllFiles(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out.sort();
}

function ensureNodeVersion(minMajor = 18) {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isNaN(major) || major < minMajor) {
    throw new Error(`Node.js >= ${minMajor} is required (current: ${process.versions.node}).`);
  }
}

function runSmokeCheck(entryScriptPath) {
  execFileSync(process.execPath, ['--check', entryScriptPath], { stdio: 'pipe' });
  const quotaScriptPath = path.join(path.dirname(entryScriptPath), 'fetch-local-quota.mjs');
  if (fs.existsSync(quotaScriptPath)) {
    execFileSync(process.execPath, ['--check', quotaScriptPath], { stdio: 'pipe' });
  }

  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tako-agy-bar-probe-'));
  try {
    const sampleMeta = JSON.stringify({
      conversation_id: '',
      terminal_width: 96,
      model: { id: 'gemini-3.5-flash', display_name: 'Gemini 3.5 Flash' },
      context_window: {
        context_window_size: 1048576,
        total_input_tokens: 120000,
        total_output_tokens: 4000,
        used_percentage: 11.4,
        current_usage: {
          input_tokens: 5000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 95000
        }
      },
      quota: {
        gemini: { remaining_fraction: 0.95, reset_in_seconds: 17220 },
        'gemini-weekly': { remaining_fraction: 0.82, reset_in_seconds: 550800 }
      }
    });

    const probeEnv = {
      ...process.env,
      HOME: probeHome,
      USERPROFILE: probeHome,
      STATUSLINE_QUOTA_WAIT_MS: '50'
    };
    delete probeEnv.DISABLE_QUOTA_HOOK;
    delete probeEnv.ANTIGRAVITY_LS_ADDRESS;
    delete probeEnv.ANTIGRAVITY_CSRF_TOKEN;

    const res = spawnSync(process.execPath, [entryScriptPath], {
      input: sampleMeta,
      encoding: 'utf8',
      env: probeEnv,
      windowsHide: true
    });

    if (res.status !== 0) {
      throw new Error(`Smoke test exited with code ${res.status}: ${res.stderr || res.stdout}`);
    }
    const lines = String(res.stdout || '').split(/\r?\n/);
    if (lines.length < 4 || !lines[1].includes('Cached') || !lines[3].includes('Five Hours')) {
      throw new Error(`Unexpected smoke test output:\n${res.stdout}`);
    }
  } finally {
    fs.rmSync(probeHome, { recursive: true, force: true });
  }
}

export function installTakoAgyBar(options = {}) {
  ensureNodeVersion(18);
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const stackWithDefault = options.stackWithDefault !== false;
  const dryRun = Boolean(options.dryRun);
  const quiet = Boolean(options.quiet);

  if (!fs.existsSync(SOURCE_HOOKS_DIR)) {
    throw new Error(`Source hooks directory not found: ${SOURCE_HOOKS_DIR}`);
  }

  const targetHooksDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'hooks');
  const targetEntryScript = path.join(targetHooksDir, ENTRY_FILENAME);
  const cliSettingsPath = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
  const globalSettingsPath = path.join(homeDir, '.gemini', 'settings.json');
  const defaultCtxPollutant = path.join(homeDir, '.gemini', 'tmp', 'ctx_default.json');
  const backupPath = path.join(targetHooksDir, BACKUP_FILENAME);

  const relFiles = listAllFiles(SOURCE_HOOKS_DIR);
  const statusLineCmd = getStatusLineCommand(targetEntryScript);

  // Pre-validate existing settings files before mutating anything
  const cliSettings = readJsonWithBOMDefenseSync(cliSettingsPath);
  if (cliSettings === null) {
    throw new Error(`Refusing to overwrite invalid JSON in ${cliSettingsPath}`);
  }
  const hasGlobalSettings = fs.existsSync(globalSettingsPath);
  const globalSettings = hasGlobalSettings ? readJsonWithBOMDefenseSync(globalSettingsPath) : null;
  if (hasGlobalSettings && globalSettings === null) {
    throw new Error(`Refusing to overwrite invalid JSON in ${globalSettingsPath}`);
  }

  if (dryRun) {
    return {
      dryRun: true,
      homeDir,
      targetHooksDir,
      targetEntryScript,
      statusLineCmd,
      stackWithDefault,
      filesCount: relFiles.length,
      updatedSettings: [cliSettingsPath, ...(hasGlobalSettings ? [globalSettingsPath] : [])]
    };
  }

  // 1. Atomically deploy all hook & lib files first (never expose partial scripts to running agy)
  for (const rel of relFiles) {
    const srcPath = path.join(SOURCE_HOOKS_DIR, rel);
    const dstPath = path.join(targetHooksDir, rel);
    const content = fs.readFileSync(srcPath, 'utf8').replace(/\r\n/g, '\n');
    writeFileSyncAndVerifyNoBOM(dstPath, content);
  }

  // 2. Verify deployed scripts pass syntax check and live JSON pipe smoke test
  runSmokeCheck(targetEntryScript);

  // 3. Clean stale ctx_default.json if present from legacy experiments
  if (fs.existsSync(defaultCtxPollutant)) {
    try {
      fs.unlinkSync(defaultCtxPollutant);
    } catch (_) {}
  }

  // 4. Backup previous non-tako statusLine setting once for clean uninstall
  const prevStatusLine = cliSettings.statusLine && typeof cliSettings.statusLine === 'object'
    ? cliSettings.statusLine
    : null;
  if (
    prevStatusLine &&
    typeof prevStatusLine.command === 'string' &&
    !prevStatusLine.command.includes(ENTRY_FILENAME) &&
    !fs.existsSync(backupPath)
  ) {
    writeFileSyncAndVerifyNoBOM(
      backupPath,
      JSON.stringify({ previousStatusLine: prevStatusLine, savedAt: new Date().toISOString() }, null, 2) + '\n'
    );
  }

  // 5. Merge statusLine cleanly into settings.json (preserving all other keys, BOM-free)
  const updateSettingsFile = (filePath, existingObj) => {
    const baseSl = (existingObj.statusLine && typeof existingObj.statusLine === 'object' && !Array.isArray(existingObj.statusLine))
      ? { ...existingObj.statusLine }
      : {};
    delete baseSl.padding; // Leading spacer line is rendered natively for hot-reload reliability
    const nextSettings = {
      ...existingObj,
      statusLine: {
        ...baseSl,
        enabled: true,
        type: 'command',
        command: statusLineCmd,
        stack_with_default: stackWithDefault
      }
    };
    writeFileSyncAndVerifyNoBOM(filePath, JSON.stringify(nextSettings, null, 2) + '\n');
  };

  updateSettingsFile(cliSettingsPath, cliSettings);
  const updatedSettings = [cliSettingsPath];
  if (hasGlobalSettings && globalSettings) {
    updateSettingsFile(globalSettingsPath, globalSettings);
    updatedSettings.push(globalSettingsPath);
  }

  if (!quiet) {
    console.log(`[Tako AGY Bar] Deployed ${relFiles.length} runtime files -> ${targetHooksDir}`);
    console.log(`[Tako AGY Bar] Updated settings (BOM-free): ${updatedSettings.join(', ')}`);
    console.log(`[Tako AGY Bar] stack_with_default: ${stackWithDefault}`);
    console.log('');
    console.log('To activate immediately inside a running Antigravity CLI session without restarting, run:');
    console.log(`  /statusline ${statusLineCmd}`);
  }

  return {
    dryRun: false,
    homeDir,
    targetHooksDir,
    targetEntryScript,
    statusLineCmd,
    stackWithDefault,
    filesCount: relFiles.length,
    updatedSettings
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    const res = installTakoAgyBar(opts);
    if (opts.dryRun) {
      console.log(JSON.stringify(res, null, 2));
    }
  } catch (err) {
    console.error(`[Tako AGY Bar] Install failed: ${err.message}`);
    process.exit(1);
  }
}
