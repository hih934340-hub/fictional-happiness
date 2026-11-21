'use strict';

// =================================================================================================
// all_in_one_v6.js - FULL REBUILD - SMART PATTERN BREAK + COMPACT JSON
// ✅ V2 anti-loss THỰC SỰ SKIP (không chỉ dự đoán)
// ✅ Cầu detection: nhận diện cầu đang chạy, nếu API lệch → bẻ cầu
// ✅ JSON response NGẮN GỌN: phien, ketQua, tong, phienDoan, duDoan, tiLe
// =================================================================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');

function loadRequiredModule(modName) {
    try { return require(modName); }
    catch (err) { console.error(`[RUNTIME] Thiếu "${modName}". Chạy: npm install express axios ws`); throw err; }
}

const express   = loadRequiredModule('express');
const axios     = loadRequiredModule('axios');
const WebSocket = loadRequiredModule('ws');

// ========================== PATH ==========================
function resolveWritableDir() {
    const candidates = [process.cwd(), typeof __dirname !== 'undefined' ? __dirname : null, os.tmpdir()].filter(Boolean);
    for (const dir of candidates) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            const testFile = path.join(dir, `.koder_${process.pid}.tmp`);
            fs.writeFileSync(testFile, 'ok', 'utf8');
            fs.unlinkSync(testFile);
            return dir;
        } catch (_) {}
    }
    return os.tmpdir();
}

const RUNTIME_DIR = resolveWritableDir();
const DATA_DIR    = path.join(RUNTIME_DIR, 'data_store');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

function resolveJsonFile(filename) {
    if (path.isAbsolute(filename)) return filename;
    const candidates = [];
    if (typeof __dirname !== 'undefined') candidates.push(path.join(__dirname, filename));
    candidates.push(path.join(process.cwd(), filename));
    candidates.push(path.join(DATA_DIR, filename));
    candidates.push(path.join(RUNTIME_DIR, filename));
    if (process.env.HOME) candidates.push(path.join(process.env.HOME, filename));
    candidates.push(path.join(os.tmpdir(), filename));
    for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
    return candidates[0];
}

function resolveDataFilePath(filename) {
    if (path.isAbsolute(filename)) return filename;
    return resolveJsonFile(filename);
}

const PORT        = Number(process.env.PORT) || 8080;
const HOST        = process.env.HOST || '0.0.0.0';
const MAX_HISTORY = 200;
const log         = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const logError    = (msg, err) => console.error(`[${new Date().toISOString()}] [ERROR] ${msg}`, err ? (err.message || err) : '');

// ========================== ANTI-LOSS CONFIG ==========================
const ANTI_LOSS = {
    MAX_CONSECUTIVE_LOSS : 2,
    FORCE_REVERSE_AT     : 2,
    CONFIDENCE_PENALTY   : 18,
    CONFIDENCE_BONUS     : 8,
    COOLDOWN_AFTER_FORCE : 1,
    MIN_CONFIDENCE       : 55,
    MAX_CONFIDENCE       : 92,
    NO_BET_THRESHOLD     : 40,
    HARD_STOP_AT         : 2,
    MAX_LOSS_BEFORE_SKIP : 2,
};

const ANTI_LOSS_V2 = {
    ENABLED: true,
    HARD_STOP_COOLDOWN_PHASES: 3,
    HARD_STOP_CONFIRM_WINS: 2,
    CONFIDENCE_FLOOR_BY_LOSS: { 0: 55, 1: 65, 2: 75, 3: 82, 4: 88 },
    PATTERN_LOCK_WINDOW: 10,
    PATTERN_LOCK_MIN_LOSSES: 2,
    PATTERN_LOCK_WEIGHT: 0.1,
    PATTERN_LOCK_DURATION: 5,
    REVERSE_MIN_LAYERS_CONFIRM: 2,
    REVERSE_STRONG_LAYERS: ['markov_chain', 'entropy_signal', 'bayesian_update', 'momentum_adv', 'cau_detected'],
    SKIP_TRIGGER_LOSSES_IN_WINDOW: 2,
    SKIP_WINDOW_SIZE: 3,
    CROSS_CHECK_PENALTY: 15,
    TEMPORAL_DECAY_ALPHA: 0.15,
    SAFE_MODE: false,
    SAFE_MODE_EXTRA_FLOOR: 10,
    SAFE_MODE_REVERSE_CONFIRM: 3,
    DAILY_LOSS_CAP: 8,
    CONFLICT_BALANCE_THRESHOLD: 0.10,
    // Cầu detection
    CAU_MIN_LENGTH: 3,
    CAU_MAX_LENGTH: 8,
    CAU_CONFIRM_WINDOW: 6,
    CAU_BREAK_CONFIDENCE: 78,
};

// ========================== DAILY TRACKER ==========================
const DAILY_TRACKER = { date: new Date().toDateString(), totalLoss: 0, totalWin: 0, lastReset: new Date().toISOString() };

function _checkDailyReset() {
    const today = new Date().toDateString();
    if (DAILY_TRACKER.date !== today) {
        DAILY_TRACKER.date = today;
        DAILY_TRACKER.totalLoss = 0;
        DAILY_TRACKER.totalWin = 0;
        DAILY_TRACKER.lastReset = new Date().toISOString();
        log(`[V2] 🔄 Daily reset`);
    }
}

function _updateDailyTracker(isCorrect) {
    _checkDailyReset();
    if (isCorrect) DAILY_TRACKER.totalWin++; else DAILY_TRACKER.totalLoss++;
}

function _checkDailyCap() {
    _checkDailyReset();
    if (DAILY_TRACKER.totalLoss >= ANTI_LOSS_V2.DAILY_LOSS_CAP) {
        return { capped: true, reason: `Daily Cap ${DAILY_TRACKER.totalLoss}/${ANTI_LOSS_V2.DAILY_LOSS_CAP}` };
    }
    return { capped: false };
}

// ========================== DATA STORE ==========================
const GAME_STATUS = {
    "68gb": true, "789club": true, "b52": true, "betvip": true,
    "hitclub": true, "lc79": true, "luck8": true, "rikvip": true,
    "sumclub": true, "sunwin": true
};

const DATA_STORE = {
    "68gb": { "hu": [], "md5": [] }, "789club": { "live": [], "minigame": [] },
    "b52": { "hu": [], "md5": [] }, "betvip": { "hu": [], "md5": [] },
    "hitclub": { "hu": [], "md5": [] }, "lc79": { "hu": [], "md5": [] },
    "luck8": { "txhu": [], "txmd5": [], "tx3p": [] }, "rikvip": { "hu": [], "md5": [] },
    "sumclub": { "hu": [], "md5": [] }, "sunwin": { "main": [] }
};

// ========================== ANTI-LOSS STATE ==========================
const ANTI_LOSS_STATE = {};

function getAntiLossState(key) {
    if (!ANTI_LOSS_STATE[key]) {
        ANTI_LOSS_STATE[key] = {
            consecutiveLoss: 0, consecutiveWin: 0,
            forceReverseCooldown: 0, lastForcedAt: null, forceReverseCount: 0,
            totalPredictions: 0, totalCorrect: 0,
            recentResults: [], lossHistory: [], winHistory: [],
            lastPrediction: null, lastActual: null,
            hardStopActive: false, hardStopCooldown: 0, hardStopConfirmWinsNeeded: 0,
            recoveryMode: false, recoveryWins: 0,
            patternLossMap: {}, lastSkipAt: null, skipCount: 0,
            lastPhien: null, lastCauType: null, cauBreakCount: 0,
        };
    }
    return ANTI_LOSS_STATE[key];
}

function _ensureV2StateFields(s) {
    if (!s) return;
    if (s.hardStopCooldown == null) s.hardStopCooldown = 0;
    if (s.hardStopConfirmWinsNeeded == null) s.hardStopConfirmWinsNeeded = 0;
    if (s.recoveryMode == null) s.recoveryMode = false;
    if (s.recoveryWins == null) s.recoveryWins = 0;
    if (s.patternLossMap == null) s.patternLossMap = {};
    if (s.lastCauType == null) s.lastCauType = null;
    if (s.cauBreakCount == null) s.cauBreakCount = 0;
}

// =================================================================================================
// 🔥 CẦU DETECTION - NHẬN DIỆN CẦU ĐANG CHẠY
// =================================================================================================
function detectCauType(results) {
    if (!results || results.length < 4) return { detected: false, type: null, length: 0, predict: null, confidence: 0, name: 'Chưa đủ data' };

    const r = results;
    const N = r.length;

    // 1. Cầu Bệt (streak)
    let streak = 1;
    for (let i = 1; i < N; i++) { if (r[i] === r[0]) streak++; else break; }
    if (streak >= 3 && streak <= ANTI_LOSS_V2.CAU_MAX_LENGTH) {
        const shouldBreak = streak >= 5;
        return {
            detected: true, type: 'bet', length: streak,
            predict: shouldBreak ? (r[0] === 'Tài' ? 'Xỉu' : 'Tài') : r[0],
            confidence: shouldBreak ? Math.min(90, 65 + streak * 3) : Math.min(88, 62 + streak * 2),
            name: `Cầu Bệt ${streak} ${r[0]} ${shouldBreak ? '(BẺ)' : '(TIẾP)'}`,
            patternId: 'cau_bet',
            shouldBreak,
            cauDirection: shouldBreak ? (r[0] === 'Tài' ? 'Xỉu' : 'Tài') : r[0],
        };
    }

    // 2. Cầu Đảo 1-1
    let alt = 1;
    for (let i = 1; i < N; i++) { if (r[i] !== r[i - 1]) alt++; else break; }
    if (alt >= 4 && alt <= ANTI_LOSS_V2.CAU_MAX_LENGTH) {
        const shouldBreak = alt >= 6;
        return {
            detected: true, type: 'dao11', length: alt,
            predict: shouldBreak ? r[0] : (r[0] === 'Tài' ? 'Xỉu' : 'Tài'),
            confidence: shouldBreak ? Math.min(88, 68 + alt * 2) : Math.min(82, 62 + alt * 2),
            name: `Cầu Đảo 1-1 ${alt} phiên ${shouldBreak ? '(BẺ)' : '(TIẾP)'}`,
            patternId: 'cau_dao_11',
            shouldBreak,
            cauDirection: r[0] === 'Tài' ? 'Xỉu' : 'Tài',
        };
    }

    // 3. Cầu 2-2
    if (N >= 6) {
        let pairs = 0, i = 0;
        while (i < N - 1 && pairs < 5) { if (r[i] === r[i + 1]) { pairs++; i += 2; } else break; }
        if (pairs >= 2) {
            const shouldBreak = pairs >= 4;
            const lastPair = r[0];
            return {
                detected: true, type: 'cau22', length: pairs,
                predict: shouldBreak ? (lastPair === 'Tài' ? 'Xỉu' : 'Tài') : (lastPair === 'Tài' ? 'Xỉu' : 'Tài'),
                confidence: Math.min(80, 65 + pairs * 3),
                name: `Cầu 2-2 (${pairs} cặp)`,
                patternId: 'cau_22',
                shouldBreak,
                cauDirection: lastPair === 'Tài' ? 'Xỉu' : 'Tài',
            };
        }
    }

    // 4. Cầu 3-3
    if (N >= 6) {
        let triples = 0, i = 0;
        while (i < N - 2 && triples < 4) {
            if (r[i] === r[i + 1] && r[i + 1] === r[i + 2]) { triples++; i += 3; } else break;
        }
        if (triples >= 1) {
            const shouldBreak = triples >= 3;
            const lastTriple = r[0];
            return {
                detected: true, type: 'cau33', length: triples,
                predict: shouldBreak ? (lastTriple === 'Tài' ? 'Xỉu' : 'Tài') : (lastTriple === 'Tài' ? 'Xỉu' : 'Tài'),
                confidence: Math.min(82, 68 + triples * 4),
                name: `Cầu 3-3 (${triples} bộ)`,
                patternId: 'cau_33',
                shouldBreak,
                cauDirection: lastTriple === 'Tài' ? 'Xỉu' : 'Tài',
            };
        }
    }

    // 5. Cầu 1-2-1
    if (N >= 4) {
        if (r[0] !== r[1] && r[1] === r[2] && r[2] !== r[3] && r[0] === r[3]) {
            return {
                detected: true, type: 'cau121', length: 4,
                predict: r[1], confidence: 72,
                name: `Cầu 1-2-1`,
                patternId: 'cau_121',
                cauDirection: r[1],
            };
        }
    }

    // 6. Cầu 2-1-2
    if (N >= 5) {
        if (r[0] === r[1] && r[1] !== r[2] && r[2] !== r[3] && r[3] === r[4]) {
            return {
                detected: true, type: 'cau212', length: 5,
                predict: r[0], confidence: 73,
                name: `Cầu 2-1-2`,
                patternId: 'cau_212',
                cauDirection: r[0],
            };
        }
    }

    // 7. Cầu 1-2-3
    if (N >= 6) {
        const p = r.slice(0, 6).reverse();
        if (p[0] !== p[1] && p[1] === p[2] && p[2] === p[3] && p[3] !== p[4] && p[4] === p[5]) {
            return {
                detected: true, type: 'cau123', length: 6,
                predict: p[0] === 'Tài' ? 'Xỉu' : 'Tài',
                confidence: 74, name: `Cầu 1-2-3`,
                patternId: 'cau_123',
                cauDirection: p[0] === 'Tài' ? 'Xỉu' : 'Tài',
            };
        }
    }

    // 8. Cầu 3-2-1
    if (N >= 6) {
        const p = r.slice(0, 6).reverse();
        if (p[0] === p[1] && p[1] === p[2] && p[3] === p[4] && p[2] !== p[3] && p[4] !== p[5]) {
            return {
                detected: true, type: 'cau321', length: 6,
                predict: p[2] === 'Tài' ? 'Xỉu' : 'Tài',
                confidence: 75, name: `Cầu 3-2-1`,
                patternId: 'cau_321',
                cauDirection: p[2] === 'Tài' ? 'Xỉu' : 'Tài',
            };
        }
    }

    // 9. Cầu Nhảy Cóc (cách 1)
    if (N >= 6) {
        if (r[0] === r[2] && r[2] === r[4] && r[1] === r[3] && r[3] === r[5] && r[0] !== r[1]) {
            return {
                detected: true, type: 'cau_nhay_coc', length: 6,
                predict: r[4], confidence: 76, name: `Cầu Nhảy Cóc`,
                patternId: 'cau_nhay_coc',
                cauDirection: r[4],
            };
        }
    }

    // 10. Cầu Rồng (streak >= 6)
    if (streak >= 6) {
        return {
            detected: true, type: 'cau_rong', length: streak,
            predict: r[0] === 'Tài' ? 'Xỉu' : 'Tài',
            confidence: Math.min(92, 75 + streak),
            name: `Cầu Rồng ${streak} ${r[0]} → BẺ`, patternId: 'cau_rong',
            shouldBreak: true,
            cauDirection: r[0] === 'Tài' ? 'Xỉu' : 'Tài',
        };
    }

    return { detected: false, type: null, length: 0, predict: null, confidence: 0, name: 'Không có cầu' };
}

// =================================================================================================
// 🎯 KIỂM TRA CẦU VÀ BẺ CẦU
// =================================================================================================
function checkCauAndBreak(key, cauInfo, currentPrediction, results, state) {
    if (!cauInfo.detected) return { action: 'PASS', prediction: currentPrediction, reason: 'Không có cầu', cau: null };

    _ensureV2StateFields(state);

    // Nếu cầu đang BỊ BẺ (cầu nói 1 đằng, kết quả ra 1 nẻo)
    const cauPrediction = cauInfo.predict;
    const previousCau = state.lastCauType;

    // Nếu phiên trước cầu dự đoán SAI → đánh dấu cầu đã bị bẻ
    if (previousCau && previousCau.type === cauInfo.type && previousCau.predicted && state.lastActual) {
        const cauWasWrong = (previousCau.predicted !== state.lastActual);
        if (cauWasWrong) {
            state.cauBreakCount = (state.cauBreakCount || 0) + 1;
            log(`[CAU] ⚠️ Cầu ${cauInfo.type} bị BẺ (${previousCau.predicted} vs ${state.lastActual}) count=${state.cauBreakCount}`);
        }
    }

    // Nếu cầu đã bị bẻ >= 2 lần → đảo ngược hướng cầu
    const shouldReverseCau = state.cauBreakCount >= 2;

    let finalPrediction = currentPrediction;
    let reason = `Cầu ${cauInfo.type}: ${cauInfo.name}`;
    let action = 'BET';

    if (shouldReverseCau) {
        // Cầu bị bẻ → đi ngược cầu
        finalPrediction = cauPrediction === 'Tài' ? 'Xỉu' : 'Tài';
        reason = `Cầu ${cauInfo.type} bị BẺ ${state.cauBreakCount} lần → ĐI NGƯỢC: ${finalPrediction}`;
        log(`[CAU] 🔄 BẺ CẦU ${cauInfo.type} → đảo ngược: ${finalPrediction}`);
    } else if (cauInfo.shouldBreak) {
        // Cầu quá dài → bẻ
        finalPrediction = cauInfo.cauDirection || (cauPrediction === 'Tài' ? 'Xỉu' : 'Tài');
        reason = `Cầu ${cauInfo.type} dài ${cauInfo.length} → BẺ: ${finalPrediction}`;
    } else {
        // Đi theo cầu
        finalPrediction = cauPrediction;
    }

    // Cập nhật state để theo dõi lần sau
    state.lastCauType = { type: cauInfo.type, predicted: finalPrediction, detectedAt: Date.now() };

    return {
        action: action,
        prediction: finalPrediction,
        reason: reason,
        cau: {
            type: cauInfo.type,
            length: cauInfo.length,
            name: cauInfo.name,
            cauPrediction: cauPrediction,
            shouldBreak: cauInfo.shouldBreak || false,
            breakCount: state.cauBreakCount,
            reversed: shouldReverseCau,
        },
    };
}

// =================================================================================================
// UPDATE ANTI-LOSS STATE
// =================================================================================================
function updateAntiLossState(key, predicted, actual, phien) {
    const s = getAntiLossState(key);
    _ensureV2StateFields(s);

    const isCorrect = (predicted === actual);
    s.totalPredictions++;
    if (isCorrect) s.totalCorrect++;
    s.recentResults.push(isCorrect);
    if (s.recentResults.length > 30) s.recentResults.shift();
    s.lastPhien = phien;

    // Reset cầu break count nếu win
    if (isCorrect) {
        s.consecutiveLoss = 0;
        s.consecutiveWin++;
        s.hardStopActive = false;
        s.forceReverseCooldown = Math.max(0, s.forceReverseCooldown - 1);
        s.winHistory.push({ phien, predicted, actual });
        if (s.winHistory.length > 50) s.winHistory.shift();
        log(`[ANTI-LOSS] ✅ WIN ${key} phien=${phien} streak=${s.consecutiveWin}`);

        if (s.recoveryMode) {
            s.recoveryWins++;
            if (s.recoveryWins >= s.hardStopConfirmWinsNeeded) {
                s.recoveryMode = false;
                s.recoveryWins = 0;
                log(`[V2] ✅ RECOVERY HOÀN TẤT ${key}`);
            }
        }
    } else {
        s.consecutiveWin = 0;
        s.consecutiveLoss++;
        s.lossHistory.push({ phien, predicted, actual });
        if (s.lossHistory.length > 50) s.lossHistory.shift();
        log(`[ANTI-LOSS] ❌ LOSS ${key} phien=${phien} streak=${s.consecutiveLoss}`);

        if (s.consecutiveLoss >= ANTI_LOSS.HARD_STOP_AT) {
            s.hardStopActive = true;
            s.hardStopCooldown = ANTI_LOSS_V2.HARD_STOP_COOLDOWN_PHASES;
            s.hardStopConfirmWinsNeeded = ANTI_LOSS_V2.HARD_STOP_CONFIRM_WINS;
            log(`[V2] 🛑 HARD STOP ${key} → cooldown ${s.hardStopCooldown}`);
        }
    }

    s.lastPrediction = predicted;
    s.lastActual = actual;
    _updateDailyTracker(isCorrect);
    return isCorrect;
}

// =================================================================================================
// 🎯 PREDICTION ENGINE
// =================================================================================================
function get_tai_xiu(d1, d2, d3) { return (d1 + d2 + d3) <= 10 ? "Xỉu" : "Tài"; }

function add_record(game, table, record) {
    if (!DATA_STORE[game] || !DATA_STORE[game][table]) return;
    const arr = DATA_STORE[game][table];
    const idx = arr.findIndex(item => item.phien === record.phien);
    if (idx !== -1) arr[idx] = record;
    else arr.unshift(record);
    if (arr.length > MAX_HISTORY) arr.pop();
}

function buildMarkovChain(results, maxOrder) {
    if (!maxOrder) maxOrder = 5;
    const chain = {};
    for (let order = 1; order <= maxOrder; order++) {
        for (let i = 0; i < results.length - order; i++) {
            const state = results.slice(i, i + order).join('');
            const next = results[i + order];
            if (!chain[state]) chain[state] = { 'Tài': 0, 'Xỉu': 0, total: 0 };
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
        if (chain[state] && chain[state].total >= 3) {
            const tCount = chain[state]['Tài'] || 0;
            const xCount = chain[state]['Xỉu'] || 0;
            const total = chain[state].total;
            const prob = Math.max(tCount, xCount) / total;
            if (prob >= 0.55) {
                const pred = tCount >= xCount ? 'Tài' : 'Xỉu';
                return { detected: true, prediction: pred, confidence: Math.round(55 + prob * 35), name: `Markov ${order} (${tCount}T-${xCount}X/${total})`, patternId: 'markov_chain' };
            }
        }
    }
    return { detected: false };
}

function calcEntropy(results, windowSize) {
    if (!windowSize) windowSize = 20;
    const w = results.slice(0, windowSize);
    if (w.length === 0) return 0;
    const nTai = w.filter(r => r === 'Tài').length;
    const nXiu = w.length - nTai;
    const p1 = nTai / w.length, p2 = nXiu / w.length;
    if (p1 === 0 || p2 === 0) return 0;
    return -(p1 * Math.log2(p1) + p2 * Math.log2(p2));
}

function analyzeEntropy(results) {
    if (results.length < 20) return { detected: false };
    const eNow = calcEntropy(results, 10);
    const eBefore = calcEntropy(results.slice(10), 10);
    if (eNow < 0.7 && eBefore > 0.85) {
        const r5 = results.slice(0, 5);
        if (r5.filter(r => r === r5[0]).length >= 4) {
            return { detected: true, prediction: r5[0], confidence: Math.round(72 + (1 - eNow) * 15), name: `Entropy Thấp → ${r5[0]}`, patternId: 'entropy_signal' };
        }
    }
    if (eNow > 0.95 && eBefore < 0.75) {
        const r3 = results.slice(0, 3);
        const dom = r3.filter(r => r === r3[0]).length >= 2 ? r3[0] : null;
        if (dom) return { detected: true, prediction: dom === 'Tài' ? 'Xỉu' : 'Tài', confidence: 68, name: `Entropy Tăng → Đảo`, patternId: 'entropy_signal' };
    }
    return { detected: false };
}

function analyzeMomentum(data) {
    if (data.length < 15) return { detected: false };
    if (data.slice(0, 15).some(d => d.fromJson)) return { detected: false };
    const sums = data.slice(0, 15).map(d => d.Tong || 10.5);
    const weights = sums.map((_, i) => 15 - i);
    const wmaTai = sums.reduce((acc, s, i) => acc + (s > 10 ? weights[i] : 0), 0);
    const wmaXiu = sums.reduce((acc, s, i) => acc + (s <= 10 ? weights[i] : 0), 0);
    const totalW = weights.reduce((a, b) => a + b, 0);
    const diff = Math.abs(wmaTai / totalW - wmaXiu / totalW);
    if (diff > 0.15) {
        const dom = wmaTai > wmaXiu ? 'Tài' : 'Xỉu';
        if (data.slice(0, 3).filter(d => d.Ket_qua === dom).length >= 2) {
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
    const maxL = Math.max(logT, logX);
    const eT = Math.exp(logT - maxL), eX = Math.exp(logX - maxL);
    const norm = eT + eX;
    const pT = eT / norm, pX = eX / norm;
    const diff = Math.abs(pT - pX);
    if (diff > 0.12) {
        const pred = pT > pX ? 'Xỉu' : 'Tài';
        return { detected: true, prediction: pred, confidence: Math.round(62 + diff * 120), name: `Bayesian → ${pred}`, patternId: 'bayesian_update' };
    }
    return { detected: false };
}

function analyzeClusterBreak(results) {
    if (results.length < 12) return { detected: false };
    const clusters = [];
    let cur = results[0], len = 1;
    for (let i = 1; i < results.length; i++) {
        if (results[i] === cur) len++;
        else { clusters.push({ type: cur, len }); cur = results[i]; len = 1; }
    }
    clusters.push({ type: cur, len });
    if (clusters.length < 3) return { detected: false };
    const c0 = clusters[0], c1 = clusters[1], c2 = clusters[2];
    if (c2.len > c1.len && c1.len > c0.len && c0.len >= 2) {
        return { detected: true, prediction: c0.type === 'Tài' ? 'Xỉu' : 'Tài', confidence: Math.round(70 + c0.len * 2), name: `Cluster Ngắn Dần → Đảo`, patternId: 'cluster_break' };
    }
    if (c0.len > c1.len && c0.len > c2.len && c0.len >= 3) {
        return { detected: true, prediction: c0.type, confidence: Math.round(68 + c0.len), name: `Cluster Lớn Nhất → Tiếp`, patternId: 'cluster_break' };
    }
    return { detected: false };
}

function analyzeKelly(results) {
    if (results.length < 20) return { detected: false };
    const r20 = results.slice(0, 20);
    const pT = r20.filter(r => r === 'Tài').length / 20;
    const kelly = 2 * pT - 1;
    if (Math.abs(kelly) > 0.25) {
        const pred = kelly > 0 ? 'Tài' : 'Xỉu';
        return { detected: true, prediction: pred, confidence: Math.round(60 + Math.abs(kelly) * 60), name: `Kelly → ${pred}`, patternId: 'kelly_criterion' };
    }
    return { detected: false };
}

function analyzeXuHuongManh(results) {
    if (results.length < 8) return { detected: false };
    const r8 = results.slice(0, 8);
    const t = r8.filter(r => r === 'Tài').length;
    if (t >= 6) return { detected: true, prediction: 'Xỉu', confidence: Math.min(92, 80 + t * 2), name: `Xu Hướng Mạnh ${t}/8 → Xỉu`, patternId: 'xu_huong_manh' };
    if (t <= 2) return { detected: true, prediction: 'Tài', confidence: Math.min(92, 80 + (8 - t) * 2), name: `Xu Hướng Mạnh ${8 - t}/8 → Tài`, patternId: 'xu_huong_manh' };
    return { detected: false };
}

// =================================================================================================
// 🎯 CALCULATE PREDICTION WITH CAU + ANTI-LOSS
// =================================================================================================
function calculatePrediction(data, type, antiLossKey) {
    const last50 = data.slice(0, 50);
    const results = last50.map(d => d.Ket_qua);
    const state = getAntiLossState(antiLossKey);
    _ensureV2StateFields(state);

    // Daily cap check first
    const dailyCheck = _checkDailyCap();
    if (dailyCheck.capped) {
        return buildSkipResult(data, dailyCheck.reason, { dailyCap: true });
    }

    // Hard stop cooldown
    if (state.hardStopActive) {
        if (state.hardStopCooldown > 0) {
            state.hardStopCooldown--;
            return buildSkipResult(data, `HARD STOP cooldown ${state.hardStopCooldown} phiên`, { hardStop: true });
        }
        state.recoveryMode = true;
        state.recoveryWins = 0;
        state.hardStopConfirmWinsNeeded = ANTI_LOSS_V2.HARD_STOP_CONFIRM_WINS;
        state.hardStopActive = false;
    }

    // Recovery mode - cho bet nhưng floor cao
    if (state.recoveryMode) {
        // Vẫn cho bet nhưng dùng confidence floor cao
    }

    // 🔥 DETECT CẦU TRƯỚC
    const cauInfo = detectCauType(results);

    // Chạy các analyzer
    const markovChain = buildMarkovChain(results, 5);
    let predictions = [];
    let factors = [];

    const markovRes = predictMarkov(results, markovChain);
    if (markovRes.detected) predictions.push({ ...markovRes, priority: 16, weight: 2.0 });

    const entropyRes = analyzeEntropy(results);
    if (entropyRes.detected) predictions.push({ ...entropyRes, priority: 15, weight: 1.6 });

    const momentumRes = analyzeMomentum(last50);
    if (momentumRes.detected) predictions.push({ ...momentumRes, priority: 14, weight: 1.4 });

    const bayesRes = analyzeBayesian(results);
    if (bayesRes.detected) predictions.push({ ...bayesRes, priority: 13, weight: 1.8 });

    const clusterRes = analyzeClusterBreak(results);
    if (clusterRes.detected) predictions.push({ ...clusterRes, priority: 12, weight: 1.3 });

    const kellyRes = analyzeKelly(results);
    if (kellyRes.detected) predictions.push({ ...kellyRes, priority: 11, weight: 1.5 });

    const xuHuongRes = analyzeXuHuongManh(results);
    if (xuHuongRes.detected) predictions.push({ ...xuHuongRes, priority: 10, weight: 1.3 });

    // Tính score
    let taiScore = 0, xiuScore = 0;
    for (const p of predictions) {
        const score = (p.confidence || 60) * (p.priority || 5) * (p.weight || 1.0);
        if (p.prediction === 'Tài') taiScore += score; else xiuScore += score;
    }

    let finalPrediction = taiScore >= xiuScore ? 'Tài' : 'Xỉu';
    let baseConfidence = 60;

    // Confidence từ agreement
    const agreeT = predictions.filter(p => p.prediction === 'Tài').length;
    const agreeX = predictions.filter(p => p.prediction === 'Xỉu').length;
    const total = agreeT + agreeX;
    if (total > 0) {
        const dominant = Math.max(agreeT, agreeX);
        baseConfidence = Math.round(55 + (dominant / total) * 25);
    }

    // 🔥 ÁP DỤNG CẦU - QUYẾT ĐỊNH CAO NHẤT
    const cauResult = checkCauAndBreak(antiLossKey, cauInfo, finalPrediction, results, state);
    if (cauResult.action === 'BET' && cauResult.prediction) {
        // Cầu có ưu tiên cao hơn hẳn
        if (cauInfo.detected && cauInfo.confidence >= 65) {
            finalPrediction = cauResult.prediction;
            baseConfidence = Math.max(baseConfidence, cauInfo.confidence);
            factors.unshift(cauResult.reason);
            log(`[CAU] ${cauResult.reason} → ${finalPrediction} (${cauInfo.confidence}%)`);
        }
    }

    // 🔥 ANTI-LOSS V2 GUARDS
    const dynamicFloor = ANTI_LOSS_V2.CONFIDENCE_FLOOR_BY_LOSS[Math.min(state.consecutiveLoss, 4)] || 55;
    let finalConfidence = Math.max(dynamicFloor, baseConfidence);

    // Recovery mode floor cao
    if (state.recoveryMode) {
        finalConfidence = Math.max(70, finalConfidence);
        factors.push(`Recovery ${state.recoveryWins}/${state.hardStopConfirmWinsNeeded} wins`);
    }

    // Cross-check top-2 layer
    if (predictions.length >= 2) {
        const sorted = [...predictions].sort((a, b) => (b.priority * b.weight) - (a.priority * a.weight));
        if (sorted[0].prediction !== sorted[1].prediction) {
            finalConfidence -= ANTI_LOSS_V2.CROSS_CHECK_PENALTY;
            factors.push(`Cross-check: Top-2 lệch`);
        }
    }

    // Force reverse nếu loss >= 2
    let forceReversed = false;
    if (state.consecutiveLoss >= ANTI_LOSS.FORCE_REVERSE_AT) {
        // Cần confirm từ strong layers
        const strongPatterns = predictions.filter(p => ANTI_LOSS_V2.REVERSE_STRONG_LAYERS.includes(p.patternId));
        const reverseDir = finalPrediction === 'Tài' ? 'Xỉu' : 'Tài';
        const reverseVotes = strongPatterns.filter(p => p.prediction === reverseDir).length;
        const required = ANTI_LOSS_V2.SAFE_MODE ? ANTI_LOSS_V2.SAFE_MODE_REVERSE_CONFIRM : ANTI_LOSS_V2.REVERSE_MIN_LAYERS_CONFIRM;

        if (reverseVotes >= required) {
            finalPrediction = reverseDir;
            finalConfidence = Math.min(82, finalConfidence + 8);
            forceReversed = true;
            state.forceReverseCount++;
            state.lastForcedAt = new Date().toISOString();
            factors.push(`FORCE REVERSE (${reverseVotes} layer)`);
            log(`[V2] 🔄 FORCE REVERSE → ${finalPrediction}`);
        } else {
            // Không đủ confirm → SKIP
            return buildSkipResult(data, `FORCE REVERSE cần ${required} layer, chỉ có ${reverseVotes} → SKIP`, { reverseRejected: true, cau: cauResult.cau });
        }
    }

    // Dynamic skip window
    const recent = state.recentResults.slice(-ANTI_LOSS_V2.SKIP_WINDOW_SIZE);
    if (recent.length >= ANTI_LOSS_V2.SKIP_WINDOW_SIZE) {
        const lossCount = recent.filter(r => r === false).length;
        if (lossCount >= ANTI_LOSS_V2.SKIP_TRIGGER_LOSSES_IN_WINDOW) {
            return buildSkipResult(data, `Dynamic Skip: ${lossCount}/${ANTI_LOSS_V2.SKIP_WINDOW_SIZE} phiên gần sai`, { dynamicSkip: true, cau: cauResult.cau });
        }
    }

    // Pattern conflict check
    const totalScore = taiScore + xiuScore;
    if (totalScore > 0) {
        const diff = Math.abs(taiScore - xiuScore) / totalScore;
        if (diff < ANTI_LOSS_V2.CONFLICT_BALANCE_THRESHOLD) {
            return buildSkipResult(data, `Pattern cân bằng ${(diff * 100).toFixed(1)}% → SKIP`, { conflict: true, cau: cauResult.cau });
        }
    }

    // Confidence cap
    finalConfidence = Math.max(ANTI_LOSS.MIN_CONFIDENCE, Math.min(ANTI_LOSS.MAX_CONFIDENCE, Math.round(finalConfidence)));

    // Final floor check
    if (finalConfidence < dynamicFloor) {
        return buildSkipResult(data, `Confidence ${finalConfidence}% < floor ${dynamicFloor}%`, { floor: dynamicFloor, cau: cauResult.cau });
    }

    // Save state cho lần sau
    state.lastCauType = { type: cauInfo.type, predicted: finalPrediction, detectedAt: Date.now() };

    return buildBetResult(data, finalPrediction, finalConfidence, factors, {
        forceReversed,
        cau: cauResult.cau,
        state: {
            consecutiveLoss: state.consecutiveLoss,
            consecutiveWin: state.consecutiveWin,
            recovery: state.recoveryMode,
            cauBreakCount: state.cauBreakCount,
        },
        taiScore, xiuScore,
    });
}

function buildBetResult(data, prediction, confidence, factors, extra) {
    const phienHT = data[0]?.Phien ?? null;
    const phienDoan = (typeof phienHT === 'number') ? phienHT + 1 : (phienHT ? `${phienHT}_next` : null);

    return {
        action: 'BET',
        prediction,
        confidence,
        phienPhanTich: phienHT,
        phienDoan,
        reason: factors[0] || `Dự đoán ${prediction}`,
        factors: factors.slice(0, 3),
        ...extra,
    };
}

function buildSkipResult(data, reason, extra) {
    const phienHT = data[0]?.Phien ?? null;
    const phienDoan = (typeof phienHT === 'number') ? phienHT + 1 : (phienHT ? `${phienHT}_next` : null);

    return {
        action: 'SKIP',
        prediction: 'SKIP',
        confidence: 0,
        phienPhanTich: phienHT,
        phienDoan,
        reason: reason,
        factors: [reason],
        ...extra,
    };
}

// =================================================================================================
// 🎯 COMPACT JSON RESPONSE - CHỈ CÓ NHỮNG FIELD YÊU CẦU
// =================================================================================================
function buildCompactResponse(data, result) {
    const phienHT = (data && data[0] && data[0].Phien != null) ? data[0].Phien : null;
    let phienDoan = null;
    if (phienHT != null) {
        if (typeof phienHT === 'number') phienDoan = phienHT + 1;
        else if (/^\d+$/.test(String(phienHT))) phienDoan = parseInt(phienHT, 10) + 1;
        else phienDoan = `${phienHT}_next`;
    }

    const phienNow = data && data[0] ? data[0] : {};
    const isSkip = result.action === 'SKIP' || result.prediction === 'SKIP';

    return {
        phien: phienHT,
        ketQua: phienNow.Ket_qua || null,
        tong: (typeof phienNow.Tong === 'number') ? phienNow.Tong : null,
        phienDoan: phienDoan,
        duDoan: isSkip ? 'SKIP' : result.prediction,
        tiLe: isSkip ? '0%' : `${result.confidence}%`,
    };
}

// =================================================================================================
// WORKERS
// =================================================================================================
function worker_geightdors(game_id, platform_id, table, gid, is_md5) {
    const url = `https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=${platform_id}&gid=${gid}`;
    let last_sid = null, sid_for_tx = null;
    const poll = async () => {
        if (!GAME_STATUS[game_id]) { setTimeout(poll, 2000); return; }
        try {
            const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
            const data = res.data;
            if (data && data.status === 'OK' && Array.isArray(data.data)) {
                if (!is_md5) for (const g of data.data) if (g.cmd === 1008) sid_for_tx = g.sid;
                for (const g of data.data) {
                    if (is_md5 && g.cmd === 2006) {
                        const { sid, d1, d2, d3 } = g;
                        if (sid && sid !== last_sid && d1 != null && d2 != null && d3 != null) {
                            last_sid = sid;
                            add_record(game_id, table, { phien: sid, xuc_xac: [d1, d2, d3], tong: d1 + d2 + d3, ket_qua: get_tai_xiu(d1, d2, d3) });
                        }
                    } else if (!is_md5 && g.cmd === 1003) {
                        const { d1, d2, d3 } = g;
                        if (sid_for_tx && sid_for_tx !== last_sid && d1 != null && d2 != null && d3 != null) {
                            last_sid = sid_for_tx;
                            add_record(game_id, table, { phien: last_sid, xuc_xac: [d1, d2, d3], tong: d1 + d2 + d3, ket_qua: get_tai_xiu(d1, d2, d3) });
                            sid_for_tx = null;
                        }
                    }
                }
            }
        } catch (e) {}
        setTimeout(poll, 3000);
    };
    poll();
}

function worker_wtx(game_id, table, url) {
    let last_sid = null;
    const poll = async () => {
        if (!GAME_STATUS[game_id]) { setTimeout(poll, 2000); return; }
        try {
            const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
            const data = res.data;
            if (data && data.list && data.list.length > 0) {
                const s = data.list[0];
                const sid = s.id, dices = s.dices || [];
                if (sid && sid !== last_sid && dices.length === 3) {
                    last_sid = sid;
                    const tong = dices.reduce((a, b) => a + b, 0);
                    add_record(game_id, table, { phien: sid, xuc_xac: dices, tong, ket_qua: get_tai_xiu(dices[0], dices[1], dices[2]) });
                }
            }
        } catch (e) {}
        setTimeout(poll, 3000);
    };
    poll();
}

function worker_68gb(table, api_url) {
    let last_sid = null;
    const poll = async () => {
        if (!GAME_STATUS["68gb"]) { setTimeout(poll, 2000); return; }
        try {
            const res = await axios.get(api_url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 5000 });
            const r = res.data;
            const sid = r.Phien;
            if (sid && sid !== last_sid) {
                last_sid = sid;
                const d = [r.Xuc_xac_1, r.Xuc_xac_2, r.Xuc_xac_3];
                add_record("68gb", table, { phien: sid, xuc_xac: d, tong: d.reduce((a, b) => a + b, 0), ket_qua: get_tai_xiu(d[0], d[1], d[2]) });
            }
        } catch (e) {}
        setTimeout(poll, 2000);
    };
    poll();
}

function worker_luck8(table, api_url) {
    let last_sid = null;
    const poll = async () => {
        if (!GAME_STATUS["luck8"]) { setTimeout(poll, 2000); return; }
        try {
            const res = await axios.get(api_url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 5000 });
            const r = res.data;
            if (r && r.state === 1 && r.data) {
                const d = r.data;
                const sid = d.ID;
                const codes = (d.OpenCode || '').split(',');
                if (sid && sid !== last_sid && codes.length === 3) {
                    last_sid = sid;
                    const dices = codes.map(Number);
                    add_record("luck8", table, { phien: sid, xuc_xac: dices, tong: dices.reduce((a, b) => a + b, 0), ket_qua: get_tai_xiu(dices[0], dices[1], dices[2]) });
                }
            }
        } catch (e) {}
        setTimeout(poll, 2000);
    };
    poll();
}

function worker_789club_live() {
    const ws_url = "wss://ws-taixiu-ls.atpman.net/websocket";
    let ws, ka = null;
    const connect = () => {
        if (!GAME_STATUS["789club"]) { setTimeout(connect, 2000); return; }
        try {
            ws = new WebSocket(ws_url);
            ws.on('open', () => {
                log('789club Live WS connected');
                ka = setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.ping(); else if (ka) { clearInterval(ka); ka = null; } }, 30000);
            });
            ws.on('message', (msg) => {
                try {
                    const data = JSON.parse(msg);
                    if (Array.isArray(data) && data.length >= 2 && data[0] === 5) {
                        const gd = data[1];
                        if (gd.sessionId && (gd.resultRaw || gd.aM)) {
                            const ds = String(gd.resultRaw || gd.aM);
                            if (ds.length === 3 && /^\d+$/.test(ds)) {
                                const d = [parseInt(ds[0]), parseInt(ds[1]), parseInt(ds[2])];
                                add_record("789club", "live", { phien: gd.sessionId, xuc_xac: d, tong: d.reduce((a, b) => a + b, 0), ket_qua: get_tai_xiu(d[0], d[1], d[2]) });
                            }
                        }
                    }
                } catch (e) {}
            });
            ws.on('close', () => { log('789club Live WS disconn'); if (ka) { clearInterval(ka); ka = null; } setTimeout(connect, 5000); });
            ws.on('error', (err) => { logError('789club Live WS:', err); try { ws.close(); } catch (e) {} });
        } catch (e) { setTimeout(connect, 5000); }
    };
    connect();
}

function worker_789club_minigame() {
    const WS_URL = "wss://websocket.atpman.net/websocket";
    const HEADERS = { "Origin": "https://play.789club.wien", "User-Agent": "Mozilla/5.0" };
    const LOGIN_MSG = [1, "MiniGame", "wanglin2019aaand", "WamgLin2091", { "info": JSON.stringify({ "ipAddress": "113.185.45.88", "wsToken": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJlbXlldTE3ODljbHVuIiwiYm90IjowLCJpc01lcmNoYW50IjpmYWxzZSwidmVyaWZpZWRCYW5rQWNjb3VudCI6ZmFsc2UsInBsYXlFdmVudExvYmJ5IjpmYWxzZSwiY3VzdG9tZXJJZCI6NjU3NjU3NjksImFmZklkIjoiNzg5IiwiYmFubmVkIjpmYWxzZSwiYnJhbmQiOiI3ODkuY2x1YiIsInRpbWVzdGFtcCI6MTc2NjQ3MDk1NTY4OCwibG9ja0dhbWVzIjpbXSwiYW1vdW50IjowLCJsb2NrQ2hhdCI6ZmFsc2UsInBob25lVmVyaWZpZWQiOmZhbHNlLCJpcEFkZHJlc3MiOiIxMTMuMTg1LjQ1Ljg4IiwibXV0ZSI6ZmFsc2UsImF2YXRhciI6Imh0dHBzOi8vYXBpLnhldWkuaW8vaW1hZ2VzL2F2YXRhci9hdmF0YXJfMjUucG5nIiwicGxhdGZvcm1JZCI6NSwidXNlcklkIjoiMjFkMTUxMjEtYjIzOC00ZDIyLTgzMTMtNGI3YjYwN2VhZjIxIiwicmVnVGltZSI6MTc2NjQ3MDkzMDEwNCwicGhvbmUiOiIiLCJkZXBvc2l0IjpmYWxzZSwidXNlcm5hbWUiOiJTOF93YW5nbGluMjAxOWFhYW5kIn0.F5jr6g1BPGMQ-5EPRdck-PDvVDXcahyGySOFSjyNEuE", "locale": "vi", "userId": "21d15121-b238-4d22-8313-4b7b607eaf21", "username": "S8_wanglin2019aaand", "timestamp": 1766470955689, "refreshToken": "34ed90232de44567aec7d4752b021717.e8cd9e15f74c42fb8bd491e395d73ab1" }), "signature": "55A3202A0554F20C01D09CD018386265C93B292E843BE3722766912A8F01ACF50E9574D88D52FAFDABEBD4794D3306C87021EF3DD6B25DA102872D23C7C31A0F1D3EB99C0714968A64F6C40335726EB999F1CEAE49BC0954EABA48189E1BBE61BD40C898CA4D683DA76E24386F4431772D05BC8142DAEBFA90E27A9C250A5ED3" }];
    const SUBSCRIBE_TX = [6, "MiniGame", "taixiuCommonPlugin", { "cmd": 2100 }];
    const SUBSCRIBE_LOBBY = [6, "MiniGame", "lobbyPlugin", { "cmd": 10001 }];
    let ws, ka = null;
    const connect = () => {
        if (!GAME_STATUS["789club"]) { setTimeout(connect, 2000); return; }
        try {
            ws = new WebSocket(WS_URL, { headers: HEADERS });
            ws.on('open', () => {
                log('789club MiniGame WS connected');
                ws.send(JSON.stringify(LOGIN_MSG));
                setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(SUBSCRIBE_TX)); ws.send(JSON.stringify(SUBSCRIBE_LOBBY)); }
                }, 1000);
                ka = setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) { ws.send("2"); ws.send(JSON.stringify(SUBSCRIBE_TX)); } else if (ka) { clearInterval(ka); ka = null; } }, 10000);
            });
            ws.on('message', (msg) => {
                try {
                    const data = JSON.parse(msg);
                    if (Array.isArray(data) && data.length >= 2 && typeof data[1] === 'object' && data[1].cmd === 2106) {
                        const { sid, d1, d2, d3 } = data[1];
                        if (sid && d1 && d2 && d3) add_record("789club", "minigame", { phien: sid, xuc_xac: [d1, d2, d3], tong: d1 + d2 + d3, ket_qua: get_tai_xiu(d1, d2, d3) });
                    }
                } catch (e) {}
            });
            ws.on('close', () => { log('789club MiniGame WS disconn'); if (ka) { clearInterval(ka); ka = null; } setTimeout(connect, 5000); });
            ws.on('error', (err) => { logError('789club MiniGame WS:', err); try { ws.close(); } catch (e) {} });
        } catch (e) { setTimeout(connect, 5000); }
    };
    connect();
}

function worker_sunwin() {
    const WS_URL = "wss://websocket.azhkthg1.net/websocket?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhbW91bnQiOjAsInVzZXJuYW1lIjoiU0NfYXBpc3Vud2luMTIzIn0.hgrRbSV6vnBwJMg9ZFtbx3rRu9mX_hZMZ_m5gMNhkw0";
    const HEADERS = { "Origin": "https://play.sun.win" };
    const INIT_MSGS = [
        [1, "MiniGame", "GM_apivopnhaan", "WangLin", { "info": JSON.stringify({ "ipAddress": "113.185.45.88", "wsToken": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJwbGFtYW1hIiwiYm90IjowLCJpc01lcmNoYW50IjpmYWxzZSwidmVyaWZpZWRCYW5rQWNjb3VudCI6ZmFsc2UsInBsYXlFdmVudExvYmJ5IjpmYWxzZSwiY3VzdG9tZXJJZCI6MzMxNDgxMTYyLCJhZmZJZCI6IkdFTVdJTiIsImJhbm5lZCI6ZmFsc2UsImJyYW5kIjoiZ2VtIiwidGltZXN0YW1wIjoxNzY2NDc0NzgwMDA2LCJsb2NrR2FtZXMiOltdLCJhbW91bnQiOjAsImxvY2tDaGF0IjpmYWxzZSwicGhvbmVWZXJpZmllZCI6ZmFsc2UsImlwQWRkcmVzcyI6IjExMy4xODUuNDUuODgiLCJtdXRlIjpmYWxzZSwiYXZhdGFyIjoiaHR0cHM6Ly9pbWFnZXMuc3dpbnNob3AubmV0L2ltYWdlcy9hdmF0YXIvYXZhdGFyXzE4LnBuZyIsInBsYXRmb3JtSWQiOjUsInVzZXJJZCI6IjZhOGI0ZDM4LTFlYzEtNDUxYi1hYTA1LWYyZDkwYWFhNGM1MCIsInJlZ1RpbWUiOjE3NjY0NzQ3NTEzOTEsInBob25lIjoiIiwiZGVwb3NpdCI6ZmFsc2UsInVzZXJuYW1lIjoiR01fYXBpdm9wbmhhYW4ifQ.YFOscbeojWNlRo7490BtlzkDGYmwVpnlgOoh04oCJy4", "locale": "vi", "userId": "6a8b4d38-1ec1-451b-aa05-f2d90aaa4c50", "username": "GM_apivopnhaan", "timestamp": 1766474780007, "refreshToken": "63d5c9be0c494b74b53ba150d69039fd.7592f06d63974473b4aaa1ea849b2940" }), "signature": "66772A1641AA8B18BD99207CE448EA00ECA6D8A4D457C1FF13AB092C22C8DECF0C0014971639A0FBA9984701A91FCCBE3056ABC1BE1541D1C198AA18AF3C45595AF6601F8B048947ADF8F48A9E3E074162F9BA3E6C0F7543D38BD54FD4C0A2C56D19716CC5353BBC73D12C3A92F78C833F4EFFDC4AB99E55C77AD2CDFA91E296" }],
        [6, "MiniGame", "taixiuPlugin", { "cmd": 1005 }],
        [6, "MiniGame", "lobbyPlugin", { "cmd": 10001 }]
    ];
    let ws, current_sid = null, ka = null;
    const connect = () => {
        if (!GAME_STATUS["sunwin"]) { setTimeout(connect, 2000); return; }
        try {
            ws = new WebSocket(WS_URL, { headers: HEADERS });
            ws.on('open', async () => {
                log('Sunwin WS connected');
                for (const m of INIT_MSGS) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); await new Promise(r => setTimeout(r, 600)); }
                ka = setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.ping(); else if (ka) { clearInterval(ka); ka = null; } }, 30000);
            });
            ws.on('message', (msg) => {
                try {
                    const data = JSON.parse(msg);
                    if (!Array.isArray(data)) return;
                    let cmd = null, payload = null;
                    if (data.length > 1 && typeof data[1] === 'object') { payload = data[1]; cmd = payload.cmd; }
                    else if (data.length > 2 && typeof data[2] === 'object') { payload = data[2]; cmd = payload.cmd; }
                    if (cmd === 1008 && payload?.sid) current_sid = payload.sid;
                    else if (cmd === 1003 && payload) {
                        const { d1, d2, d3 } = payload;
                        if (d1 != null && d2 != null && d3 != null) {
                            add_record("sunwin", "main", { phien: current_sid || payload.sid, xuc_xac: [d1, d2, d3], tong: d1 + d2 + d3, ket_qua: get_tai_xiu(d1, d2, d3) });
                            current_sid = null;
                        }
                    }
                } catch (e) {}
            });
            ws.on('close', () => { log('Sunwin WS disconn'); if (ka) { clearInterval(ka); ka = null; } setTimeout(connect, 3000); });
            ws.on('error', (err) => { logError('Sunwin WS:', err); try { ws.close(); } catch (e) {} });
        } catch (e) { setTimeout(connect, 3000); }
    };
    connect();
}

function worker_sumclub() {
    const SERVERS = [
        { base: "https://taixiu.apisum.pro", hub: "luckydiceHub", tid: 1, table: "hu" },
        { base: "https://taixiu1.apisum.pro", hub: "luckydice1Hub", tid: 2, table: "md5" }
    ];
    const HEADERS = { "User-Agent": "Mozilla/5.0", "Origin": "https://play.sum.vin" };
    SERVERS.forEach(sv => {
        const connect = async () => {
            if (!GAME_STATUS["sumclub"]) { setTimeout(connect, 2000); return; }
            try {
                const negUrl = `${sv.base}/signalr/negotiate?clientProtocol=1.5`;
                const negRes = await axios.get(negUrl, { headers: HEADERS, timeout: 5000 });
                const token = negRes.data.ConnectionToken;
                if (!token) { setTimeout(connect, 3000); return; }
                const wsUrl = `${sv.base.replace('https', 'wss')}/signalr/connect?transport=webSockets&connectionToken=${encodeURIComponent(token)}&connectionData=${encodeURIComponent(JSON.stringify([{ name: sv.hub }]))}&clientProtocol=1.5&tid=${sv.tid}`;
                const ws = new WebSocket(wsUrl, { headers: HEADERS });
                let ka = null;
                ws.on('open', () => {
                    log(`Sumclub ${sv.table} WS connected`);
                    ws.send(JSON.stringify([1, "MiniGame", "GM_apivopnha", "tiendat", { info: "{}", signature: "" }]));
                    ws.send(JSON.stringify([6, "MiniGame", "taixiuPlugin", { cmd: 1005 }]));
                    ka = setInterval(() => { if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ M: "PingPong", H: sv.hub, I: Date.now() })); ws.send('{"type":6}'); } else if (ka) { clearInterval(ka); ka = null; } }, 5000);
                });
                ws.on('message', (msg) => {
                    try {
                        const data = JSON.parse(msg);
                        for (const m of data.M || []) {
                            if (m.M === "sessionInfo" && m.A) {
                                const res = m.A[0].Result || {};
                                const d1 = res.Dice1 || 0, d2 = res.Dice2 || 0, d3 = res.Dice3 || 0;
                                if (d1 > 0 && d2 > 0 && d3 > 0) {
                                    add_record("sumclub", sv.table, { phien: m.A[0].SessionID, xuc_xac: [d1, d2, d3], tong: d1 + d2 + d3, ket_qua: get_tai_xiu(d1, d2, d3) });
                                }
                            }
                        }
                    } catch (e) {}
                });
                ws.on('close', () => { log(`Sumclub ${sv.table} WS disconn`); if (ka) { clearInterval(ka); ka = null; } setTimeout(connect, 3000); });
                ws.on('error', (err) => { logError(`Sumclub ${sv.table} WS:`, err); try { ws.close(); } catch (e) {} });
            } catch (e) { setTimeout(connect, 3000); }
        };
        connect();
    });
}

function start_all_workers() {
    log("Starting all workers...");
    worker_geightdors("b52", "b5", "hu", "vgmn_100", false);
    worker_geightdors("b52", "b5", "md5", "vgmn_101", true);
    worker_geightdors("hitclub", "g8", "hu", "vgmn_100", false);
    worker_geightdors("hitclub", "g8", "md5", "vgmn_101", true);
    worker_geightdors("rikvip", "rik", "hu", "vgmn_100", false);
    worker_geightdors("rikvip", "rik", "md5", "vgmn_101", true);
    worker_wtx("betvip", "hu", "https://wtx.macminim6.online/v1/tx/sessions");
    worker_wtx("betvip", "md5", "https://wtxmd52.macminim6.online/v1/txmd5/sessions");
    worker_wtx("lc79", "hu", "https://wtx.tele68.com/v1/tx/sessions");
    worker_wtx("lc79", "md5", "https://wtxmd52.tele68.com/v1/txmd5/sessions");
    worker_68gb("hu", "http://160.250.5.186:3201/api/68/xanh");
    worker_68gb("md5", "http://160.250.5.186:3050/api/68/md5");
    worker_luck8("txhu", "https://luck8bot.com/api/GetNewLottery/Taixiu");
    worker_luck8("txmd5", "https://luck8bot.com/api/GetNewLottery/TaixiuMd5");
    worker_luck8("tx3p", "https://luck8bot.com/api/GetNewLottery/TaixiuMd3");
    worker_789club_live();
    worker_789club_minigame();
    worker_sunwin();
    worker_sumclub();
    log("All workers started.");
}

// =================================================================================================
// LC79 API FETCH
// =================================================================================================
const LC79_API_URL_HU = 'https://wtx.tele68.com/v1/tx/sessions';
const LC79_API_URL_MD5 = 'https://wtxmd52.tele68.com/v1/txmd5/sessions';

function transformLC79(apiData) {
    if (!apiData || !apiData.list || !Array.isArray(apiData.list)) return null;
    return apiData.list.map(item => ({
        Phien: item.id,
        Ket_qua: item.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu',
        Xuc_xac_1: item.dices[0], Xuc_xac_2: item.dices[1], Xuc_xac_3: item.dices[2],
        Tong: item.point
    }));
}

async function fetchLC79Hu() { try { return transformLC79((await axios.get(LC79_API_URL_HU, { timeout: 10000 })).data); } catch (e) { return null; } }
async function fetchLC79Md5() { try { return transformLC79((await axios.get(LC79_API_URL_MD5, { timeout: 10000 })).data); } catch (e) { return null; } }

// =================================================================================================
// AUTO VERIFY - CẬP NHẬT STATE KHI CÓ KẾT QUẢ MỚI
// =================================================================================================
const LAST_PREDICTION = {}; // key -> { phien, prediction, action }

async function autoVerifyLoop() {
    setInterval(async () => {
        try {
            // Verify LC79 HU
            const hu = await fetchLC79Hu();
            if (hu && hu.length > 0) {
                const p = LAST_PREDICTION['lc79_hu'];
                if (p && p.action === 'BET') {
                    const actual = hu.find(d => String(d.Phien) === String(p.phien));
                    if (actual) {
                        updateAntiLossState('lc79_hu', p.prediction, actual.Ket_qua, p.phien);
                        delete LAST_PREDICTION['lc79_hu'];
                    }
                }
            }
            // Verify LC79 MD5
            const md5 = await fetchLC79Md5();
            if (md5 && md5.length > 0) {
                const p = LAST_PREDICTION['lc79_md5'];
                if (p && p.action === 'BET') {
                    const actual = md5.find(d => String(d.Phien) === String(p.phien));
                    if (actual) {
                        updateAntiLossState('lc79_md5', p.prediction, actual.Ket_qua, p.phien);
                        delete LAST_PREDICTION['lc79_md5'];
                    }
                }
            }
            // Verify các game khác từ DATA_STORE
            for (const game in DATA_STORE) {
                for (const table in DATA_STORE[game]) {
                    const key = `${game}_${table}`;
                    const p = LAST_PREDICTION[key];
                    if (!p || p.action !== 'BET') continue;
                    const arr = DATA_STORE[game][table];
                    const actual = arr.find(d => String(d.phien) === String(p.phien));
                    if (actual) {
                        updateAntiLossState(key, p.prediction, actual.ket_qua || actual.Ket_qua, p.phien);
                        delete LAST_PREDICTION[key];
                    }
                }
            }
        } catch (e) { logError('[AutoVerify]', e); }
    }, 5000);
}

// =================================================================================================
// EXPRESS APP
// =================================================================================================
const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'all_in_one_v6', idol: '@tranhoang2286', uptime: process.uptime() });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), memory: process.memoryUsage() });
});

app.get('/api/games', (req, res) => {
    const games = [];
    for (const game in DATA_STORE) {
        for (const table in DATA_STORE[game]) {
            const arr = DATA_STORE[game][table];
            if (arr.length > 0) {
                games.push({ game, table, count: arr.length, latest: arr[0] ? { phien: arr[0].phien, ketQua: arr[0].ket_qua || arr[0].Ket_qua, tong: arr[0].tong || arr[0].Tong } : null });
            }
        }
    }
    res.json({ total: games.length, games });
});

// 🎯 ENDPOINT CHÍNH - COMPACT JSON
app.get('/api/predict/:game/:table', async (req, res) => {
    try {
        const { game, table } = req.params;
        let data = DATA_STORE[game]?.[table];

        if (game === 'lc79') {
            const fetched = table === 'hu' ? await fetchLC79Hu() : await fetchLC79Md5();
            if (fetched && fetched.length > 0) data = fetched;
        }

        if (!data || data.length === 0) {
            return res.status(404).json({ phien: null, ketQua: null, tong: null, phienDoan: null, duDoan: 'NO_DATA', tiLe: '0%' });
        }

        const key = `${game}_${table}`;
        const result = calculatePrediction(data, key, key);

        // Lưu prediction để verify
        if (result.action === 'BET' && result.phienDoan != null) {
            LAST_PREDICTION[key] = { phien: result.phienDoan, prediction: result.prediction, action: 'BET' };
        }

        res.json(buildCompactResponse(data, result));
    } catch (e) {
        logError('[API predict]', e);
        res.status(500).json({ phien: null, ketQua: null, tong: null, phienDoan: null, duDoan: 'ERROR', tiLe: '0%' });
    }
});

// Route cũ cho LC79
app.get('/predict/:type', async (req, res) => {
    try {
        const type = req.params.type;
        if (type !== 'hu' && type !== 'md5') {
            return res.status(400).json({ phien: null, ketQua: null, tong: null, phienDoan: null, duDoan: 'BAD_TYPE', tiLe: '0%' });
        }
        const data = type === 'hu' ? await fetchLC79Hu() : await fetchLC79Md5();
        if (!data || data.length === 0) {
            return res.status(404).json({ phien: null, ketQua: null, tong: null, phienDoan: null, duDoan: 'NO_DATA', tiLe: '0%' });
        }
        const key = `lc79_${type}`;
        const result = calculatePrediction(data, type, key);
        if (result.action === 'BET' && result.phienDoan != null) {
            LAST_PREDICTION[key] = { phien: result.phienDoan, prediction: result.prediction, action: 'BET' };
        }
        res.json(buildCompactResponse(data, result));
    } catch (e) {
        logError('[API predict type]', e);
        res.status(500).json({ phien: null, ketQua: null, tong: null, phienDoan: null, duDoan: 'ERROR', tiLe: '0%' });
    }
});

// Admin endpoints
app.post('/api/reset-state/:key', (req, res) => {
    const key = req.params.key;
    if (ANTI_LOSS_STATE[key]) { delete ANTI_LOSS_STATE[key]; return res.json({ status: 'ok' }); }
    res.json({ status: 'no_state' });
});

app.get('/api/daily', (req, res) => { _checkDailyReset(); res.json(DAILY_TRACKER); });

app.get('/api/state/:key', (req, res) => {
    const s = getAntiLossState(req.params.key);
    res.json({
        consecutiveLoss: s.consecutiveLoss, consecutiveWin: s.consecutiveWin,
        hardStopActive: s.hardStopActive, hardStopCooldown: s.hardStopCooldown,
        recoveryMode: s.recoveryMode, recoveryWins: s.recoveryWins,
        cauBreakCount: s.cauBreakCount, lastCauType: s.lastCauType,
    });
});

// =================================================================================================
// STARTUP
// =================================================================================================
function startAll() {
    log('========================================');
    log('🚀 ALL_IN_ONE_V6 - SMART CAU BREAK + COMPACT JSON');
    log('========================================');
    start_all_workers();
    autoVerifyLoop();
    app.listen(PORT, HOST, () => {
        log(`✅ Server: http://${HOST}:${PORT}`);
        log(`✅ Runtime: ${RUNTIME_DIR}`);
        log(`✅ Endpoints:`);
        log(`   GET /api/predict/:game/:table`);
        log(`   GET /predict/:type (hu|md5)`);
        log(`   GET /api/games`);
        log(`   GET /api/state/:key`);
        log(`   POST /api/reset-state/:key`);
        log('========================================');
    });
}

process.on('uncaughtException', (e) => logError('[UNCAUGHT]', e));
process.on('unhandledRejection', (e) => logError('[UNHANDLED]', e));

startAll();
