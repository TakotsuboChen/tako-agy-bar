#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  readJsonSafeSync,
  readJsonWithBOMDefenseSync,
  writeFileSyncAndVerifyNoBOM
} from './hooks/lib/core/fs-utils.mjs';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_HOOKS_DIR = path.join(REPO_ROOT, 'hooks');
const ENTRY_FILENAME = 'custom-compact-statusline.mjs';
const BACKUP_FILENAME = '.tako-agy-bar-backup.json';

function parseArgs(argv) {
  const opts = {
    homeDir: os.homedir(),
    dryRun: false,
    quiet: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
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

function listAllFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listAllFiles(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

function removeEmptyDirs(dir, stopAt) {
  if (!fs.existsSync(dir) || path.resolve(dir) === path.resolve(stopAt)) return;
  if (fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    removeEmptyDirs(path.dirname(dir), stopAt);
  }
}

export function uninstallTakoAgyBar(options = {}) {
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const dryRun = Boolean(options.dryRun);
  const quiet = Boolean(options.quiet);

  const targetHooksDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'hooks');
  const backupPath = path.join(targetHooksDir, BACKUP_FILENAME);
  const cliSettingsPath = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
  const globalSettingsPath = path.join(homeDir, '.gemini', 'settings.json');

  const deployedFiles = listAllFiles(SOURCE_HOOKS_DIR);
  const backup = readJsonSafeSync(backupPath);
  const previousStatusLine = backup?.previousStatusLine || null;

  if (dryRun) {
    return {
      dryRun: true,
      homeDir,
      targetHooksDir,
      restoredPrevious: Boolean(previousStatusLine),
      filesToRemove: deployedFiles
    };
  }

  for (const settingsPath of [cliSettingsPath, globalSettingsPath]) {
    if (!fs.existsSync(settingsPath)) continue;
    const settings = readJsonWithBOMDefenseSync(settingsPath);
    if (!settings) continue;

    const currentSl = settings.statusLine;
    const pointsToTako = typeof currentSl?.command === 'string' && currentSl.command.includes(ENTRY_FILENAME);
    if (!pointsToTako) continue;

    const nextSettings = { ...settings };
    if (previousStatusLine) {
      nextSettings.statusLine = previousStatusLine;
    } else {
      delete nextSettings.statusLine;
    }
    writeFileSyncAndVerifyNoBOM(settingsPath, JSON.stringify(nextSettings, null, 2) + '\n');
  }

  let removedCount = 0;
  for (const rel of deployedFiles) {
    const targetFile = path.join(targetHooksDir, rel);
    if (fs.existsSync(targetFile)) {
      fs.unlinkSync(targetFile);
      removedCount++;
      removeEmptyDirs(path.dirname(targetFile), targetHooksDir);
    }
  }
  if (fs.existsSync(backupPath)) {
    fs.unlinkSync(backupPath);
  }
  removeEmptyDirs(targetHooksDir, path.join(homeDir, '.gemini', 'antigravity-cli'));

  if (!quiet) {
    console.log(`[Tako AGY Bar] Removed ${removedCount} deployed files from ${targetHooksDir}`);
    console.log(previousStatusLine
      ? '[Tako AGY Bar] Restored previous statusLine configuration.'
      : '[Tako AGY Bar] Removed Tako AGY Bar statusLine configuration (built-in bar restored).');
  }

  return {
    dryRun: false,
    homeDir,
    targetHooksDir,
    restoredPrevious: Boolean(previousStatusLine),
    removedCount
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log('Usage: node uninstall.mjs [--home <dir>] [--dry-run] [--quiet]');
      process.exit(0);
    }
    const res = uninstallTakoAgyBar(opts);
    if (opts.dryRun) {
      console.log(JSON.stringify(res, null, 2));
    }
  } catch (err) {
    console.error(`[Tako AGY Bar] Uninstall failed: ${err.message}`);
    process.exit(1);
  }
}
