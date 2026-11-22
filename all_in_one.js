'use strict';

/**
 * @fileoverview taixiu-ai-v10.js — Hệ thống dự đoán Tài Xỉu AI (FULL - KHÔNG DEMO)
 * @description
 *   - KHÔNG có demo/CLI giả lập
 *   - Server chạy thật, kết nối workers thật
 *   - HỌC CẦU: nếu dự đoán sai (Tài↔Xỉu) → ghi nhớ cầu đó → phiên sau gặp lại cầu y hệt → ĐẢO NGƯỢC
 *   - Đọc/ghi đồng bộ: pattern_10.json, history_dudoan.json, learning_history.json
 *   - Giữ nguyên JSON schema response: { phien, ketQua, tong, phienDoan, duDoan, tiLe }
 *
 * @author   @tranhoang2286
 * @version  10.0.0
 */

// ═══════════════════════════════════════════════════════════
// MODULE IMPORTS
// ═══════════════════════════════════════════════════════════
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const http = require('http');

function loadMod(name) {
  try { return require(name); }
  catch (_) {
    console.error(`[BOOT] Thiếu "${name}". Chạy: npm install express axios ws`);
    process.exit(1);
  }
}

const express   = loadMod('express');
const axios     = loadMod('axios');
const WebSocket = loadMod('ws');

// ═══════════════════════════════════════════════════════════
// CẤU HÌNH
// ═══════════════════════════════════════════════════════════
const PORT        = Number(process.env.PORT) || 8080;
const HOST        = process.env.HOST || '0.0.0.0';
const MAX_HISTORY = 200;

function resolveDataDir() {
  const candidates = [process.cwd(), __dirname, os.tmpdir()];
  for (const base of candidates) {
    try {
      const dir = path.join(base, 'data_store');
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.probe_${process.pid}`);
      fs.writeFileSync(tmp, 'ok'); fs.unlinkSync(tmp);
      return dir;
    } catch (_) {}
  }
  return os.tmpdir();
}

const DATA_DIR            = resolveDataDir();
const PATTERN_10_FILE     = path.join(DATA_DIR, 'pattern_10.json');
const HISTORY_DUDOAN_FILE = path.join(DATA_DIR, 'history_dudoan.json');
const LEARNING_FILE       = path.join(DATA_DIR, 'learning_history.json');
const CAU_MEMORY_FILE     = path.join(DATA_DIR, 'cau_memory.json'); // 🆕 học cầu

// ═══════════════════════════════════════════════════════════
// TIỆN ÍCH
// ═══════════════════════════════════════════════════════════
const log      = msg => console.log(`[${new Date().toISOString()}] ${msg}`);
const logError = (msg, err) => console.error(`[${new Date().toISOString()}] [ERR] ${msg}`, err?.message ?? err ?? '');

function loadJson(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) {}
  return fallback;
}

function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { logError('[saveJson]', e); }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ═══════════════════════════════════════════════════════════
// THAM SỐ ANTI-LOSS
// ═══════════════════════════════════════════════════════════
const ANTI_LOSS = Object.freeze({
  MAX_CONSECUTIVE_LOSS : 2,
  FORCE_REVERSE_AT     : 2,
  MIN_CONFIDENCE       : 55,
  MAX_CONFIDENCE       : 92,
  HARD_STOP_AT         : 2,
});

const ANTI_LOSS_V2 = Object.freeze({
  ENABLED              : true,
  CONFIDENCE_FLOOR_BY_LOSS : { 0: 55, 1: 65, 2: 75, 3: 82, 4: 88 },
  CROSS_CHECK_PENALTY  : 12,
  CONFLICT_BALANCE_THRESHOLD: 0.05,
  CAU_MAX_LENGTH       : 8,
});

// ═══════════════════════════════════════════════════════════
// 🆕 CẦU MEMORY — HỌC CẦU SAI
// Cấu trúc: { [signature]: { type, length, predict, correct, wrong, lastUpdated } }
// signature = hash của N kết quả gần nhất + loại cầu
// ═══════════════════════════════════════════════════════════
let CAU_MEMORY = loadJson(CAU_MEMORY_FILE, {});

/**
 * Tạo signature từ mảng kết quả (mới nhất đầu) + loại cầu
 * @param {string[]} results
 * @param {string}   type
 * @returns {string}
 */
function makeCauSignature(results, type) {
  const window = results.slice(0, 6).map(r => r === 'Tài' ? 'T' : 'X').join('');
  return `${type}:${window}`;
}

/**
 * Ghi nhận kết quả của 1 cầu đã dự đoán (đúng/sai)
 * @param {string} signature
 * @param {string} predicted
 * @param {string} actual
 * @param {Object} cauInfo
 */
function learnCau(signature, predicted, actual, cauInfo) {
  if (!signature) return;
  if (!CAU_MEMORY[signature]) {
    CAU_MEMORY[signature] = {
      type: cauInfo?.type || 'unknown',
      name: cauInfo?.name || '',
      correct: 0, wrong: 0, lastUpdated: Date.now(),
      lastPredicted: null, lastActual: null,
    };
  }
  const m = CAU_MEMORY[signature];
  if (predicted === actual) m.correct++;
  else m.wrong++;
  m.lastPredicted = predicted;
  m.lastActual    = actual;
  m.lastUpdated   = Date.now();

  // Giới hạn kích thước
  const keys = Object.keys(CAU_MEMORY);
  if (keys.length > 500) {
    const sorted = keys.sort((a, b) => (CAU_MEMORY[a].lastUpdated || 0) - (CAU_MEMORY[b].lastUpdated || 0));
    for (let i = 0; i < 100; i++) delete CAU_MEMORY[sorted[i]];
  }
  saveJson(CAU_MEMORY_FILE, CAU_MEMORY);
}

/**
 * 🎯 CHECK CẦU TỪ MEMORY: nếu signature này đã từng SAI >= 1 lần
 *    và lần gần nhất SAI → ĐẢO chiều dự đoán
 * @param {string} signature
 * @returns {{ shouldReverse: boolean, reverseTo: string|null, reason: string, stats: Object|null }}
 */
function checkCauMemory(signature) {
  const m = CAU_MEMORY[signature];
  if (!m) return { shouldReverse: false, reverseTo: null, reason: 'Chưa có trong memory', stats: null };

  const total = m.correct + m.wrong;
  const winRate = total > 0 ? m.correct / total : 0;

  // Nếu lần gần nhất của cầu này dự đoán SAI → đảo chiều
  if (m.lastPredicted && m.lastActual && m.lastPredicted !== m.lastActual) {
    const reverseTo = m.lastPredicted === 'Tài' ? 'Xỉu' : 'Tài';
    return {
      shouldReverse: true,
      reverseTo,
      reason: `Cầu ${m.type} lần trước SAI (đoán ${m.lastPredicted}, ra ${m.lastActual}) → ĐẢO sang ${reverseTo}`,
      stats: { total, correct: m.correct, wrong: m.wrong, winRate: (winRate * 100).toFixed(1) },
    };
  }

  // Nếu tỉ lệ thắng < 40% qua >= 3 lần → đảo
  if (total >= 3 && winRate < 0.4) {
    const reverseTo = m.lastPredicted === 'Tài' ? 'Xỉu' : 'Tài';
    return {
      shouldReverse: true,
      reverseTo,
      reason: `Cầu ${m.type} winRate thấp ${(winRate * 100).toFixed(1)}% → ĐẢO`,
      stats: { total, correct: m.correct, wrong: m.wrong, winRate: (winRate * 100).toFixed(1) },
    };
  }

  return {
    shouldReverse: false,
    reverseTo: null,
    reason: `Cầu ${m.type} winRate ${(winRate * 100).toFixed(1)}% (${m.correct}/${total}) → giữ nguyên`,
    stats: { total, correct: m.correct, wrong: m.wrong, winRate: (winRate * 100).toFixed(1) },
  };
}

// ═══════════════════════════════════════════════════════════
// DAILY TRACKER
// ═══════════════════════════════════════════════════════════
const DAILY_TRACKER = { date: new Date().toDateString(), totalLoss: 0, totalWin: 0 };

function checkDailyReset() {
  const today = new Date().toDateString();
  if (DAILY_TRACKER.date !== today) {
    DAILY_TRACKER.date = today;
    DAILY_TRACKER.totalLoss = 0;
    DAILY_TRACKER.totalWin  = 0;
  }
}

function updateDailyTracker(isCorrect) {
  checkDailyReset();
  if (isCorrect) DAILY_TRACKER.totalWin++; else DAILY_TRACKER.totalLoss++;
}

// ═══════════════════════════════════════════════════════════
// DATA STORE
// ═══════════════════════════════════════════════════════════
const GAME_STATUS = {
  '68gb': true, '789club': true, 'b52': true, 'betvip': true,
  'hitclub': true, 'lc79': true, 'luck8': true, 'rikvip': true,
  'sumclub': true, 'sunwin': true,
};

const DATA_STORE = {
  '68gb'  : { hu: [], md5: [] },
  '789club': { live: [], minigame: [] },
  'b52'   : { hu: [], md5: [] },
  'betvip': { hu: [], md5: [] },
  'hitclub': { hu: [], md5: [] },
  'lc79'  : { hu: [], md5: [] },
  'luck8' : { txhu: [], txmd5: [], tx3p: [] },
  'rikvip': { hu: [], md5: [] },
  'sumclub': { hu: [], md5: [] },
  'sunwin': { main: [] },
};

// ═══════════════════════════════════════════════════════════
// PERSISTENT STORES
// ═══════════════════════════════════════════════════════════
let PATTERN_10_STORE     = loadJson(PATTERN_10_FILE,     { pattern_10: [] });
let HISTORY_DUDOAN_STORE = loadJson(HISTORY_DUDOAN_FILE, []);
let LEARNING_STORE       = loadJson(LEARNING_FILE,       []);

// ═══════════════════════════════════════════════════════════
// ANTI-LOSS STATE
// ═══════════════════════════════════════════════════════════
const ANTI_LOSS_STATE = new Map();

function getAntiLossState(key) {
  if (!ANTI_LOSS_STATE.has(key)) {
    ANTI_LOSS_STATE.set(key, {
      consecutiveLoss: 0, consecutiveWin: 0,
      forceReverseCooldown: 0, forceReverseCount: 0,
      recentResults: [],
      lastPrediction: null, lastActual: null,
      hardStopActive: false, hardStopCooldown: 0,
      hardStopConfirmWinsNeeded: 0,
      recoveryMode: false, recoveryWins: 0,
      lastPhien: null, lastCauType: null, cauBreakCount: 0,
      lastCauSignature: null,  // 🆕
      pendingSignature: null,  // 🆕 chờ verify
    });
  }
  return ANTI_LOSS_STATE.get(key);
}

function ensureV2Fields(s) {
  if (s.hardStopCooldown == null)          s.hardStopCooldown = 0;
  if (s.hardStopConfirmWinsNeeded == null) s.hardStopConfirmWinsNeeded = 0;
  if (s.recoveryMode == null)              s.recoveryMode = false;
  if (s.recoveryWins == null)              s.recoveryWins = 0;
  if (s.lastCauType == null)               s.lastCauType = null;
  if (s.cauBreakCount == null)             s.cauBreakCount = 0;
  if (s.lastCauSignature == null)          s.lastCauSignature = null;
  if (s.pendingSignature == null)          s.pendingSignature = null;
}

function updateAntiLossState(key, predicted, actual, phien) {
  const s = getAntiLossState(key);
  ensureV2Fields(s);
  const isCorrect = (predicted === actual);

  s.recentResults.push(isCorrect);
  if (s.recentResults.length > 30) s.recentResults.shift();
  s.lastPhien = phien;

  // 🆕 HỌC CẦU: nếu có pendingSignature thì học
  if (s.pendingSignature) {
    learnCau(s.pendingSignature, predicted, actual, s.lastCauType);
    log(`[LEARN] 📚 Cầu ${s.pendingSignature} | ${predicted}→${actual} | ${isCorrect ? 'ĐÚNG' : 'SAI'}`);
    s.pendingSignature = null;
  }

  if (isCorrect) {
    s.consecutiveLoss = 0; s.consecutiveWin++;
    s.hardStopActive = false;
    s.forceReverseCooldown = Math.max(0, s.forceReverseCooldown - 1);
    if (s.recoveryMode) {
      s.recoveryWins++;
      if (s.recoveryWins >= s.hardStopConfirmWinsNeeded) {
        s.recoveryMode = false; s.recoveryWins = 0;
        log(`[V2] ✅ RECOVERY OK ${key}`);
      }
    }
  } else {
    s.consecutiveWin = 0; s.consecutiveLoss++;
    if (s.consecutiveLoss >= ANTI_LOSS.HARD_STOP_AT) {
      s.hardStopActive = true;
      s.hardStopCooldown = 3;
      s.hardStopConfirmWinsNeeded = 2;
      log(`[V2] 🛑 HARD STOP ${key}`);
    }
  }

  s.lastPrediction = predicted; s.lastActual = actual;
  updateDailyTracker(isCorrect);
  return isCorrect;
}

// ═══════════════════════════════════════════════════════════
// HELPERS GAME
// ═══════════════════════════════════════════════════════════
function getTaiXiu(d1, d2, d3) { return (d1 + d2 + d3) <= 10 ? 'Xỉu' : 'Tài'; }

function addRecord(game, table, record) {
  if (!DATA_STORE[game]?.[table]) return;
  const arr = DATA_STORE[game][table];
  const idx = arr.findIndex(r => String(r.phien) === String(record.phien));
  if (idx !== -1) arr[idx] = record;
  else arr.unshift(record);
  if (arr.length > MAX_HISTORY) arr.pop();
}

// ═══════════════════════════════════════════════════════════
// PATTERN_10 & HISTORY
// ═══════════════════════════════════════════════════════════
function updatePattern10(ketQua) {
  const code = ketQua === 'Tài' ? 'T' : ketQua === 'Xỉu' ? 'X' : null;
  if (!code) return;
  PATTERN_10_STORE.pattern_10.unshift(code);
  if (PATTERN_10_STORE.pattern_10.length > 10) PATTERN_10_STORE.pattern_10.length = 10;
  saveJson(PATTERN_10_FILE, PATTERN_10_STORE);
}

function recordPredictionHistory(gameKey, phienTruoc, result, phienNay, duDoan, doTinCay) {
  try {
    const norm  = s => (s === 'Tài' || s === 'T') ? 'Tài' : (s === 'Xỉu' || s === 'X') ? 'Xỉu' : String(s);
    const r = norm(result), d = norm(duDoan);
    const rec = {
      game: gameKey, phien_truoc: phienTruoc, result: r,
      Phien_nay: phienNay, Du_doan: d, Do_tin_cay: doTinCay,
      Trang_thai: r === d ? 'AUDU LAI BU✅' : 'DITMEMAY LAI GAY',
      timestamp: new Date().toISOString(),
    };
    HISTORY_DUDOAN_STORE.unshift(rec);
    if (HISTORY_DUDOAN_STORE.length > 1000) HISTORY_DUDOAN_STORE.length = 1000;
    saveJson(HISTORY_DUDOAN_FILE, HISTORY_DUDOAN_STORE);

    LEARNING_STORE.unshift(rec);
    if (LEARNING_STORE.length > 5000) LEARNING_STORE.length = 5000;
    saveJson(LEARNING_FILE, LEARNING_STORE);
  } catch (e) { logError('[recordPredictionHistory]', e); }
}

// ═══════════════════════════════════════════════════════════
// CẦU DETECTION
// ═══════════════════════════════════════════════════════════
function detectCauType(results) {
  if (!results || results.length < 4) {
    return { detected: false, type: null, length: 0, predict: null, confidence: 0, name: 'Chưa đủ data', patternId: null, shouldBreak: false, cauDirection: null };
  }
  const r = results, N = r.length;

  // Bệt
  let streak = 1;
  for (let i = 1; i < N; i++) { if (r[i] === r[0]) streak++; else break; }
  if (streak >= 6) {
    const pred = r[0] === 'Tài' ? 'Xỉu' : 'Tài';
    return { detected: true, type: 'cau_rong', length: streak, predict: pred,
      confidence: clamp(75 + streak, 55, 92), name: `Cầu Rồng ${streak} ${r[0]} → BẺ`,
      patternId: 'cau_rong', shouldBreak: true, cauDirection: pred };
  }
  if (streak >= 3 && streak <= ANTI_LOSS_V2.CAU_MAX_LENGTH) {
    const shouldBreak = streak >= 5;
    const pred = shouldBreak ? (r[0] === 'Tài' ? 'Xỉu' : 'Tài') : r[0];
    return { detected: true, type: 'bet', length: streak, predict: pred,
      confidence: shouldBreak ? clamp(65 + streak * 3, 55, 90) : clamp(62 + streak * 2, 55, 88),
      name: `Cầu Bệt ${streak} ${r[0]} ${shouldBreak ? '(BẺ)' : '(TIẾP)'}`,
      patternId: 'cau_bet', shouldBreak, cauDirection: pred };
  }

  // Đảo 1-1
  let alt = 1;
  for (let i = 1; i < N; i++) { if (r[i] !== r[i - 1]) alt++; else break; }
  if (alt >= 4 && alt <= ANTI_LOSS_V2.CAU_MAX_LENGTH) {
    const shouldBreak = alt >= 6;
    const pred = shouldBreak ? r[0] : (r[0] === 'Tài' ? 'Xỉu' : 'Tài');
    return { detected: true, type: 'dao11', length: alt, predict: pred,
      confidence: shouldBreak ? clamp(68 + alt * 2, 55, 88) : clamp(62 + alt * 2, 55, 82),
      name: `Cầu Đảo 1-1 ${alt} ${shouldBreak ? '(BẺ)' : '(TIẾP)'}`,
      patternId: 'cau_dao_11', shouldBreak, cauDirection: pred };
  }

  // 2-2
  if (N >= 6) {
    let pairs = 0, i = 0;
    while (i < N - 1 && pairs < 5) { if (r[i] === r[i + 1]) { pairs++; i += 2; } else break; }
    if (pairs >= 2) {
      const pred = r[0] === 'Tài' ? 'Xỉu' : 'Tài';
      return { detected: true, type: 'cau22', length: pairs, predict: pred,
        confidence: clamp(65 + pairs * 3, 55, 80),
        name: `Cầu 2-2 (${pairs} cặp)`, patternId: 'cau_22',
        shouldBreak: pairs >= 4, cauDirection: pred };
    }
  }

  // 3-3
  if (N >= 6) {
    let triples = 0, i = 0;
    while (i < N - 2 && triples < 4) {
      if (r[i] === r[i + 1] && r[i + 1] === r[i + 2]) { triples++; i += 3; } else break;
    }
    if (triples >= 1) {
      const pred = r[0] === 'Tài' ? 'Xỉu' : 'Tài';
      return { detected: true, type: 'cau33', length: triples, predict: pred,
        confidence: clamp(68 + triples * 4, 55, 82),
        name: `Cầu 3-3 (${triples} bộ)`, patternId: 'cau_33',
        shouldBreak: triples >= 3, cauDirection: pred };
    }
  }

  // 1-2-1
  if (N >= 4 && r[0] !== r[1] && r[1] === r[2] && r[2] !== r[3] && r[0] === r[3]) {
    return { detected: true, type: 'cau121', length: 4, predict: r[1],
      confidence: 72, name: 'Cầu 1-2-1', patternId: 'cau_121',
      shouldBreak: false, cauDirection: r[1] };
  }

  // 2-1-2
  if (N >= 5 && r[0] === r[1] && r[1] !== r[2] && r[2] !== r[3] && r[3] === r[4]) {
    return { detected: true, type: 'cau212', length: 5, predict: r[0],
      confidence: 73, name: 'Cầu 2-1-2', patternId: 'cau_212',
      shouldBreak: false, cauDirection: r[0] };
  }

  // 1-2-3
  if (N >= 6) {
    const p = r.slice(0, 6).reverse();
    if (p[0] !== p[1] && p[1] === p[2] && p[2] === p[3] && p[3] !== p[4] && p[4] === p[5]) {
      const pred = p[0] === 'Tài' ? 'Xỉu' : 'Tài';
      return { detected: true, type: 'cau123', length: 6, predict: pred,
        confidence: 74, name: 'Cầu 1-2-3', patternId: 'cau_123',
        shouldBreak: false, cauDirection: pred };
    }
  }

  // 3-2-1
  if (N >= 6) {
    const p = r.slice(0, 6).reverse();
    if (p[0] === p[1] && p[1] === p[2] && p[3] === p[4] && p[2] !== p[3] && p[4] !== p[5]) {
      const pred = p[2] === 'Tài' ? 'Xỉu' : 'Tài';
      return { detected: true, type: 'cau321', length: 6, predict: pred,
        confidence: 75, name: 'Cầu 3-2-1', patternId: 'cau_321',
        shouldBreak: false, cauDirection: pred };
    }
  }

  // Nhảy cóc
  if (N >= 6 && r[0] === r[2] && r[2] === r[4] && r[1] === r[3] && r[3] === r[5] && r[0] !== r[1]) {
    return { detected: true, type: 'cau_nhay_coc', length: 6, predict: r[4],
      confidence: 76, name: 'Cầu Nhảy Cóc', patternId: 'cau_nhay_coc',
      shouldBreak: false, cauDirection: r[4] };
  }

  return { detected: false, type: null, length: 0, predict: null, confidence: 0, name: 'Không có cầu', patternId: null, shouldBreak: false, cauDirection: null };
}

/**
 * 🎯 CHECK CẦU + BẺ CẦU + MEMORY
 */
function checkCauAndBreak(key, cauInfo, currentPrediction, results, state) {
  if (!cauInfo.detected) return { action: 'PASS', prediction: currentPrediction, reason: 'Không có cầu', cau: null, signature: null };
  ensureV2Fields(state);

  const signature = makeCauSignature(results, cauInfo.type);
  const memory = checkCauMemory(signature);

  let finalPred = currentPrediction;
  let reason = `Cầu ${cauInfo.type}: ${cauInfo.name}`;
  let reversed = false;

  // 🎯 ƯU TIÊN 1: memory đảo (học từ sai)
  if (memory.shouldReverse) {
    finalPred = memory.reverseTo;
    reason = memory.reason;
    reversed = true;
    log(`[CAU-MEM] 🔄 ${key} ${reason}`);
  }
  // ƯU TIÊN 2: cầu dài → bẻ
  else if (cauInfo.shouldBreak) {
    finalPred = cauInfo.cauDirection || (cauInfo.predict === 'Tài' ? 'Xỉu' : 'Tài');
    reason = `Cầu ${cauInfo.type} dài → BẺ: ${finalPred}`;
    reversed = true;
  }
  // ƯU TIÊN 3: theo cầu
  else {
    finalPred = cauInfo.predict;
  }

  state.lastCauType = { type: cauInfo.type, predicted: finalPred, detectedAt: Date.now() };
  state.pendingSignature = signature; // chờ verify để học

  return {
    action: 'BET', prediction: finalPred, reason, signature,
    cau: {
      type: cauInfo.type, length: cauInfo.length, name: cauInfo.name,
      cauPrediction: cauInfo.predict, shouldBreak: cauInfo.shouldBreak || false,
      breakCount: state.cauBreakCount || 0, reversed,
      signature, memoryStats: memory.stats, memoryReason: memory.reason,
    },
  };
}

// ═══════════════════════════════════════════════════════════
// PREDICTION ENGINE — CÁC LỚP PHÂN TÍCH
// ═══════════════════════════════════════════════════════════
function buildMarkovChain(results, maxOrder = 5) {
  const chain = Object.create(null);
  for (let order = 1; order <= maxOrder; order++) {
    for (let i = 0; i < results.length - order; i++) {
      const state = results.slice(i, i + order).join('');
      const next  = results[i + order];
      if (!chain[state]) chain[state] = { Tài: 0, Xỉu: 0, total: 0 };
      chain[state][next]++;
      chain[state].total++;
    }
  }
  return chain;
}

function predictMarkov(results, chain) {
  if (!results || results.length < 2) return { detected: false };
  for (let order = Math.min(5, results.length - 1); order >= 1; order--) {
    const state = results.slice(-order).join('');
    const c = chain[state];
    if (c && c.total >= 3) {
      const tCount = c['Tài'] || 0, xCount = c['Xỉu'] || 0;
      const prob = Math.max(tCount, xCount) / c.total;
      if (prob >= 0.55) {
        const pred = tCount >= xCount ? 'Tài' : 'Xỉu';
        return { detected: true, prediction: pred, confidence: Math.round(55 + prob * 35), name: `Markov ${order}`, patternId: 'markov_chain' };
      }
    }
  }
  return { detected: false };
}

function calcEntropy(results, windowSize = 20) {
  const w = results.slice(0, windowSize);
  if (w.length === 0) return 0;
  const nTai = w.filter(r => r === 'Tài').length;
  const p1 = nTai / w.length, p2 = 1 - p1;
  if (p1 <= 0 || p2 <= 0) return 0;
  return -(p1 * Math.log2(p1) + p2 * Math.log2(p2));
}

function analyzeEntropy(results) {
  if (results.length < 20) return { detected: false };
  const eNow = calcEntropy(results, 10), eBefore = calcEntropy(results.slice(10), 10);
  if (eNow < 0.7 && eBefore > 0.85) {
    const r5 = results.slice(0, 5);
    if (r5.filter(r => r === r5[0]).length >= 4) {
      return { detected: true, prediction: r5[0], confidence: Math.round(72 + (1 - eNow) * 15), name: `Entropy Thấp → ${r5[0]}`, patternId: 'entropy_signal' };
    }
  }
  if (eNow > 0.95 && eBefore < 0.75) {
    const r3 = results.slice(0, 3);
    const dom = r3.filter(r => r === r3[0]).length >= 2 ? r3[0] : null;
    if (dom) return { detected: true, prediction: dom === 'Tài' ? 'Xỉu' : 'Tài', confidence: 68, name: 'Entropy Tăng → Đảo', patternId: 'entropy_signal' };
  }
  return { detected: false };
}

function analyzeMomentum(data) {
  if (data.length < 15) return { detected: false };
  const sums    = data.slice(0, 15).map(d => d.Tong ?? d.tong ?? 10.5);
  const weights = sums.map((_, i) => 15 - i);
  const wmaTai  = sums.reduce((acc, s, i) => acc + (s > 10 ? weights[i] : 0), 0);
  const wmaXiu  = sums.reduce((acc, s, i) => acc + (s <= 10 ? weights[i] : 0), 0);
  const totalW  = weights.reduce((a, b) => a + b, 0);
  const diff    = Math.abs(wmaTai / totalW - wmaXiu / totalW);
  if (diff > 0.15) {
    const dom = wmaTai > wmaXiu ? 'Tài' : 'Xỉu';
    const r3  = data.slice(0, 3).map(d => d.Ket_qua ?? d.ket_qua);
    if (r3.filter(r => r === dom).length >= 2) {
      return { detected: true, prediction: dom, confidence: Math.round(66 + diff * 80), name: `Momentum → ${dom}`, patternId: 'momentum_adv' };
    }
  }
  return { detected: false };
}

function analyzeBayesian(results) {
  if (results.length < 15) return { detected: false };
  let logT = Math.log(0.5), logX = Math.log(0.5);
  const w = results.slice(0, 15);
  for (let i = 0; i < w.length; i++) {
    const sens = i < 5 ? 0.65 : i < 10 ? 0.58 : 0.53;
    logT += Math.log(w[i] === 'Tài' ? sens : 1 - sens);
    logX += Math.log(w[i] === 'Xỉu' ? sens : 1 - sens);
  }
  const mx = Math.max(logT, logX);
  const eT = Math.exp(logT - mx), eX = Math.exp(logX - mx);
  const norm = eT + eX;
  const pT = eT / norm, pX = eX / norm;
  const diff = Math.abs(pT - pX);
  if (diff > 0.12) {
    const pred = pT > pX ? 'Xỉu' : 'Tài';
    return { detected: true, prediction: pred, confidence: Math.round(62 + diff * 120), name: `Bayesian → ${pred}`, patternId: 'bayesian_update' };
  }
  return { detected: false };
}

function analyzeXuHuongManh(results) {
  if (results.length < 8) return { detected: false };
  const r8 = results.slice(0, 8);
  const t  = r8.filter(r => r === 'Tài').length;
  if (t >= 6) return { detected: true, prediction: 'Xỉu', confidence: clamp(80 + t * 2, 55, 92), name: `Xu Hướng Mạnh ${t}/8 → Xỉu`, patternId: 'xu_huong_manh' };
  if (t <= 2) return { detected: true, prediction: 'Tài', confidence: clamp(80 + (8 - t) * 2, 55, 92), name: `Xu Hướng Mạnh ${8 - t}/8 → Tài`, patternId: 'xu_huong_manh' };
  return { detected: false };
}

function analyzeKelly(results) {
  if (results.length < 20) return { detected: false };
  const r20  = results.slice(0, 20);
  const pT   = r20.filter(r => r === 'Tài').length / 20;
  const kelly = 2 * pT - 1;
  if (Math.abs(kelly) > 0.25) {
    const pred = kelly > 0 ? 'Tài' : 'Xỉu';
    return { detected: true, prediction: pred, confidence: Math.round(60 + Math.abs(kelly) * 60), name: `Kelly → ${pred}`, patternId: 'kelly_criterion' };
  }
  return { detected: false };
}

function checkEntropyWarning(results) {
  if (results.length < 20) return null;
  const e = calcEntropy(results, 20);
  if (e > 0.95) return `⚠ Dữ liệu có dấu hiệu random (entropy=${e.toFixed(3)} > 0.95) → không nên tin tưởng`;
  return null;
}

// ═══════════════════════════════════════════════════════════
// ENGINE CHÍNH
// ═══════════════════════════════════════════════════════════
function calculatePrediction(data, type, antiLossKey, mode = 'aggressive') {
  if (!data || data.length === 0) {
    return { action: 'BET', prediction: 'Tài', confidence: 55, phienPhanTich: null, phienDoan: null, factors: ['Default'], cau: null, warning: null };
  }

  const last50  = data.slice(0, 50);
  const results = last50.map(d => d.Ket_qua ?? d.ket_qua).filter(Boolean);
  const state   = getAntiLossState(antiLossKey);
  ensureV2Fields(state);

  const warning = checkEntropyWarning(results);
  const chain = buildMarkovChain(results, 5);
  const signals = [];

  const push = (res, priority, weight) => { if (res.detected) signals.push({ ...res, priority, weight }); };
  push(predictMarkov(results, chain),  16, 2.0);
  push(analyzeEntropy(results),        15, 1.6);
  push(analyzeMomentum(last50),        14, 1.4);
  push(analyzeBayesian(results),       13, 1.8);
  push(analyzeXuHuongManh(results),    10, 1.3);
  push(analyzeKelly(results),          11, 1.5);

  if (signals.length === 0) {
    if (results.length > 0) {
      const last5 = results.slice(0, 5);
      const tC = last5.filter(r => r === 'Tài').length;
      const xC = last5.length - tC;
      const fp = tC > xC ? 'Xỉu' : tC < xC ? 'Tài' : (results[0] === 'Tài' ? 'Xỉu' : 'Tài');
      signals.push({ prediction: fp, confidence: 60, priority: 5, weight: 1.0, name: 'Fallback', patternId: 'fallback' });
    } else {
      signals.push({ prediction: 'Tài', confidence: 55, priority: 5, weight: 1.0, name: 'Default', patternId: 'default' });
    }
  }

  let taiScore = 0, xiuScore = 0;
  for (const p of signals) {
    const score = (p.confidence || 60) * (p.priority || 5) * (p.weight || 1.0);
    if (p.prediction === 'Tài') taiScore += score; else xiuScore += score;
  }
  let finalPred = taiScore >= xiuScore ? 'Tài' : 'Xỉu';

  const agreeT = signals.filter(p => p.prediction === 'Tài').length;
  const agreeX = signals.length - agreeT;
  let baseConf = Math.round(55 + (Math.max(agreeT, agreeX) / signals.length) * 30);

  // Cầu ưu tiên + memory
  const cauInfo   = detectCauType(results);
  const cauResult = checkCauAndBreak(antiLossKey, cauInfo, finalPred, results, state);
  const factors   = [];

  if (cauResult.action === 'BET' && cauInfo.detected && (cauInfo.confidence >= 65 || cauResult.cau?.reversed)) {
    finalPred = cauResult.prediction;
    baseConf  = Math.max(baseConf, cauInfo.confidence);
    factors.unshift(cauResult.reason);
  }

  let finalConf = baseConf;
  const floor   = ANTI_LOSS_V2.CONFIDENCE_FLOOR_BY_LOSS[Math.min(state.consecutiveLoss, 4)] || 55;
  if (finalConf < floor) finalConf = floor;

  if (state.consecutiveLoss >= ANTI_LOSS.FORCE_REVERSE_AT) {
    finalPred = finalPred === 'Tài' ? 'Xỉu' : 'Tài';
    finalConf = Math.min(82, finalConf + 8);
    state.forceReverseCount++;
    factors.unshift(`Force Reverse (thua ${state.consecutiveLoss})`);
    log(`[V2] 🔄 FORCE REVERSE → ${finalPred}`);
  }

  if (signals.length >= 2) {
    const sorted = [...signals].sort((a, b) => (b.priority * b.weight) - (a.priority * a.weight));
    if (sorted[0].prediction !== sorted[1].prediction) {
      finalConf = Math.max(55, finalConf - ANTI_LOSS_V2.CROSS_CHECK_PENALTY);
    }
  }

  const totalScore = taiScore + xiuScore;
  if (totalScore > 0 && Math.abs(taiScore - xiuScore) / totalScore < ANTI_LOSS_V2.CONFLICT_BALANCE_THRESHOLD) {
    finalConf = Math.max(55, finalConf - 8);
  }

  finalConf = clamp(Math.round(finalConf), ANTI_LOSS.MIN_CONFIDENCE, ANTI_LOSS.MAX_CONFIDENCE);

  if (mode === 'conservative' && finalConf <= 65) {
    return { action: 'SKIP', skip: true, prediction: null, confidence: finalConf,
      phienPhanTich: data[0]?.Phien ?? data[0]?.phien ?? null,
      phienDoan: null, factors: ['Conservative: confidence thấp'], cau: null, warning };
  }

  state.lastCauType = { type: cauInfo.type, predicted: finalPred, detectedAt: Date.now() };

  const phienHT = data[0]?.Phien ?? data[0]?.phien ?? null;
  let phienDoan = null;
  if (phienHT != null) {
    if (typeof phienHT === 'number') phienDoan = phienHT + 1;
    else if (/^\d+$/.test(String(phienHT))) phienDoan = parseInt(phienHT, 10) + 1;
    else phienDoan = `${phienHT}_next`;
  }

  return {
    action: 'BET', prediction: finalPred, confidence: finalConf,
    phienPhanTich: phienHT, phienDoan,
    factors: factors.slice(0, 3),
    cau: cauResult.cau,
    warning,
  };
}

// ═══════════════════════════════════════════════════════════
// COMPACT RESPONSE (GIỮ NGUYÊN SCHEMA)
// ═══════════════════════════════════════════════════════════
function buildCompactResponse(data, result) {
  const first   = data?.[0] ?? {};
  const phienHT = first.Phien ?? first.phien ?? null;
  let phienDoan = result.phienDoan;
  if (!phienDoan && phienHT != null) {
    phienDoan = typeof phienHT === 'number' ? phienHT + 1 :
      (/^\d+$/.test(String(phienHT)) ? parseInt(phienHT, 10) + 1 : `${phienHT}_next`);
  }
  return {
    phien   : phienHT,
    ketQua  : first.Ket_qua ?? first.ket_qua ?? null,
    tong    : typeof (first.Tong ?? first.tong) === 'number' ? (first.Tong ?? first.tong) : null,
    phienDoan,
    duDoan  : result.prediction ?? 'Tài',
    tiLe    : `${result.confidence ?? 55}%`,
  };
}

// ═══════════════════════════════════════════════════════════
// EXPORT REPORT
// ═══════════════════════════════════════════════════════════
function exportReport(format = 'json', outPath = null) {
  checkDailyReset();
  const total   = HISTORY_DUDOAN_STORE.length;
  const wins    = HISTORY_DUDOAN_STORE.filter(h => h.Trang_thai?.includes('✅')).length;
  const losses  = total - wins;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';

  let out;
  if (format === 'json') {
    out = JSON.stringify({
      generated: new Date().toISOString(),
      total, wins, losses, winRate: `${winRate}%`,
      daily: DAILY_TRACKER,
      cauMemory: {
        total: Object.keys(CAU_MEMORY).length,
        top: Object.entries(CAU_MEMORY)
          .sort((a, b) => (b[1].correct + b[1].wrong) - (a[1].correct + a[1].wrong))
          .slice(0, 20)
          .map(([sig, m]) => ({ signature: sig, ...m })),
      },
      history: HISTORY_DUDOAN_STORE.slice(0, 100),
    }, null, 2);
  } else {
    const lines = [
      `=== BÁO CÁO DỰ ĐOÁN TÀI XỈU AI v10 ===`,
      `Thời gian: ${new Date().toISOString()}`,
      `Tổng phiên: ${total} | Thắng: ${wins} | Thua: ${losses} | Tỉ lệ: ${winRate}%`,
      `Hôm nay: Thắng ${DAILY_TRACKER.totalWin} | Thua ${DAILY_TRACKER.totalLoss}`,
      `Cầu memory: ${Object.keys(CAU_MEMORY).length} signature`,
      ``,
      `--- 20 PHIÊN GẦN NHẤT ---`,
      ...HISTORY_DUDOAN_STORE.slice(0, 20).map(h =>
        `[${h.timestamp?.slice(0,19)}] ${h.game} P${h.phien_truoc}→${h.Phien_nay} Dự:${h.Du_doan} Thực:${h.result} ${h.Trang_thai}`),
    ];
    out = lines.join('\n');
  }

  if (outPath) {
    fs.writeFileSync(outPath, out, 'utf8');
    log(`[Report] Đã ghi: ${outPath}`);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// WORKERS (GIỮ NGUYÊN)
// ═══════════════════════════════════════════════════════════
function workerGeightdors(gameId, platformId, table, gid, isMd5) {
  const url = `https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=${platformId}&gid=${gid}`;
  let lastSid = null, sidForTx = null;
  const poll = async () => {
    if (!GAME_STATUS[gameId]) { setTimeout(poll, 2000); return; }
    try {
      const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
      const data = res.data;
      if (data?.status === 'OK' && Array.isArray(data.data)) {
        if (!isMd5) for (const g of data.data) if (g.cmd === 1008) sidForTx = g.sid;
        for (const g of data.data) {
          if (isMd5 && g.cmd === 2006) {
            const { sid, d1, d2, d3 } = g;
            if (sid && sid !== lastSid && d1 != null) {
              lastSid = sid;
              addRecord(gameId, table, { phien: sid, xuc_xac: [d1,d2,d3], tong: d1+d2+d3, ket_qua: getTaiXiu(d1,d2,d3) });
            }
          } else if (!isMd5 && g.cmd === 1003) {
            const { d1, d2, d3 } = g;
            if (sidForTx && sidForTx !== lastSid && d1 != null) {
              lastSid = sidForTx;
              addRecord(gameId, table, { phien: lastSid, xuc_xac: [d1,d2,d3], tong: d1+d2+d3, ket_qua: getTaiXiu(d1,d2,d3) });
              sidForTx = null;
            }
          }
        }
      }
    } catch (_) {}
    setTimeout(poll, 3000);
  };
  poll();
}

function workerWtx(gameId, table, url) {
  let lastSid = null;
  const poll = async () => {
    if (!GAME_STATUS[gameId]) { setTimeout(poll, 2000); return; }
    try {
      const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
      const data = res.data;
      if (data?.list?.length > 0) {
        const s = data.list[0];
        const sid = s.id; const dices = s.dices || [];
        if (sid && sid !== lastSid && dices.length === 3) {
          lastSid = sid;
          const tong = dices.reduce((a, b) => a + b, 0);
          addRecord(gameId, table, { phien: sid, xuc_xac: dices, tong, ket_qua: getTaiXiu(dices[0], dices[1], dices[2]) });
        }
      }
    } catch (_) {}
    setTimeout(poll, 3000);
  };
  poll();
}

function worker68gb(table, apiUrl) {
  let lastSid = null;
  const poll = async () => {
    if (!GAME_STATUS['68gb']) { setTimeout(poll, 2000); return; }
    try {
      const r = (await axios.get(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 })).data;
      const sid = r.Phien;
      if (sid && sid !== lastSid) {
        lastSid = sid;
        const d = [r.Xuc_xac_1, r.Xuc_xac_2, r.Xuc_xac_3];
        addRecord('68gb', table, { phien: sid, xuc_xac: d, tong: d.reduce((a,b)=>a+b,0), ket_qua: getTaiXiu(d[0],d[1],d[2]) });
      }
    } catch (_) {}
    setTimeout(poll, 2000);
  };
  poll();
}

function workerLuck8(table, apiUrl) {
  let lastSid = null;
  const poll = async () => {
    if (!GAME_STATUS['luck8']) { setTimeout(poll, 2000); return; }
    try {
      const r = (await axios.get(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 })).data;
      if (r?.state === 1 && r.data) {
        const d = r.data; const sid = d.ID;
        const codes = (d.OpenCode || '').split(',');
        if (sid && sid !== lastSid && codes.length === 3) {
          lastSid = sid;
          const dices = codes.map(Number);
          addRecord('luck8', table, { phien: sid, xuc_xac: dices, tong: dices.reduce((a,b)=>a+b,0), ket_qua: getTaiXiu(dices[0],dices[1],dices[2]) });
        }
      }
    } catch (_) {}
    setTimeout(poll, 2000);
  };
  poll();
}

function worker789clubLive() {
  const wsUrl = 'wss://ws-taixiu-ls.atpman.net/websocket';
  let ws, ka = null;
  const connect = () => {
    if (!GAME_STATUS['789club']) { setTimeout(connect, 2000); return; }
    try {
      ws = new WebSocket(wsUrl);
      ws.on('open', () => { ka = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); else { clearInterval(ka); ka = null; } }, 30000); });
      ws.on('message', msg => {
        try {
          const data = JSON.parse(msg);
          if (Array.isArray(data) && data.length >= 2 && data[0] === 5) {
            const gd = data[1];
            if (gd.sessionId && (gd.resultRaw || gd.aM)) {
              const ds = String(gd.resultRaw || gd.aM);
              if (ds.length === 3 && /^\d+$/.test(ds)) {
                const d = [+ds[0], +ds[1], +ds[2]];
                addRecord('789club', 'live', { phien: gd.sessionId, xuc_xac: d, tong: d.reduce((a,b)=>a+b,0), ket_qua: getTaiXiu(d[0],d[1],d[2]) });
              }
            }
          }
        } catch (_) {}
      });
      ws.on('close', () => { if (ka) { clearInterval(ka); ka = null; } setTimeout(connect, 5000); });
      ws.on('error', () => { try { ws.close(); } catch (_) {} });
    } catch (_) { setTimeout(connect, 5000); }
  };
  connect();
}

function worker789clubMinigame() {
  const WS_URL = 'wss://websocket.atpman.net/websocket';
  const HEADERS = { 'Origin': 'https://play.789club.wien', 'User-Agent': 'Mozilla/5.0' };
  const LOGIN_MSG = [1,'MiniGame','wanglin2019aaand','WamgLin2091',{info:JSON.stringify({ipAddress:'113.185.45.88',wsToken:'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJlbXlldTE3ODljbHVuIiwiYm90IjowLCJpc01lcmNoYW50IjpmYWxzZSwidmVyaWZpZWRCYW5rQWNjb3VudCI6ZmFsc2UsInBsYXlFdmVudExvYmJ5IjpmYWxzZSwiY3VzdG9tZXJJZCI6NjU3NjU3NjksImFmZklkIjoiNzg5IiwiYmFubmVkIjpmYWxzZSwiYnJhbmQiOiI3ODkuY2x1YiIsInRpbWVzdGFtcCI6MTc2NjQ3MDk1NTY4OCwibG9ja0dhbWVzIjpbXSwiYW1vdW50IjowLCJsb2NrQ2hhdCI6ZmFsc2UsInBob25lVmVyaWZpZWQiOmZhbHNlLCJpcEFkZHJlc3MiOiIxMTMuMTg1LjQ1Ljg4IiwibXV0ZSI6ZmFsc2UsImF2YXRhciI6Imh0dHBzOi8vYXBpLnhldWkuaW8vaW1hZ2VzL2F2YXRhci9hdmF0YXJfMjUucG5nIiwicGxhdGZvcm1JZCI6NSwidXNlcklkIjoiMjFkMTUxMjEtYjIzOC00ZDIyLTgzMTMtNGI3YjYwN2VhZjIxIiwicmVnVGltZSI6MTc2NjQ3MDkzMDEwNCwicGhvbmUiOiIiLCJkZXBvc2l0IjpmYWxzZSwidXNlcm5hbWUiOiJTOF93YW5nbGluMjAxOWFhYW5kIn0.F5jr6g1BPGMQ-5EPRdck-PDvVDXcahyGySOFSjyNEuE',locale:'vi',userId:'21d15121-b238-4d22-8313-4b7b607eaf21',username:'S8_wanglin2019aaand',timestamp:1766470955689,refreshToken:'34ed90232de44567aec7d4752b021717.e8cd9e15f74c42fb8bd491e395d73ab1'}),signature:'55A3202A0554F20C01D09CD018386265C93B292E843BE3722766912A8F01ACF50E9574D88D52FAFDABEBD4794D3306C87021EF3DD6B25DA102872D23C7C31A0F1D3EB99C0714968A64F6C40335726EB999F1CEAE49BC0954EABA48189E1BBE61BD40C898CA4D683DA76E24386F4431772D05BC8142DAEBFA90E27A9C250A5ED3'}];
  const SUBSCRIBE_TX    = [6,'MiniGame','taixiuCommonPlugin',{cmd:2100}];
  const SUBSCRIBE_LOBBY = [6,'MiniGame','lobbyPlugin',{cmd:10001}];
  let ws, ka = null;
  const connect = () => {
    if (!GAME_STATUS['789club']) { setTimeout(connect, 2000); return; }
    try {
      ws = new WebSocket(WS_URL, { headers: HEADERS });
      ws.on('open', () => {
        ws.send(JSON.stringify(LOGIN_MSG));
        setTimeout(() => { if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(SUBSCRIBE_TX)); ws.send(JSON.stringify(SUBSCRIBE_LOBBY)); } }, 1000);
        ka = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) { ws.send('2'); ws.send(JSON.stringify(SUBSCRIBE_TX)); } else { clearInterval(ka); ka = null; } }, 10000);
      });
      ws.on('message', msg => {
        try {
          const data = JSON.parse(msg);
          if (Array.isArray(data) && data.length >= 2 && typeof data[1] === 'object' && data[1].cmd === 2106) {
            const { sid, d1, d2, d3 } = data[1];
            if (sid && d1 && d2 && d3) addRecord('789club', 'minigame', { phien: sid, xuc_xac: [d1,d2,d3], tong: d1+d2+d3, ket_qua: getTaiXiu(d1,d2,d3) });
          }
        } catch (_) {}
      });
      ws.on('close', () => { if (ka) { clearInterval(ka); ka = null; } setTimeout(connect, 5000); });
      ws.on('error', () => { try { ws.close(); } catch (_) {} });
    } catch (_) { setTimeout(connect, 5000); }
  };
  connect();
}

function workerSunwin() {
  const WS_URL  = 'wss://websocket.azhkthg1.net/websocket?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhbW91bnQiOjAsInVzZXJuYW1lIjoiU0NfYXBpc3Vud2luMTIzIn0.hgrRbSV6vnBwJMg9ZFtbx3rRu9mX_hZMZ_m5gMNhkw0';
  const HEADERS = { 'Origin': 'https://play.sun.win' };
  const INIT_MSGS = [
    [1,'MiniGame','GM_apivopnhaan','WangLin',{info:JSON.stringify({ipAddress:'113.185.45.88',wsToken:'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJwbGFtYW1hIiwiYm90IjowLCJpc01lcmNoYW50IjpmYWxzZSwidmVyaWZpZWRCYW5rQWNjb3VudCI6ZmFsc2UsInBsYXlFdmVudExvYmJ5IjpmYWxzZSwiY3VzdG9tZXJJZCI6MzMxNDgxMTYyLCJhZmZJZCI6IkdFTVdJTiIsImJhbm5lZCI6ZmFsc2UsImJyYW5kIjoiZ2VtIiwidGltZXN0YW1wIjoxNzY2NDc0NzgwMDA2LCJsb2NrR2FtZXMiOltdLCJhbW91bnQiOjAsImxvY2tDaGF0IjpmYWxzZSwicGhvbmVWZXJpZmllZCI6ZmFsc2UsImlwQWRkcmVzcyI6IjExMy4xODUuNDUuODgiLCJtdXRlIjpmYWxzZSwiYXZhdGFyIjoiaHR0cHM6Ly9pbWFnZXMuc3dpbnNob3AubmV0L2ltYWdlcy9hdmF0YXIvYXZhdGFyXzE4LnBuZyIsInBsYXRmb3JtSWQiOjUsInVzZXJJZCI6IjZhOGI0ZDM4LTFlYzEtNDUxYi1hYTA1LWYyZDkwYWFhNGM1MCIsInJlZ1RpbWUiOjE3NjY0NzQ3NTEzOTEsInBob25lIjoiIiwiZGVwb3NpdCI6ZmFsc2UsInVzZXJuYW1lIjoiR01fYXBpdm9wbmhhYW4ifQ.YFOscbeojWNlRo7490BtlzkDGYmwVpnlgOoh04oCJy4',locale:'vi',userId:'6a8b4d38-1ec1-451b-aa05-f2d90aaa4c50',username:'GM_apivopnhaan',timestamp:1766474780007,refreshToken:'63d5c9be0c494b74b53ba150d69039fd.7592f06d63974473b4aaa1ea849b2940'}),signature:'66772A1641AA8B18BD99207CE448EA00ECA6D8A4D457C1FF13AB092C22C8DECF0C0014971639A0FBA9984701A91FCCBE3056ABC1BE1541D1C198AA18AF3C45595AF6601F8B048947ADF8F48A9E3E074162F9BA3E6C0F7543D38BD54FD4C0A2C56D19716CC5353BBC73D12C3A92F78C833F4EFFDC4AB99E55C77AD2CDFA91E296'}],
    [6,'MiniGame','taixiuPlugin',{cmd:1005}],
    [6,'MiniGame','lobbyPlugin',{cmd:10001}],
  ];
  let ws, curSid = null, ka = null;
  const connect = () => {
    if (!GAME_STATUS['sunwin']) { setTimeout(connect, 2000); return; }
    try {
      ws = new WebSocket(WS_URL, { headers: HEADERS });
      ws.on('open', async () => {
        for (const m of INIT_MSGS) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); await new Promise(r => setTimeout(r, 600)); }
        ka = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); else { clearInterval(ka); ka = null; } }, 30000);
      });
      ws.on('message', msg => {
        try {
          const data = JSON.parse(msg);
          if (!Array.isArray(data)) return;
          let cmd = null, payload = null;
          if (data.length > 1 && typeof data[1] === 'object') { payload = data[1]; cmd = payload.cmd; }
          else if (data.length > 2 && typeof data[2] === 'object') { payload = data[2]; cmd = payload.cmd; }
          if (cmd === 1008 && payload?.sid) curSid = payload.sid;
          else if (cmd === 1003 && payload) {
            const { d1, d2, d3 } = payload;
            if (d1 != null && d2 != null && d3 != null) {
              addRecord('sunwin', 'main', { phien: curSid || payload.sid, xuc_xac: [d1,d2,d3], tong: d1+d2+d3, ket_qua: getTaiXiu(d1,d2,d3) });
              curSid = null;
            }
          }
        } catch (_) {}
      });
      ws.on('close', () => { if (ka) { clearInterval(ka); ka = null; } setTimeout(connect, 3000); });
      ws.on('error', () => { try { ws.close(); } catch (_) {} });
    } catch (_) { setTimeout(connect, 3000); }
  };
  connect();
}

function workerSumclub() {
  const SERVERS = [
    { base: 'https://taixiu.apisum.pro',  hub: 'luckydiceHub',  tid: 1, table: 'hu'  },
    { base: 'https://taixiu1.apisum.pro', hub: 'luckydice1Hub', tid: 2, table: 'md5' },
  ];
  const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://play.sum.vin' };
  SERVERS.forEach(sv => {
    const connect = async () => {
      if (!GAME_STATUS['sumclub']) { setTimeout(connect, 2000); return; }
      try {
        const neg  = await axios.get(`${sv.base}/signalr/negotiate?clientProtocol=1.5`, { headers: HEADERS, timeout: 5000 });
        const token = neg.data.ConnectionToken;
        if (!token) { setTimeout(connect, 3000); return; }
        const wsUrl = `${sv.base.replace('https','wss')}/signalr/connect?transport=webSockets&connectionToken=${encodeURIComponent(token)}&connectionData=${encodeURIComponent(JSON.stringify([{name:sv.hub}]))}&clientProtocol=1.5&tid=${sv.tid}`;
        const ws = new WebSocket(wsUrl, { headers: HEADERS });
        let ka = null;
        ws.on('open', () => {
          ws.send(JSON.stringify([1,'MiniGame','GM_apivopnha','tiendat',{info:'{}',signature:''}]));
          ws.send(JSON.stringify([6,'MiniGame','taixiuPlugin',{cmd:1005}]));
          ka = setInterval(() => { if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({M:'PingPong',H:sv.hub,I:Date.now()})); ws.send('{"type":6}'); } else { clearInterval(ka); ka = null; } }, 5000);
        });
        ws.on('message', msg => {
          try {
            const data = JSON.parse(msg);
            for (const m of data.M || []) {
              if (m.M === 'sessionInfo' && m.A) {
                const res = m.A[0]?.Result || {};
                const d1 = res.Dice1||0, d2 = res.Dice2||0, d3 = res.Dice3||0;
                if (d1 > 0 && d2 > 0 && d3 > 0)
                  addRecord('sumclub', sv.table, { phien: m.A[0].SessionID, xuc_xac:[d1,d2,d3], tong:d1+d2+d3, ket_qua:getTaiXiu(d1,d2,d3) });
              }
            }
          } catch (_) {}
        });
        ws.on('close', () => { if (ka) { clearInterval(ka); ka = null; } setTimeout(connect, 3000); });
        ws.on('error', () => { try { ws.close(); } catch (_) {} });
      } catch (_) { setTimeout(connect, 3000); }
    };
    connect();
  });
}

function startAllWorkers() {
  log('Starting all workers...');
  workerGeightdors('b52',    'b5',  'hu',    'vgmn_100', false);
  workerGeightdors('b52',    'b5',  'md5',   'vgmn_101', true);
  workerGeightdors('hitclub','g8',  'hu',    'vgmn_100', false);
  workerGeightdors('hitclub','g8',  'md5',   'vgmn_101', true);
  workerGeightdors('rikvip', 'rik', 'hu',    'vgmn_100', false);
  workerGeightdors('rikvip', 'rik', 'md5',   'vgmn_101', true);
  workerWtx('betvip', 'hu',  'https://wtx.macminim6.online/v1/tx/sessions');
  workerWtx('betvip', 'md5', 'https://wtxmd52.macminim6.online/v1/txmd5/sessions');
  workerWtx('lc79',   'hu',  'https://wtx.tele68.com/v1/tx/sessions');
  workerWtx('lc79',   'md5', 'https://wtxmd52.tele68.com/v1/txmd5/sessions');
  worker68gb('hu',  'http://160.250.5.186:3201/api/68/xanh');
  worker68gb('md5', 'http://160.250.5.186:3050/api/68/md5');
  workerLuck8('txhu',  'https://luck8bot.com/api/GetNewLottery/Taixiu');
  workerLuck8('txmd5', 'https://luck8bot.com/api/GetNewLottery/TaixiuMd5');
  workerLuck8('tx3p',  'https://luck8bot.com/api/GetNewLottery/TaixiuMd3');
  worker789clubLive();
  worker789clubMinigame();
  workerSunwin();
  workerSumclub();
  log('All workers started.');
}

// ═══════════════════════════════════════════════════════════
// LC79 FETCH
// ═══════════════════════════════════════════════════════════
function transformLC79(apiData) {
  if (!apiData?.list || !Array.isArray(apiData.list)) return null;
  return apiData.list.map(item => ({
    Phien: item.id,
    Ket_qua: item.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu',
    Xuc_xac_1: item.dices[0], Xuc_xac_2: item.dices[1], Xuc_xac_3: item.dices[2],
    Tong: item.point,
  }));
}

async function fetchLC79Hu() {
  try { return transformLC79((await axios.get('https://wtx.tele68.com/v1/tx/sessions', { timeout: 10000 })).data); }
  catch (_) { return null; }
}
async function fetchLC79Md5() {
  try { return transformLC79((await axios.get('https://wtxmd52.tele68.com/v1/txmd5/sessions', { timeout: 10000 })).data); }
  catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════
// AUTO VERIFY
// ═══════════════════════════════════════════════════════════
const LAST_PREDICTION = new Map();

function autoVerifyLoop() {
  setInterval(async () => {
    try {
      const hu = await fetchLC79Hu();
      if (hu?.length > 0) {
        const p = LAST_PREDICTION.get('lc79_hu');
        if (p) {
          const actual = hu.find(d => String(d.Phien) === String(p.phien));
          if (actual) {
            updateAntiLossState('lc79_hu', p.prediction, actual.Ket_qua, p.phien);
            recordPredictionHistory('lc79_hu', p.currentPhien, actual.Ket_qua, p.phien, p.prediction, p.confidence);
            updatePattern10(actual.Ket_qua);
            LAST_PREDICTION.delete('lc79_hu');
          }
        }
      }
      const md5 = await fetchLC79Md5();
      if (md5?.length > 0) {
        const p = LAST_PREDICTION.get('lc79_md5');
        if (p) {
          const actual = md5.find(d => String(d.Phien) === String(p.phien));
          if (actual) {
            updateAntiLossState('lc79_md5', p.prediction, actual.Ket_qua, p.phien);
            recordPredictionHistory('lc79_md5', p.currentPhien, actual.Ket_qua, p.phien, p.prediction, p.confidence);
            updatePattern10(actual.Ket_qua);
            LAST_PREDICTION.delete('lc79_md5');
          }
        }
      }
      for (const [game, tables] of Object.entries(DATA_STORE)) {
        for (const [table, arr] of Object.entries(tables)) {
          const key = `${game}_${table}`;
          const p   = LAST_PREDICTION.get(key);
          if (!p) continue;
          const actual = arr.find(d => String(d.phien) === String(p.phien));
          if (actual) {
            const kq = actual.ket_qua || actual.Ket_qua;
            updateAntiLossState(key, p.prediction, kq, p.phien);
            recordPredictionHistory(key, p.currentPhien, kq, p.phien, p.prediction, p.confidence);
            updatePattern10(kq);
            LAST_PREDICTION.delete(key);
          }
        }
      }
    } catch (e) { logError('[AutoVerify]', e); }
  }, 5000);
}

// ═══════════════════════════════════════════════════════════
// HTML UI (giữ nguyên)
// ═══════════════════════════════════════════════════════════
const TOOL_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0a0e27">
<title>Tài Xỉu AI v10</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#0a0e27 0%,#1a1f3a 100%);color:#fff;min-height:100vh;padding:12px;padding-bottom:80px;overflow-x:hidden}
.header{text-align:center;padding:16px 0;border-bottom:1px solid #2a3050;margin-bottom:16px}
.header h1{font-size:22px;background:linear-gradient(90deg,#00ff88,#00ccff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:800}
.header .sub{font-size:11px;color:#8892b0;margin-top:4px}
.card{background:rgba(30,35,60,0.85);border:1px solid #2a3050;border-radius:14px;padding:16px;margin-bottom:12px;backdrop-filter:blur(10px)}
.game-info{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.game-name{font-size:15px;font-weight:700;color:#00ff88}
.phien-info{font-size:12px;color:#8892b0}
.kq-display{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}
.kq-item{background:rgba(0,0,0,0.3);border-radius:10px;padding:10px 8px;text-align:center}
.kq-item .label{font-size:10px;color:#8892b0;margin-bottom:4px;text-transform:uppercase}
.kq-item .value{font-size:15px;font-weight:700;color:#fff}
.value.tai{color:#00ff88}.value.xiu{color:#ff5577}
.prediction-box{background:linear-gradient(135deg,rgba(0,255,136,0.1),rgba(0,204,255,0.1));border:2px solid #00ff88;border-radius:14px;padding:20px;text-align:center;margin:12px 0}
.prediction-box.xiu{background:linear-gradient(135deg,rgba(255,85,119,0.1),rgba(255,0,100,0.1));border-color:#ff5577}
.pred-label{font-size:12px;color:#8892b0;margin-bottom:8px}
.pred-value{font-size:42px;font-weight:900;letter-spacing:2px;margin-bottom:8px}
.pred-value.tai{color:#00ff88;text-shadow:0 0 30px rgba(0,255,136,0.5)}
.pred-value.xiu{color:#ff5577;text-shadow:0 0 30px rgba(255,85,119,0.5)}
.pred-rate{font-size:16px;color:#00ccff;font-weight:700}
.btn{background:linear-gradient(135deg,#00ff88,#00ccff);border:none;border-radius:12px;color:#0a0e27;font-weight:800;padding:14px;width:100%;font-size:15px;cursor:pointer;margin-top:8px;transition:transform 0.1s}
.btn:active{transform:scale(0.97)}.btn:disabled{opacity:0.5;cursor:not-allowed}
.status-bar{position:fixed;bottom:0;left:0;right:0;background:rgba(10,14,39,0.95);border-top:1px solid #2a3050;padding:8px 12px;font-size:11px;color:#8892b0;text-align:center;backdrop-filter:blur(10px);z-index:100}
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#ff5577;margin-right:6px}
.status-dot.online{background:#00ff88;box-shadow:0 0 10px #00ff88}
.loading{display:inline-block;width:16px;height:16px;border:2px solid #2a3050;border-top-color:#00ff88;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.9);color:#fff;padding:10px 20px;border-radius:20px;font-size:13px;z-index:1000;opacity:0;transition:opacity 0.3s;pointer-events:none}
.toast.show{opacity:1}
.history{display:flex;gap:4px;flex-wrap:wrap;margin-top:8px}
.h-item{padding:4px 8px;border-radius:6px;font-size:11px;font-weight:700}
.h-item.tai{background:rgba(0,255,136,0.2);color:#00ff88}.h-item.xiu{background:rgba(255,85,119,0.2);color:#ff5577}
.warning-box{background:rgba(255,200,0,0.1);border:1px solid #ffc800;border-radius:8px;padding:8px 12px;font-size:11px;color:#ffc800;margin-top:8px}
.cau-box{background:rgba(0,204,255,0.1);border:1px solid #00ccff;border-radius:8px;padding:8px 12px;font-size:11px;color:#00ccff;margin-top:8px}
</style>
</head>
<body>
<div class="header"><h1>🎲 TÀI XỈU AI v10</h1><div class="sub">Học Cầu + Memory | @tranhoang2286</div></div>
<div class="card">
<div class="game-info"><div class="game-name" id="gameName">LC79 HŨ</div><div class="phien-info" id="phienInfo">Phiên: ---</div></div>
<div class="kq-display">
<div class="kq-item"><div class="label">Phiên</div><div class="value" id="valPhien">---</div></div>
<div class="kq-item"><div class="label">Kết quả</div><div class="value" id="valKetQua">---</div></div>
<div class="kq-item"><div class="label">Tổng</div><div class="value" id="valTong">---</div></div>
<div class="kq-item"><div class="label">Phiên đoán</div><div class="value" id="valPhienDoan">---</div></div>
</div>
<div class="prediction-box" id="predBox">
<div class="pred-label">DỰ ĐOÁN PHIÊN TỚI</div>
<div class="pred-value" id="predValue">---</div>
<div class="pred-rate" id="predRate">0%</div>
</div>
<div id="cauBox"></div>
<div id="warningBox"></div>
<button class="btn" id="btnPredict" onclick="doPredict()">🚀 DỰ ĐOÁN NGAY</button>
<div style="margin-top:12px;font-size:11px;color:#8892b0;text-align:center">
<div id="loading" style="display:none"><span class="loading"></span> Đang phân tích...</div>
<div id="historyBox" style="margin-top:8px"></div>
</div>
</div>
<div class="card">
<div style="font-size:13px;font-weight:700;color:#00ccff;margin-bottom:8px">⚙️ Chọn Game</div>
<select id="gameSelect" onchange="switchGame()" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid #2a3050;border-radius:10px;padding:12px;color:#fff;font-size:14px">
<option value="lc79/hu">LC79 HŨ</option><option value="lc79/md5">LC79 MD5</option>
<option value="b52/hu">B52 HŨ</option><option value="b52/md5">B52 MD5</option>
<option value="hitclub/hu">HITCLUB HŨ</option><option value="hitclub/md5">HITCLUB MD5</option>
<option value="betvip/hu">BETVIP HŨ</option><option value="betvip/md5">BETVIP MD5</option>
<option value="rikvip/hu">RIKVIP HŨ</option><option value="sunwin/main">SUNWIN</option>
<option value="68gb/hu">68GB HŨ</option><option value="68gb/md5">68GB MD5</option>
<option value="luck8/txhu">LUCK8 HŨ</option><option value="luck8/txmd5">LUCK8 MD5</option>
<option value="sumclub/hu">SUMCLUB HŨ</option>
<option value="789club/live">789CLUB LIVE</option><option value="789club/minigame">789CLUB MINI</option>
</select>
</div>
<div class="status-bar"><span class="status-dot" id="statusDot"></span><span id="statusText">Đang kết nối...</span></div>
<div class="toast" id="toast"></div>
<script>
const API_BASE = window.location.origin;
let currentGame = 'lc79/hu', isOnline = false;
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2000);}
function switchGame(){currentGame=document.getElementById('gameSelect').value;const names={'lc79/hu':'LC79 HŨ','lc79/md5':'LC79 MD5','b52/hu':'B52 HŨ','b52/md5':'B52 MD5','hitclub/hu':'HITCLUB HŨ','hitclub/md5':'HITCLUB MD5','betvip/hu':'BETVIP HŨ','betvip/md5':'BETVIP MD5','rikvip/hu':'RIKVIP HŨ','sunwin/main':'SUNWIN','68gb/hu':'68GB HŨ','68gb/md5':'68GB MD5','luck8/txhu':'LUCK8 HŨ','luck8/txmd5':'LUCK8 MD5','sumclub/hu':'SUMCLUB HŨ','789club/live':'789CLUB LIVE','789club/minigame':'789CLUB MINI'};document.getElementById('gameName').textContent=names[currentGame]||currentGame;doPredict();}
async function doPredict(){const btn=document.getElementById('btnPredict'),loading=document.getElementById('loading');btn.disabled=true;loading.style.display='block';try{const[game,table]=currentGame.split('/');const res=await fetch(API_BASE+'/api/predict/'+game+'/'+table,{cache:'no-store'});const data=await res.json();document.getElementById('valPhien').textContent=data.phien||'---';document.getElementById('valPhienDoan').textContent=data.phienDoan||'---';document.getElementById('valTong').textContent=data.tong!=null?data.tong:'---';document.getElementById('phienInfo').textContent='Phiên: '+(data.phien||'---');const kqEl=document.getElementById('valKetQua');kqEl.textContent=data.ketQua||'---';kqEl.className='value '+(data.ketQua==='Tài'?'tai':data.ketQua==='Xỉu'?'xiu':'');const predBox=document.getElementById('predBox'),predValue=document.getElementById('predValue'),predRate=document.getElementById('predRate');if(data.duDoan==='Tài'||data.duDoan==='Xỉu'){predValue.textContent=data.duDoan;predValue.className='pred-value '+(data.duDoan==='Tài'?'tai':'xiu');predBox.className='prediction-box '+(data.duDoan==='Xỉu'?'xiu':'');predRate.textContent=data.tiLe||'0%';const hist=JSON.parse(localStorage.getItem('history_'+currentGame)||'[]');hist.unshift({phien:data.phienDoan,duDoan:data.duDoan,tiLe:data.tiLe});if(hist.length>10)hist.length=10;localStorage.setItem('history_'+currentGame,JSON.stringify(hist));renderHistory();}else{predValue.textContent='---';predValue.className='pred-value';predRate.textContent='0%';}
const cb=document.getElementById('cauBox');if(data.cau&&data.cau.name){let txt='🎯 '+data.cau.name;if(data.cau.reversed)txt+=' [ĐẢO]';if(data.cau.memoryStats)txt+=' | Mem: '+data.cau.memoryStats.correct+'/'+data.cau.memoryStats.total+' ('+data.cau.memoryStats.winRate+'%)';cb.innerHTML='<div class="cau-box">'+txt+'</div>';}else cb.innerHTML='';
const wb=document.getElementById('warningBox');wb.innerHTML=data.warning?'<div class="warning-box">'+data.warning+'</div>':'';isOnline=true;updateStatus();}catch(err){showToast('Lỗi: '+err.message);isOnline=false;updateStatus();}finally{btn.disabled=false;loading.style.display='none';}}
function renderHistory(){const hist=JSON.parse(localStorage.getItem('history_'+currentGame)||'[]');const box=document.getElementById('historyBox');if(!hist.length){box.innerHTML='';return;}let html='<div style="font-size:10px;color:#8892b0;margin-bottom:4px">Lịch sử dự đoán:</div><div class="history">';for(const h of hist)html+='<div class="h-item '+(h.duDoan==='Tài'?'tai':'xiu')+'">'+h.phien+': '+h.duDoan+'</div>';html+='</div>';box.innerHTML=html;}
function updateStatus(){const dot=document.getElementById('statusDot'),text=document.getElementById('statusText');if(isOnline){dot.classList.add('online');text.textContent='Online - Server kết nối OK';}else{dot.classList.remove('online');text.textContent='Offline - Kiểm tra server';}}
setInterval(()=>{if(!document.getElementById('btnPredict').disabled)doPredict();},30000);
window.addEventListener('load',()=>{switchGame();updateStatus();});
</script>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════
// EXPRESS APP
// ═══════════════════════════════════════════════════════════
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers','*');
  res.header('Access-Control-Max-Age',       '86400');
  res.header('X-Content-Type-Options',       'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

app.get('/',          (_, res) => res.type('html').send(TOOL_HTML));
app.get('/tool',      (_, res) => res.type('html').send(TOOL_HTML));
app.get('/index.html',(_, res) => res.type('html').send(TOOL_HTML));

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'taixiu-ai-v10', idol: '@tranhoang2286', uptime: process.uptime(), memory: process.memoryUsage(), port: PORT, host: HOST }));

app.get('/api/info', (_, res) => {
  const ips = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets) { if (net.family === 'IPv4' && !net.internal) ips.push(net.address); }
  }
  res.json({ status: 'ok', port: PORT, host: HOST, localIPs: ips, urls: ['http://localhost:' + PORT, ...ips.map(ip => `http://${ip}:${PORT}`)], idol: '@tranhoang2286' });
});

app.get('/api/games', (_, res) => {
  const games = [];
  for (const [game, tables] of Object.entries(DATA_STORE)) {
    for (const [table, arr] of Object.entries(tables)) {
      if (arr.length > 0) games.push({ game, table, count: arr.length, latest: arr[0] ? { phien: arr[0].phien, ketQua: arr[0].ket_qua, tong: arr[0].tong } : null });
    }
  }
  res.json({ total: games.length, games });
});

app.get('/api/pattern10', (_, res) => res.json({ pattern_10: PATTERN_10_STORE.pattern_10, total: PATTERN_10_STORE.pattern_10.length }));

app.get('/api/history/dudoan', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 1000, 1000);
  let list = HISTORY_DUDOAN_STORE;
  if (req.query.game) list = list.filter(h => h.game === req.query.game);
  res.json({ total: list.length, showing: Math.min(limit, list.length), history: list.slice(0, limit) });
});

// 🆕 CẦU MEMORY ENDPOINTS
app.get('/api/cau/memory', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const list = Object.entries(CAU_MEMORY)
    .map(([sig, m]) => ({ signature: sig, ...m }))
    .sort((a, b) => (b.correct + b.wrong) - (a.correct + a.wrong))
    .slice(0, limit);
  res.json({ total: Object.keys(CAU_MEMORY).length, showing: list.length, memory: list });
});

app.get('/api/cau/memory/:signature', (req, res) => {
  const m = CAU_MEMORY[req.params.signature];
  if (!m) return res.status(404).json({ error: 'NOT_FOUND', signature: req.params.signature });
  const total = m.correct + m.wrong;
  res.json({ signature: req.params.signature, ...m, winRate: total > 0 ? ((m.correct / total) * 100).toFixed(1) + '%' : '0%' });
});

app.post('/api/cau/memory/reset', (_, res) => {
  CAU_MEMORY = {};
  saveJson(CAU_MEMORY_FILE, CAU_MEMORY);
  res.json({ status: 'ok', message: 'Đã reset cầu memory' });
});

app.delete('/api/cau/memory/:signature', (req, res) => {
  if (CAU_MEMORY[req.params.signature]) {
    delete CAU_MEMORY[req.params.signature];
    saveJson(CAU_MEMORY_FILE, CAU_MEMORY);
    res.json({ status: 'ok' });
  } else {
    res.status(404).json({ error: 'NOT_FOUND' });
  }
});

// ENDPOINT CHÍNH
app.get('/api/predict/:game/:table', async (req, res) => {
  try {
    const { game, table } = req.params;
    const mode = (req.query.mode === 'conservative') ? 'conservative' : 'aggressive';
    let data = DATA_STORE[game]?.[table];

    if (game === 'lc79') {
      const fetched = table === 'hu' ? await fetchLC79Hu() : await fetchLC79Md5();
      if (fetched?.length > 0) data = fetched;
    }

    if (!data || data.length === 0) {
      return res.json({ phien: null, ketQua: null, tong: null, phienDoan: null, duDoan: 'Tài', tiLe: '55%' });
    }

    const key    = `${game}_${table}`;
    const result = calculatePrediction(data, key, key, mode);

    if (result.action === 'BET' && result.phienDoan != null) {
      LAST_PREDICTION.set(key, { phien: result.phienDoan, currentPhien: result.phienPhanTich, prediction: result.prediction, confidence: result.confidence });
    }

    const resp = buildCompactResponse(data, result);
    if (result.warning) resp.warning = result.warning;
    if (result.cau) resp.cau = result.cau;
    res.json(resp);
  } catch (e) {
    logError('[API predict]', e);
    res.json({ phien: null, ketQua: null, tong: null, phienDoan: null, duDoan: 'Tài', tiLe: '55%' });
  }
});

app.get('/predict/:type', async (req, res) => {
  try {
    const type = req.params.type;
    if (type !== 'hu' && type !== 'md5') return res.json({ phien: null, ketQua: null, tong: null, phienDoan: null, duDoan: 'Tài', tiLe: '55%' });
    const data = type === 'hu' ? await fetchLC79Hu() : await fetchLC79Md5();
    if (!data?.length) return res.json({ phien: null, ketQua: null, tong: null, phienDoan: null, duDoan: 'Tài', tiLe: '55%' });
    const key    = `lc79_${type}`;
    const result = calculatePrediction(data, type, key);
    if (result.action === 'BET' && result.phienDoan != null) {
      LAST_PREDICTION.set(key, { phien: result.phienDoan, currentPhien: result.phienPhanTich, prediction: result.prediction, confidence: result.confidence });
    }
    res.json(buildCompactResponse(data, result));
  } catch (e) {
    logError('[API predict type]', e);
    res.json({ phien: null, ketQua: null, tong: null, phienDoan: null, duDoan: 'Tài', tiLe: '55%' });
  }
});

app.get('/api/jsonp/:game/:table', async (req, res) => {
  const cb = req.query.callback || 'callback';
  try {
    const { game, table } = req.params;
    let data = DATA_STORE[game]?.[table];
    if (game === 'lc79') {
      const fetched = table === 'hu' ? await fetchLC79Hu() : await fetchLC79Md5();
      if (fetched?.length > 0) data = fetched;
    }
    if (!data?.length) return res.type('js').send(`${cb}(${JSON.stringify({ phien: null, ketQua: null, tong: null, phienDoan: null, duDoan: 'Tài', tiLe: '55%' })});`);
    const key = `${game}_${table}`;
    const result = calculatePrediction(data, key, key);
    res.type('js').send(`${cb}(${JSON.stringify(buildCompactResponse(data, result))});`);
  } catch (_) {
    res.type('js').send(`${cb}(${JSON.stringify({ phien: null, ketQua: null, tong: null, phienDoan: null, duDoan: 'Tài', tiLe: '55%' })});`);
  }
});

app.post('/api/reset-state/:key', (req, res) => {
  ANTI_LOSS_STATE.delete(req.params.key);
  res.json({ status: 'ok' });
});
app.get('/api/daily', (_, res) => { checkDailyReset(); res.json(DAILY_TRACKER); });
app.get('/api/state/:key', (req, res) => {
  const s = getAntiLossState(req.params.key);
  res.json({ consecutiveLoss: s.consecutiveLoss, consecutiveWin: s.consecutiveWin, hardStopActive: s.hardStopActive, cauBreakCount: s.cauBreakCount, lastCauType: s.lastCauType, lastCauSignature: s.lastCauSignature });
});

app.post('/api/reset/history', (_, res) => {
  HISTORY_DUDOAN_STORE = []; PATTERN_10_STORE = { pattern_10: [] };
  saveJson(HISTORY_DUDOAN_FILE, HISTORY_DUDOAN_STORE);
  saveJson(PATTERN_10_FILE, PATTERN_10_STORE);
  res.json({ status: 'ok', message: 'Đã reset history và pattern_10' });
});

app.get('/api/report', (req, res) => {
  const fmt = req.query.format === 'txt' ? 'txt' : 'json';
  const out  = exportReport(fmt);
  res.type(fmt === 'txt' ? 'text/plain' : 'application/json').send(out);
});

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', path: req.path, hint: 'Mở / hoặc /tool để xem UI' }));

// ═══════════════════════════════════════════════════════════
// STARTUP (KHÔNG DEMO — CHỈ SERVER)
// ═══════════════════════════════════════════════════════════
function startServer() {
  log('══════════════════════════════════════════════');
  log('🚀 TAIXIU-AI v10 — FULL (NO DEMO) + CẦU MEMORY');
  log('══════════════════════════════════════════════');

  const ips = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets) { if (net.family === 'IPv4' && !net.internal) ips.push(net.address); }
  }

  startAllWorkers();
  autoVerifyLoop();

  app.listen(PORT, HOST, () => {
    log(`✅ Server: http://localhost:${PORT}/`);
    for (const ip of ips) log(`   http://${ip}:${PORT}/`);
    log('');
    log('📱 UI: / hoặc /tool');
    log('🔌 API:');
    log('   GET  /api/predict/:game/:table[?mode=conservative]');
    log('   GET  /api/jsonp/:game/:table?callback=fn');
    log('   GET  /predict/:type (hu|md5)');
    log('   GET  /api/games | /api/info | /health');
    log('   GET  /api/pattern10');
    log('   GET  /api/history/dudoan[?limit=N&game=G]');
    log('   GET  /api/cau/memory[?limit=N]');
    log('   GET  /api/cau/memory/:signature');
    log('   POST /api/cau/memory/reset');
    log('   GET  /api/report[?format=txt]');
    log('   GET  /api/daily | /api/state/:key');
    log('   POST /api/reset-state/:key');
    log('   POST /api/reset/history');
    log('══════════════════════════════════════════════');
  });
}

startServer();

process.on('uncaughtException',  e => logError('[UNCAUGHT]', e));
process.on('unhandledRejection', e => logError('[UNHANDLED]', e));
