import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import os from 'os';

import { DEFAULT_COMPACTION_THRESHOLD } from './lib/core/constants.mjs';
import {
  calculateContextUsageAsync,
  extractModelCandidateKeys,
  resolveCatalogEntry,
  resolveConversationCtxCachePath
} from './lib/collectors/context.mjs';
import {
  mergeQuotaBuckets,
  parseMetaQuota,
  resolveModelQuota,
  resolveQuotaPool,
  resolveWeeklyQuota,
  triggerQuotaUpdateIfNeededAsync
} from './lib/collectors/quota.mjs';
import { formatResetTime } from './lib/collectors/time-format.mjs';
import { isDirectExecution, readJsonSafeAsync, writeFileAndVerifyNoBOM } from './lib/core/fs-utils.mjs';
import { formatTokens, sanitizeConversationId } from './lib/core/normalize.mjs';
import { getSettingsAsync, readStdin } from './lib/core/settings.mjs';
import { manageAccountMetaCacheAsync } from './lib/collectors/account.mjs';
import {
  BLUE,
  BOLD,
  GRAY,
  RESET,
  WHITE,
  getDisplayWidth,
  stripAnsi
} from './lib/renderers/ansi.mjs';

const PARTIAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const TRACK_BG = '\x1b[48;2;108;108;109m';

export function renderPlainBar(pct, length = 10, color = '') {
  const len = Math.min(50, Math.max(1, parseInt(length, 10) || 10));
  const numPct = typeof pct === 'number' ? pct : parseFloat(pct);
  const clamped = Math.max(0, Math.min(100, typeof numPct === 'number' && !isNaN(numPct) ? numPct : 0));
  const totalEighths = Math.round((clamped / 100) * len * 8);
  const full = Math.floor(totalEighths / 8);
  const rem = totalEighths % 8;
  const empty = len - full - (rem > 0 ? 1 : 0);

  const filledStr = '█'.repeat(full);
  const partialChar = rem > 0 ? PARTIAL_BLOCKS[rem] : '';
  const emptyStr = '░'.repeat(empty);
  if (!color) {
    return `${filledStr}${partialChar}${emptyStr}`;
  }
  const filledPart = filledStr ? `${color}${filledStr}${RESET}` : '';
  const partialPart = partialChar ? `${color}${TRACK_BG}${partialChar}${RESET}` : '';
  return `${filledPart}${partialPart}${emptyStr}`;
}

export function formatCompactFraction(used, max) {
  const uStr = formatTokens(used);
  const mStr = formatTokens(max);
  if ((uStr.endsWith('k') && mStr.endsWith('k')) || (uStr.endsWith('M') && mStr.endsWith('M'))) {
    return `${uStr.slice(0, -1)}/${mStr}`;
  }
  return `${uStr}/${mStr}`;
}

export function formatCompactCountdown(info) {
  const raw = (info?.reset_time ? formatResetTime(info.reset_time) : '') || info?.refreshes_in || '';
  const compact = String(raw || '').replace(/\s+/g, '');
  return compact || '--';
}

export function resolveRightAlignWidth(meta, cachedAccount = {}) {
  const metaW = typeof meta?.terminal_width === 'number' && meta.terminal_width > 0 ? meta.terminal_width : 0;
  if (metaW > 0) return Math.max(40, Math.floor(metaW));
  const cachedW = typeof cachedAccount?.terminalWidth === 'number' && cachedAccount.terminalWidth > 0 ? cachedAccount.terminalWidth : 0;
  if (cachedW > 0) return Math.max(40, Math.floor(cachedW));
  const stdoutCols = typeof process.stdout?.columns === 'number' && process.stdout.columns > 0 ? process.stdout.columns : 120;
  return Math.max(40, Math.floor(stdoutCols));
}

export function alignRight(text, width) {
  const plainWidth = getDisplayWidth(stripAnsi(text));
  const pad = Math.max(0, width - plainWidth);
  return `${' '.repeat(pad)}${text}`;
}

export function resolveCacheHitRate(meta, cachedCtx = null) {
  const cu = meta?.context_window?.current_usage;
  if (cu && typeof cu === 'object') {
    const uncachedIn = Math.max(0, Number(cu.input_tokens || 0) || 0);
    const cacheCreate = Math.max(0, Number(cu.cache_creation_input_tokens || 0) || 0);
    const cacheRead = Math.max(0, Number(cu.cache_read_input_tokens || 0) || 0);
    const denom = uncachedIn + cacheCreate + cacheRead;
    if (denom > 0) {
      return {
        pct: Math.min(100, Math.max(0, (cacheRead / denom) * 100)),
        fresh: true,
        cacheRead,
        uncachedIn,
        cacheCreate
      };
    }
  }
  if (cachedCtx && typeof cachedCtx.cache_hit_pct === 'number' && !isNaN(cachedCtx.cache_hit_pct)) {
    return {
      pct: Math.min(100, Math.max(0, cachedCtx.cache_hit_pct)),
      fresh: false,
      cacheRead: Number(cachedCtx.cache_read_input_tokens || 0) || 0,
      uncachedIn: Number(cachedCtx.current_input_tokens || 0) || 0,
      cacheCreate: Number(cachedCtx.cache_creation_input_tokens || 0) || 0
    };
  }
  return { pct: null, fresh: false, cacheRead: 0, uncachedIn: 0, cacheCreate: 0 };
}

const GRADIENT_STOPS = {
  green: [92, 219, 109],
  yellow: [255, 212, 39],
  red: [255, 85, 85]
};

export function getGradientColor(pct, minPct = 0, maxPct = 100) {
  const num = typeof pct === 'number' ? pct : parseFloat(pct);
  if (typeof num !== 'number' || isNaN(num)) return WHITE;
  const span = maxPct - minPct;
  const t = span > 0 ? Math.max(0, Math.min(1, (num - minPct) / span)) : 0;
  let r, g, b;
  if (t >= 0.5) {
    const u = (t - 0.5) / 0.5;
    r = Math.round(GRADIENT_STOPS.yellow[0] + (GRADIENT_STOPS.green[0] - GRADIENT_STOPS.yellow[0]) * u);
    g = Math.round(GRADIENT_STOPS.yellow[1] + (GRADIENT_STOPS.green[1] - GRADIENT_STOPS.yellow[1]) * u);
    b = Math.round(GRADIENT_STOPS.yellow[2] + (GRADIENT_STOPS.green[2] - GRADIENT_STOPS.yellow[2]) * u);
  } else {
    const u = t / 0.5;
    r = Math.round(GRADIENT_STOPS.red[0] + (GRADIENT_STOPS.yellow[0] - GRADIENT_STOPS.red[0]) * u);
    g = Math.round(GRADIENT_STOPS.red[1] + (GRADIENT_STOPS.yellow[1] - GRADIENT_STOPS.red[1]) * u);
    b = Math.round(GRADIENT_STOPS.red[2] + (GRADIENT_STOPS.yellow[2] - GRADIENT_STOPS.red[2]) * u);
  }
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function formatCompactTwoLineOutput({
  cacheHitPct = null,
  contextInfo,
  quotaInfo,
  weeklyInfo,
  barLength = 10,
  terminalWidth = 120
}) {
  const usedPctNum = Number(contextInfo?.usedPctNum || 0);
  const effectiveTokenMax = (contextInfo?.effectiveTokenCeiling && contextInfo.effectiveTokenCeiling > 0)
    ? contextInfo.effectiveTokenCeiling
    : (contextInfo?.contextSize && contextInfo.contextSize > 0
        ? Math.min(contextInfo.contextSize, DEFAULT_COMPACTION_THRESHOLD)
        : DEFAULT_COMPACTION_THRESHOLD);
  const totalInput = Number(contextInfo?.totalInput || 0);
  const rawTokenPct = effectiveTokenMax > 0 ? (totalInput / effectiveTokenMax) * 100 : usedPctNum;
  const tokenPct = Math.min(100, Math.max(0, rawTokenPct));
  // 按 Antigravity CLI 实际软限制统一计算百分比、进度条填充长度与渐变着色
  const contextColor = getGradientColor(Math.max(0, 100 - tokenPct), 0, 100);
  const tokenColor = contextColor;
  const usedPctStr = `${tokenPct.toFixed(1)}%`;
  const contextBar = renderPlainBar(tokenPct, barLength, contextColor);
  const fraction = formatCompactFraction(totalInput, effectiveTokenMax);
  const slashIdx = fraction.indexOf('/');
  const usedPart = slashIdx === -1 ? fraction : fraction.slice(0, slashIdx);
  const maxPart = slashIdx === -1 ? '' : fraction.slice(slashIdx + 1);
  const tokenPart = maxPart
    ? `${tokenColor}${usedPart}${RESET}/${maxPart}`
    : `${tokenColor}${fraction}${RESET}`;

  const quotaPct = Number(quotaInfo?.remaining_percentage ?? 100);
  const quotaColor = getGradientColor(quotaPct, 0, 100);
  const quotaPctStr = `${Math.round(quotaPct)}%`;
  const quotaBar = renderPlainBar(quotaPct, barLength, quotaColor);
  const quotaCountdown = formatCompactCountdown(quotaInfo);

  const weeklyPct = Number(weeklyInfo?.remaining_percentage ?? 100);
  const weeklyColor = getGradientColor(weeklyPct, 0, 100);
  const weeklyPctStr = `${Math.round(weeklyPct)}%`;
  const weeklyBar = renderPlainBar(weeklyPct, barLength, weeklyColor);
  const weeklyCountdown = formatCompactCountdown(weeklyInfo);

  const sep = ` ${GRAY}|${RESET} `;
  const cachePart = (typeof cacheHitPct === 'number' && !isNaN(cacheHitPct))
    ? `${WHITE}Cached${RESET} ${getGradientColor(cacheHitPct, 80, 100)}${BOLD}${cacheHitPct.toFixed(1)}%${RESET}`
    : `${WHITE}Cached${RESET} ${GRAY}--${RESET}`;
  const line1 = `${cachePart}${sep}${WHITE}Context${RESET} ${contextColor}${BOLD}${usedPctStr}${RESET} ${contextBar} ${tokenPart}`;
  const line2 = `${WHITE}Five Hours${RESET} ${quotaColor}${BOLD}${quotaPctStr}${RESET} ${quotaBar} ${BLUE}${BOLD}${quotaCountdown}${RESET}${sep}${WHITE}Weekly${RESET} ${weeklyColor}${BOLD}${weeklyPctStr}${RESET} ${weeklyBar} ${BLUE}${BOLD}${weeklyCountdown}${RESET}`;
  return ['', alignRight(line1, terminalWidth), '', alignRight(line2, terminalWidth)].join('\n');
}

async function main() {
  if (process.env.DISABLE_QUOTA_HOOK) process.exit(0);
  let meta = {};

  try {
    const stdinStr = await readStdin();
    try {
      if (stdinStr.trim()) meta = JSON.parse(stdinStr.replace(/^\uFEFF/, ''));
    } catch (_) {}

    const [settings, cachedAccount] = await Promise.all([
      getSettingsAsync(meta),
      manageAccountMetaCacheAsync(meta, { allowCliLogScan: false })
    ]);

    let fallbackModel = 'Gemini 4 Hydrogen (XHigh)';
    if (meta?.model?.display_name) fallbackModel = meta.model.display_name;
    else if (meta?.model?.id) fallbackModel = meta.model.id;

    const rawConversationId = sanitizeConversationId(meta?.conversation_id);
    const conversationId = (rawConversationId && rawConversationId !== 'default') ? rawConversationId : '';
    const cachePath = join(os.homedir(), '.gemini', 'tmp', 'real_quota_cache.json');
    let cache = await readJsonSafeAsync(cachePath);

    const activePool = resolveQuotaPool(fallbackModel, cache, meta);
    const metaQuota = parseMetaQuota(meta);
    const hasMetaShortTerm = activePool
      ? Boolean(metaQuota?.shortTerm?.[activePool])
      : Boolean(metaQuota?.shortTerm && Object.keys(metaQuota.shortTerm).length > 0);
    const hasMetaWeekly = activePool
      ? Boolean(metaQuota?.weekly?.[activePool])
      : Boolean(metaQuota?.weekly && Object.keys(metaQuota.weekly).some(k => !k.toLowerCase().includes('argon')));
    const isMetaQuotaComplete = Boolean(metaQuota && hasMetaShortTerm && hasMetaWeekly);

    const hasCacheShortTerm = Boolean(
      (activePool && cache?.shortTerm?.[activePool]) ||
      (cache?.shortTerm && Object.keys(cache.shortTerm).length > 0) ||
      (cache?.models && typeof cache.models === 'object' && Object.keys(cache.models).length > 0)
    );
    const missingRequiredBuckets = !hasMetaShortTerm && !hasCacheShortTerm;

    const currentModelKeys = extractModelCandidateKeys(meta, fallbackModel);
    const primaryModelKey = currentModelKeys[0] || '';
    const catalogEntry = resolveCatalogEntry(currentModelKeys, cache?.modelLimits);
    const hasCatalogCeiling = Boolean(catalogEntry && typeof catalogEntry.limit === 'number' && catalogEntry.limit > 0);

    const now = Date.now();
    const modelJustChanged = Boolean(primaryModelKey && cache?.lastModelKey && cache.lastModelKey !== primaryModelKey);
    const modelLimitAttemptAgeMs = now - (cache?.lastModelLimitAttemptAt || cache?.lastPollAttemptAt || 0);
    const missingModelLimits = Boolean(
      currentModelKeys.length > 0 &&
      !hasCatalogCeiling &&
      (modelJustChanged || !cache?.modelLimitsUpdatedAt || modelLimitAttemptAgeMs >= 15000)
    );

    const currentState = typeof meta?.agent_state === 'string' ? meta.agent_state.trim().toLowerCase() : '';
    const prevState = typeof cache?.lastAgentState === 'string' ? cache.lastAgentState.trim().toLowerCase() : '';
    const currentOutputTokens = Number(meta?.context_window?.total_output_tokens || 0);
    const currentInputTokens = Number(meta?.context_window?.total_input_tokens || 0);
    const currentTotalTokens = currentInputTokens + currentOutputTokens;
    const prevOutputTokens = Number(cache?.lastOutputTokens || 0);
    const prevTotalTokens = Number(cache?.lastTotalTokens || 0);
    const stateOrTokensChanged =
      (currentState === 'idle' && prevState !== '' && prevState !== 'idle') ||
      (currentOutputTokens > 0 && currentOutputTokens !== prevOutputTokens) ||
      (currentTotalTokens > 0 && currentTotalTokens !== prevTotalTokens);

    const lastUpdatedAt = cache?.lsUpdatedAt || cache?.updatedAt || 0;
    const cacheAgeMs = now - lastUpdatedAt;
    const lastAttemptAgeMs = now - (cache?.lastPollAttemptAt || 0);
    const isCacheStale = (!cache || !lastUpdatedAt || cacheAgeMs >= 15000) && (!lastUpdatedAt || lastAttemptAgeMs >= 15000);

    const isBucketExpired = (entry) => {
      if (!entry || typeof entry !== 'object' || !entry.reset_time) return false;
      const resetMs = new Date(entry.reset_time).getTime();
      return !isNaN(resetMs) && resetMs > 0 && resetMs <= now;
    };
    const hasFutureReset = (entry) => {
      if (!entry || typeof entry !== 'object' || !entry.reset_time) return false;
      const resetMs = new Date(entry.reset_time).getTime();
      return !isNaN(resetMs) && resetMs > now;
    };
    const activeShortBucket = (activePool && cache?.shortTerm?.[activePool])
      ? cache.shortTerm[activePool]
      : (primaryModelKey ? cache?.models?.[primaryModelKey] : null);
    const activeWeeklyBucket = activePool ? cache?.weekly?.[activePool] : null;
    const metaShortBucket = activePool ? metaQuota?.shortTerm?.[activePool] : null;
    const metaWeeklyBucket = activePool ? metaQuota?.weekly?.[activePool] : null;
    const hasExpiredActiveQuota = Boolean(
      (isBucketExpired(activeShortBucket) && !hasFutureReset(metaShortBucket)) ||
      (isBucketExpired(activeWeeklyBucket) && !hasFutureReset(metaWeeklyBucket))
    );

    const prevPollAttemptAt = cache?.lastPollAttemptAt || 0;
    let freshlyFetchedFromLs = false;
    let timedOut = false;
    let shouldPersistCache = false;

    if (!isMetaQuotaComplete || stateOrTokensChanged || isCacheStale || hasExpiredActiveQuota || missingModelLimits) {
      const updateRes = await triggerQuotaUpdateIfNeededAsync(cache, meta, {
        cachePath,
        missingRequiredBuckets: missingRequiredBuckets || missingModelLimits,
        hasExpiredQuota: hasExpiredActiveQuota,
        conversationId
      });
      cache = updateRes.cache;
      freshlyFetchedFromLs = updateRes.freshlyFetchedFromLs;
      timedOut = updateRes.timedOut;
      if (cache && typeof cache === 'object' && cache.lastPollAttemptAt && cache.lastPollAttemptAt !== prevPollAttemptAt) {
        shouldPersistCache = true;
      }
    }

    if (metaQuota) {
      if (!cache || typeof cache !== 'object') cache = {};
      cache.shortTerm = mergeQuotaBuckets(cache.shortTerm, metaQuota.shortTerm, true);
      cache.weekly = mergeQuotaBuckets(cache.weekly, metaQuota.weekly, true);
      if (freshlyFetchedFromLs || !cache.updatedAt) cache.updatedAt = Date.now();
      shouldPersistCache = true;
    }

    if (cache && typeof cache === 'object') {
      if (currentState && cache.lastAgentState !== currentState) {
        cache.lastAgentState = currentState;
        shouldPersistCache = true;
      }
      if (currentOutputTokens > 0 && cache.lastOutputTokens !== currentOutputTokens) {
        cache.lastOutputTokens = currentOutputTokens;
        shouldPersistCache = true;
      }
      if (currentTotalTokens > 0 && cache.lastTotalTokens !== currentTotalTokens) {
        cache.lastTotalTokens = currentTotalTokens;
        shouldPersistCache = true;
      }
      if (primaryModelKey && cache.lastModelKey !== primaryModelKey) {
        cache.lastModelKey = primaryModelKey;
        shouldPersistCache = true;
      }
      if (missingModelLimits && !freshlyFetchedFromLs) {
        cache.lastModelLimitAttemptAt = now;
        shouldPersistCache = true;
      }
      if (shouldPersistCache && !timedOut) {
        try {
          await writeFileAndVerifyNoBOM(cachePath, JSON.stringify(cache, null, 2));
        } catch (_) {}
      }
    }

    const quotaInfo = resolveModelQuota(fallbackModel, cache, meta);
    const weeklyInfo = resolveWeeklyQuota(fallbackModel, cache, meta);
    const contextInfo = await calculateContextUsageAsync(meta, conversationId, settings, cache);
    const ctxCachePath = resolveConversationCtxCachePath(conversationId);
    const latestCtx = ctxCachePath ? await readJsonSafeAsync(ctxCachePath) : null;
    const cacheHitRes = resolveCacheHitRate(meta, latestCtx);
    if (
      ctxCachePath &&
      cacheHitRes.fresh &&
      (latestCtx?.cache_hit_pct !== cacheHitRes.pct || latestCtx?.cache_read_input_tokens !== cacheHitRes.cacheRead)
    ) {
      try {
        await fs.mkdir(dirname(ctxCachePath), { recursive: true });
        await writeFileAndVerifyNoBOM(
          ctxCachePath,
          JSON.stringify({
            ...(latestCtx || {}),
            cache_hit_pct: cacheHitRes.pct,
            cache_read_input_tokens: cacheHitRes.cacheRead,
            current_input_tokens: cacheHitRes.uncachedIn,
            cache_creation_input_tokens: cacheHitRes.cacheCreate
          })
        );
      } catch (_) {}
    }

    const barLength = settings?.ui?.footer?.barLength || settings?.ui?.barLength || 10;
    const terminalWidth = resolveRightAlignWidth(meta, cachedAccount);

    console.log(formatCompactTwoLineOutput({
      cacheHitPct: cacheHitRes.pct,
      contextInfo,
      quotaInfo,
      weeklyInfo,
      barLength,
      terminalWidth
    }));
  } catch (err) {
    try {
      const projectLogDir = join(process.cwd(), '.gemini');
      await fs.access(projectLogDir);
      await fs.writeFile(
        join(projectLogDir, 'hook_error.log'),
        `[${new Date().toISOString()}] ${err.stack || err.message}\n`,
        { encoding: 'utf8', flag: 'a' }
      );
    } catch (_) {}
    const terminalWidth = resolveRightAlignWidth(meta);
    console.log(alignRight(`${WHITE}Cached${RESET} ${GRAY}--${RESET} ${GRAY}|${RESET} ${WHITE}Context${RESET} ${GRAY}--${RESET}`, terminalWidth));
  }
  process.exit(0);
}

if (isDirectExecution(import.meta.url, { treatEmptyArgv1AsDirect: true })) {
  main();
}
