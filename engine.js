/*
 * engine.js - a from-scratch chess engine in plain JavaScript.
 * Works as a Node module (require('./engine.js')), as a browser <script>
 * (window.ChessEngine), and as a browser Web Worker (new Worker('engine.js')).
 *
 * Board: 0x88 mailbox with piece lists, incremental Zobrist hash + PeSTO PST.
 * Search: iterative deepening PVS, aspiration windows, transposition table,
 * null-move pruning, LMR, LMP, futility / reverse futility, SEE pruning,
 * killers, countermoves, history heuristic, check extension, quiescence.
 */
(function () {
'use strict';

const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
const MAX_PLY = 100;
const INF = 32000, MATE = 31000, MATE_BOUND = 30000;
const FLAG_EP = 1, FLAG_CASTLE = 2, FLAG_DOUBLE = 4;

const N_DIRS = [33, 31, 18, 14, -33, -31, -18, -14];
const B_DIRS = [15, 17, -15, -17];
const R_DIRS = [16, -16, 1, -1];
const K_DIRS = [15, 16, 17, 1, -1, -15, -16, -17];

// ---------------------------------------------------------------- state
const board = new Uint8Array(128);
let side = 0, castling = 0, epSq = -1, halfmove = 0, fullmove = 1;
let hashLo = 0, hashHi = 0;
const kingSq = new Int32Array(2);
const plist = new Int32Array(32);
const pcount = new Int32Array(2);
const pidx = new Int32Array(128);
const pieceCnt = new Int32Array(16);
const mgS = new Int32Array(2), egS = new Int32Array(2);
let phase = 0;

const HIST_MAX = 8192;
const histLo = new Int32Array(HIST_MAX), histHi = new Int32Array(HIST_MAX);
let histLen = 0;

const STACK = 1024;
const uCap = new Int32Array(STACK), uCastle = new Int32Array(STACK), uEp = new Int32Array(STACK),
  uHalf = new Int32Array(STACK), uLo = new Int32Array(STACK), uHi = new Int32Array(STACK);
let sp = 0;

// ---------------------------------------------------------------- zobrist
let seed = 0x9E3779B9 | 0;
function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; }
const zLo = new Int32Array(16 * 128), zHi = new Int32Array(16 * 128);
for (let i = 0; i < 16 * 128; i++) { zLo[i] = rnd(); zHi[i] = rnd(); }
const zCastleLo = new Int32Array(16), zCastleHi = new Int32Array(16);
for (let i = 0; i < 16; i++) { zCastleLo[i] = rnd(); zCastleHi[i] = rnd(); }
const zEpLo = new Int32Array(8), zEpHi = new Int32Array(8);
for (let i = 0; i < 8; i++) { zEpLo[i] = rnd(); zEpHi[i] = rnd(); }
const zSideLo = rnd(), zSideHi = rnd();

const castleMask = new Int32Array(128).fill(15);
castleMask[0] = 13; castleMask[4] = 12; castleMask[7] = 14;
castleMask[0x70] = 7; castleMask[0x74] = 3; castleMask[0x77] = 11;

// ---------------------------------------------------------------- PeSTO tables
const MG_VAL = [0, 82, 337, 365, 477, 1025, 0];
const EG_VAL = [0, 94, 281, 297, 512, 936, 0];
const PHASE_INC = [0, 0, 1, 1, 2, 4, 0];
const SEE_VAL = [0, 100, 320, 330, 500, 950, 20000];

const MG_T = [null,
 [0,0,0,0,0,0,0,0, 98,134,61,95,68,126,34,-11, -6,7,26,31,65,56,25,-20, -14,13,6,21,23,12,17,-23,
  -27,-2,-5,12,17,6,10,-25, -26,-4,-4,-10,3,3,33,-12, -35,-1,-20,-23,-15,24,38,-22, 0,0,0,0,0,0,0,0],
 [-167,-89,-34,-49,61,-97,-15,-107, -73,-41,72,36,23,62,7,-17, -47,60,37,65,84,129,73,44, -9,17,19,53,37,69,18,22,
  -13,4,16,13,28,19,21,-8, -23,-9,12,10,19,17,25,-16, -29,-53,-12,-3,-1,18,-14,-19, -105,-21,-58,-33,-17,-28,-19,-23],
 [-29,4,-82,-37,-25,-42,7,-8, -26,16,-18,-13,30,59,18,-47, -16,37,43,40,35,50,37,-2, -4,5,19,50,37,37,7,-2,
  -6,13,13,26,34,12,10,4, 0,15,15,15,14,27,18,10, 4,15,16,0,7,21,33,1, -33,-3,-14,-21,-13,-12,-39,-21],
 [32,42,32,51,63,9,31,43, 27,32,58,62,80,67,26,44, -5,19,26,36,17,45,61,16, -24,-11,7,26,24,35,-8,-20,
  -36,-26,-12,-1,9,-7,6,-23, -45,-25,-16,-17,3,0,-5,-33, -44,-16,-20,-9,-1,11,-6,-71, -19,-13,1,17,16,7,-37,-26],
 [-28,0,29,12,59,44,43,45, -24,-39,-5,1,-16,57,28,54, -13,-17,7,8,29,56,47,57, -27,-27,-16,-16,-1,17,-2,1,
  -9,-26,-9,-10,-2,-4,3,-3, -14,2,-11,-2,-5,2,14,5, -35,-8,11,2,8,15,-3,1, -1,-18,-9,10,-15,-25,-31,-50],
 [-65,23,16,-15,-56,-34,2,13, 29,-1,-20,-7,-8,-4,-38,-29, -9,24,2,-16,-20,6,22,-22, -17,-20,-12,-27,-30,-25,-14,-36,
  -49,-1,-27,-39,-46,-44,-33,-51, -14,-14,-22,-46,-44,-30,-15,-27, 1,7,-8,-64,-43,-16,9,8, -15,36,12,-54,8,-28,24,14]];
const EG_T = [null,
 [0,0,0,0,0,0,0,0, 178,173,158,134,147,132,165,187, 94,100,85,67,56,53,82,84, 32,24,13,5,-2,4,17,17,
  13,9,-3,-7,-7,-8,3,-1, 4,7,-6,1,0,-5,-1,-8, 13,8,8,10,13,0,2,-7, 0,0,0,0,0,0,0,0],
 [-58,-38,-13,-28,-31,-27,-63,-99, -25,-8,-25,-2,-9,-25,-24,-52, -24,-20,10,9,-1,-9,-19,-41, -17,3,22,22,22,11,8,-18,
  -18,-6,16,25,16,17,4,-18, -23,-3,-1,15,10,-3,-20,-22, -42,-20,-10,-5,-2,-20,-23,-44, -29,-51,-23,-15,-22,-18,-50,-64],
 [-14,-21,-11,-8,-7,-9,-17,-24, -8,-4,7,-12,-3,-13,-4,-14, 2,-8,0,-1,-2,6,0,4, -3,9,12,9,14,10,3,2,
  -6,3,13,19,7,10,-3,-9, -12,-3,8,10,13,3,-7,-15, -14,-18,-7,-1,4,-9,-15,-27, -23,-9,-23,-5,-9,-16,-5,-17],
 [13,10,18,15,12,12,8,5, 11,13,13,11,-3,3,8,3, 7,7,7,5,4,-3,-5,-3, 4,3,13,1,2,1,-1,2,
  3,5,8,4,-5,-6,-8,-11, -4,0,-5,-1,-7,-12,-8,-16, -6,-6,0,2,-9,-9,-11,-3, -9,2,3,-1,-5,-13,4,-20],
 [-9,22,22,27,27,19,10,20, -17,20,32,41,58,25,30,0, -20,6,9,49,47,35,19,9, 3,22,24,45,57,40,57,36,
  -18,28,19,47,31,34,39,23, -16,-27,15,6,9,17,10,5, -22,-23,-30,-16,-16,-23,-36,-32, -33,-28,-22,-43,-5,-32,-20,-41],
 [-74,-35,-18,-18,-11,15,4,-17, -12,17,14,17,17,38,23,11, 10,17,23,15,20,45,44,13, -8,22,24,27,26,33,26,3,
  -18,-4,21,24,27,23,9,-11, -19,-3,11,21,23,16,7,-9, -27,-11,4,13,14,4,-5,-17, -53,-34,-21,-11,-28,-14,-24,-43]];

const PST_MG = new Int32Array(16 * 128), PST_EG = new Int32Array(16 * 128);
for (let t = 1; t <= 6; t++) {
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) continue;
    const r = sq >> 4, f = sq & 7;
    const wi = (7 - r) * 8 + f, bi = r * 8 + f;
    PST_MG[t * 128 + sq] = MG_VAL[t] + MG_T[t][wi];
    PST_EG[t * 128 + sq] = EG_VAL[t] + EG_T[t][wi];
    PST_MG[(t | 8) * 128 + sq] = MG_VAL[t] + MG_T[t][bi];
    PST_EG[(t | 8) * 128 + sq] = EG_VAL[t] + EG_T[t][bi];
  }
}

// ---------------------------------------------------------------- piece ops
function addPiece(sq, p) {
  const c = p >> 3;
  board[sq] = p;
  const i = pcount[c]++;
  plist[c * 16 + i] = sq; pidx[sq] = i;
  pieceCnt[p]++;
  hashLo ^= zLo[p * 128 + sq]; hashHi ^= zHi[p * 128 + sq];
  mgS[c] += PST_MG[p * 128 + sq]; egS[c] += PST_EG[p * 128 + sq];
  phase += PHASE_INC[p & 7];
}
function removePiece(sq) {
  const p = board[sq], c = p >> 3;
  const i = pidx[sq], last = --pcount[c];
  const lastSq = plist[c * 16 + last];
  plist[c * 16 + i] = lastSq; pidx[lastSq] = i;
  board[sq] = 0;
  pieceCnt[p]--;
  hashLo ^= zLo[p * 128 + sq]; hashHi ^= zHi[p * 128 + sq];
  mgS[c] -= PST_MG[p * 128 + sq]; egS[c] -= PST_EG[p * 128 + sq];
  phase -= PHASE_INC[p & 7];
}
function movePiece(from, to) {
  const p = board[from], c = p >> 3;
  board[to] = p; board[from] = 0;
  const i = pidx[from];
  plist[c * 16 + i] = to; pidx[to] = i;
  hashLo ^= zLo[p * 128 + from] ^ zLo[p * 128 + to];
  hashHi ^= zHi[p * 128 + from] ^ zHi[p * 128 + to];
  mgS[c] += PST_MG[p * 128 + to] - PST_MG[p * 128 + from];
  egS[c] += PST_EG[p * 128 + to] - PST_EG[p * 128 + from];
}

// ---------------------------------------------------------------- attacks
function isAttacked(sq, c) {
  const cb = c << 3;
  let s;
  if (c === 0) {
    s = sq - 15; if (!(s & 0x88) && board[s] === PAWN) return true;
    s = sq - 17; if (!(s & 0x88) && board[s] === PAWN) return true;
  } else {
    s = sq + 15; if (!(s & 0x88) && board[s] === (PAWN | 8)) return true;
    s = sq + 17; if (!(s & 0x88) && board[s] === (PAWN | 8)) return true;
  }
  const kn = KNIGHT | cb, kg = KING | cb, bi = BISHOP | cb, rk = ROOK | cb, qn = QUEEN | cb;
  for (let i = 0; i < 8; i++) {
    s = sq + N_DIRS[i]; if (!(s & 0x88) && board[s] === kn) return true;
    s = sq + K_DIRS[i]; if (!(s & 0x88) && board[s] === kg) return true;
  }
  for (let i = 0; i < 4; i++) {
    const d = B_DIRS[i];
    s = sq + d;
    while (!(s & 0x88)) {
      const p = board[s];
      if (p) { if (p === bi || p === qn) return true; break; }
      s += d;
    }
  }
  for (let i = 0; i < 4; i++) {
    const d = R_DIRS[i];
    s = sq + d;
    while (!(s & 0x88)) {
      const p = board[s];
      if (p) { if (p === rk || p === qn) return true; break; }
      s += d;
    }
  }
  return false;
}
function inCheck() { return isAttacked(kingSq[side], side ^ 1); }

// ---------------------------------------------------------------- moves
// move = from | to<<7 | promo<<14 | flags<<17
const MOVE_BUF = 256 * (MAX_PLY + 4);
const moves = new Int32Array(MOVE_BUF);
const mscore = new Int32Array(MOVE_BUF);

function genMoves(n, all) {
  const us = side, them = us ^ 1, base = us * 16, cnt = pcount[us];
  for (let i = 0; i < cnt; i++) {
    const from = plist[base + i], p = board[from], t = p & 7;
    if (t === PAWN) {
      const fwd = us === 0 ? 16 : -16, rank = from >> 4;
      const promoRank = us === 0 ? 6 : 1, startRank = us === 0 ? 1 : 6;
      let to = from + fwd;
      if (board[to] === 0) {
        if (rank === promoRank) {
          moves[n++] = from | (to << 7) | (QUEEN << 14);
          if (all) {
            moves[n++] = from | (to << 7) | (KNIGHT << 14);
            moves[n++] = from | (to << 7) | (ROOK << 14);
            moves[n++] = from | (to << 7) | (BISHOP << 14);
          }
        } else if (all) {
          moves[n++] = from | (to << 7);
          if (rank === startRank && board[to + fwd] === 0) moves[n++] = from | ((to + fwd) << 7) | (FLAG_DOUBLE << 17);
        }
      }
      for (let k = -1; k <= 1; k += 2) {
        to = from + fwd + k;
        if (to & 0x88) continue;
        const q = board[to];
        if (q && (q >> 3) === them) {
          if (rank === promoRank) {
            moves[n++] = from | (to << 7) | (QUEEN << 14);
            if (all) {
              moves[n++] = from | (to << 7) | (KNIGHT << 14);
              moves[n++] = from | (to << 7) | (ROOK << 14);
              moves[n++] = from | (to << 7) | (BISHOP << 14);
            }
          } else moves[n++] = from | (to << 7);
        } else if (to === epSq) moves[n++] = from | (to << 7) | (FLAG_EP << 17);
      }
    } else if (t === KNIGHT || t === KING) {
      const dirs = t === KNIGHT ? N_DIRS : K_DIRS;
      for (let k = 0; k < 8; k++) {
        const to = from + dirs[k];
        if (to & 0x88) continue;
        const q = board[to];
        if (q === 0) { if (all) moves[n++] = from | (to << 7); }
        else if ((q >> 3) === them) moves[n++] = from | (to << 7);
      }
    } else {
      const dirs = t === BISHOP ? B_DIRS : t === ROOK ? R_DIRS : K_DIRS;
      const nd = dirs.length;
      for (let k = 0; k < nd; k++) {
        const d = dirs[k];
        let to = from + d;
        while (!(to & 0x88)) {
          const q = board[to];
          if (q === 0) { if (all) moves[n++] = from | (to << 7); }
          else { if ((q >> 3) === them) moves[n++] = from | (to << 7); break; }
          to += d;
        }
      }
    }
  }
  if (all && castling) {
    if (us === 0) {
      if ((castling & 1) && board[4] === KING && board[7] === ROOK && board[5] === 0 && board[6] === 0 &&
          !isAttacked(4, 1) && !isAttacked(5, 1)) moves[n++] = 4 | (6 << 7) | (FLAG_CASTLE << 17);
      if ((castling & 2) && board[4] === KING && board[0] === ROOK && board[3] === 0 && board[2] === 0 && board[1] === 0 &&
          !isAttacked(4, 1) && !isAttacked(3, 1)) moves[n++] = 4 | (2 << 7) | (FLAG_CASTLE << 17);
    } else {
      if ((castling & 4) && board[0x74] === (KING | 8) && board[0x77] === (ROOK | 8) && board[0x75] === 0 && board[0x76] === 0 &&
          !isAttacked(0x74, 0) && !isAttacked(0x75, 0)) moves[n++] = 0x74 | (0x76 << 7) | (FLAG_CASTLE << 17);
      if ((castling & 8) && board[0x74] === (KING | 8) && board[0x70] === (ROOK | 8) && board[0x73] === 0 && board[0x72] === 0 &&
          board[0x71] === 0 && !isAttacked(0x74, 0) && !isAttacked(0x73, 0)) moves[n++] = 0x74 | (0x72 << 7) | (FLAG_CASTLE << 17);
    }
  }
  return n;
}

function makeMove(m) {
  const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flags = m >> 17;
  const us = side;
  uCastle[sp] = castling; uEp[sp] = epSq; uHalf[sp] = halfmove; uLo[sp] = hashLo; uHi[sp] = hashHi;
  if (epSq >= 0) { hashLo ^= zEpLo[epSq & 7]; hashHi ^= zEpHi[epSq & 7]; }
  let cap = 0;
  const p = board[from];
  if (flags & FLAG_EP) {
    const cs = us === 0 ? to - 16 : to + 16;
    cap = board[cs]; removePiece(cs);
  } else if (board[to]) { cap = board[to]; removePiece(to); }
  uCap[sp] = cap;
  sp++;
  movePiece(from, to);
  if (promo) { removePiece(to); addPiece(to, promo | (us << 3)); }
  else if ((p & 7) === KING) {
    kingSq[us] = to;
    if (flags & FLAG_CASTLE) {
      if (to > from) movePiece(from + 3, from + 1); else movePiece(from - 4, from - 1);
    }
  }
  const nc = castling & castleMask[from] & castleMask[to];
  if (nc !== castling) {
    hashLo ^= zCastleLo[castling] ^ zCastleLo[nc]; hashHi ^= zCastleHi[castling] ^ zCastleHi[nc];
    castling = nc;
  }
  if (flags & FLAG_DOUBLE) {
    epSq = (from + to) >> 1;
    hashLo ^= zEpLo[epSq & 7]; hashHi ^= zEpHi[epSq & 7];
  } else epSq = -1;
  halfmove = (cap || (p & 7) === PAWN) ? 0 : halfmove + 1;
  if (us === 1) fullmove++;
  side = us ^ 1;
  hashLo ^= zSideLo; hashHi ^= zSideHi;
  histLo[histLen] = hashLo; histHi[histLen] = hashHi; histLen++;
}

function unmakeMove(m) {
  const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flags = m >> 17;
  side ^= 1;
  const us = side;
  if (us === 1) fullmove--;
  histLen--;
  sp--;
  if (promo) { removePiece(to); addPiece(to, PAWN | (us << 3)); }
  movePiece(to, from);
  if ((board[from] & 7) === KING) {
    kingSq[us] = from;
    if (flags & FLAG_CASTLE) {
      if (to > from) movePiece(from + 1, from + 3); else movePiece(from - 1, from - 4);
    }
  }
  const cap = uCap[sp];
  if (cap) {
    if (flags & FLAG_EP) addPiece(us === 0 ? to - 16 : to + 16, cap);
    else addPiece(to, cap);
  }
  castling = uCastle[sp]; epSq = uEp[sp]; halfmove = uHalf[sp]; hashLo = uLo[sp]; hashHi = uHi[sp];
}

function makeNull() {
  uEp[sp] = epSq; uLo[sp] = hashLo; uHi[sp] = hashHi; uHalf[sp] = halfmove; sp++;
  if (epSq >= 0) { hashLo ^= zEpLo[epSq & 7]; hashHi ^= zEpHi[epSq & 7]; }
  epSq = -1; side ^= 1; halfmove++;
  hashLo ^= zSideLo; hashHi ^= zSideHi;
  histLo[histLen] = hashLo; histHi[histLen] = hashHi; histLen++;
}
function unmakeNull() {
  sp--; histLen--; side ^= 1;
  epSq = uEp[sp]; hashLo = uLo[sp]; hashHi = uHi[sp]; halfmove = uHalf[sp];
}

// make a pseudo-legal move; returns false (and undoes it) if it leaves own king in check
const ALIGNED = new Uint8Array(240);
for (const d of K_DIRS) for (let k = 1; k < 8; k++) ALIGNED[d * k + 119] = 1;

// fast legality: when not in check, only king moves, en passant and moves of
// pieces aligned with their king can be illegal
function makeLegalFast(m, check) {
  const from = m & 127;
  if (!check && (board[from] & 7) !== KING && !((m >> 17) & FLAG_EP) && !ALIGNED[from - kingSq[side] + 119]) {
    makeMove(m); return true;
  }
  return makeLegal(m);
}

function makeLegal(m) {
  makeMove(m);
  if (isAttacked(kingSq[side ^ 1], side)) { unmakeMove(m); return false; }
  return true;
}

// ---------------------------------------------------------------- FEN
const PIECE_CHARS = ' PNBRQK  pnbrqk';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function setFen(fen) {
  board.fill(0); pcount[0] = pcount[1] = 0; pieceCnt.fill(0);
  mgS[0] = mgS[1] = egS[0] = egS[1] = 0; phase = 0; hashLo = hashHi = 0;
  kingSq[0] = kingSq[1] = -1;
  const parts = fen.trim().split(/\s+/);
  const rows = parts[0].split('/');
  if (rows.length !== 8) throw new Error('bad FEN: ' + fen);
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') { f += +ch; continue; }
      const p = PIECE_CHARS.indexOf(ch);
      if (p <= 0 || f > 7) throw new Error('bad FEN: ' + fen);
      const sq = (7 - r) * 16 + f;
      if (pcount[p >> 3] >= 16) throw new Error('too many pieces');
      addPiece(sq, p);
      if ((p & 7) === KING) kingSq[p >> 3] = sq;
      f++;
    }
  }
  if (kingSq[0] < 0 || kingSq[1] < 0) throw new Error('FEN needs both kings');
  side = parts[1] === 'b' ? 1 : 0;
  castling = 0;
  const cs = parts[2] || '-';
  if (cs.includes('K')) castling |= 1;
  if (cs.includes('Q')) castling |= 2;
  if (cs.includes('k')) castling |= 4;
  if (cs.includes('q')) castling |= 8;
  epSq = -1;
  if (parts[3] && parts[3] !== '-') epSq = sqFromName(parts[3]);
  halfmove = parseInt(parts[4] || '0', 10) || 0;
  fullmove = parseInt(parts[5] || '1', 10) || 1;
  hashLo ^= zCastleLo[castling]; hashHi ^= zCastleHi[castling];
  if (epSq >= 0) { hashLo ^= zEpLo[epSq & 7]; hashHi ^= zEpHi[epSq & 7]; }
  if (side) { hashLo ^= zSideLo; hashHi ^= zSideHi; }
  histLen = 0; histLo[histLen] = hashLo; histHi[histLen] = hashHi; histLen++;
  sp = 0;
}

function getFen() {
  let s = '';
  for (let r = 7; r >= 0; r--) {
    let e = 0;
    for (let f = 0; f < 8; f++) {
      const p = board[r * 16 + f];
      if (!p) { e++; continue; }
      if (e) { s += e; e = 0; }
      s += PIECE_CHARS[p];
    }
    if (e) s += e;
    if (r) s += '/';
  }
  let cs = '';
  if (castling & 1) cs += 'K'; if (castling & 2) cs += 'Q';
  if (castling & 4) cs += 'k'; if (castling & 8) cs += 'q';
  return s + ' ' + (side ? 'b' : 'w') + ' ' + (cs || '-') + ' ' + (epSq >= 0 ? sqName(epSq) : '-') + ' ' + halfmove + ' ' + fullmove;
}

function sqName(sq) { return 'abcdefgh'[sq & 7] + ((sq >> 4) + 1); }
function sqFromName(s) { return (s.charCodeAt(1) - 49) * 16 + (s.charCodeAt(0) - 97); }
function moveToUci(m) {
  if (!m) return '0000';
  const promo = (m >> 14) & 7;
  return sqName(m & 127) + sqName((m >> 7) & 127) + (promo ? ' pnbrqk'[promo] : '');
}

// ---------------------------------------------------------------- perft
function perft(depth, ply) {
  ply = ply || 0;
  const start = ply * 256;
  const end = genMoves(start, true);
  let total = 0;
  const check = inCheck();
  for (let i = start; i < end; i++) {
    const m = moves[i];
    if (!makeLegalFast(m, check)) continue;
    total += depth <= 1 ? 1 : perft(depth - 1, ply + 1);
    unmakeMove(m);
  }
  return total;
}

// ---------------------------------------------------------------- evaluation
const DIST = new Int32Array(240);      // chebyshev distance indexed by (a - b + 119)
const MDIST = new Int32Array(240);     // manhattan distance
for (let a = 0; a < 128; a++) {
  if (a & 0x88) continue;
  for (let b = 0; b < 128; b++) {
    if (b & 0x88) continue;
    const dr = Math.abs((a >> 4) - (b >> 4)), df = Math.abs((a & 7) - (b & 7));
    DIST[a - b + 119] = Math.max(dr, df); MDIST[a - b + 119] = dr + df;
  }
}
const CENTER_DIST = new Int32Array(128);
for (let sq = 0; sq < 128; sq++) {
  if (sq & 0x88) continue;
  const r = sq >> 4, f = sq & 7;
  CENTER_DIST[sq] = Math.max(3 - r, r - 4) + Math.max(3 - f, f - 4);
}

const PASSED_MG = [0, 0, 5, 10, 20, 35, 55, 0];
const PASSED_EG = [0, 5, 10, 25, 45, 75, 110, 0];
const MOB_MG = [0, 0, 4, 5, 2, 1, 0];
const MOB_EG = [0, 0, 4, 5, 4, 2, 0];
const MOB_BASE = [0, 0, 4, 6, 7, 13, 0];
const THREAT_MG = [0, 0, 45, 45, 60, 60, 0], THREAT_EG = [0, 0, 30, 30, 40, 40, 0];
const KA_WEIGHT = [0, 0, 2, 2, 3, 5, 0];

const pAtt = new Uint8Array(256);
const pMin = new Int32Array(20), pMax = new Int32Array(20), pCnt = new Int32Array(20); // [c*10 + file+1]

let evalCalls = 0;
const evKaUnits = new Int32Array(2), evKaCount = new Int32Array(2), evMg = new Int32Array(2), evEg = new Int32Array(2), evNpm = new Int32Array(2);
const EC_SIZE = 1 << 16, EC_MASK = EC_SIZE - 1;
const ecKey = new Int32Array(EC_SIZE), ecLo = new Int32Array(EC_SIZE), ecVal = new Int32Array(EC_SIZE);

function evaluate() {
  const ei = hashLo & EC_MASK;
  if (ecKey[ei] === hashHi && ecLo[ei] === hashLo) return ecVal[ei];
  const v = evaluateRaw();
  ecKey[ei] = hashHi; ecLo[ei] = hashLo; ecVal[ei] = v;
  return v;
}

function evaluateRaw() {
  evalCalls++;
  // insufficient material shortcuts
  const wP = pieceCnt[PAWN], bP = pieceCnt[PAWN | 8];
  const wMinor = pieceCnt[KNIGHT] + pieceCnt[BISHOP], bMinor = pieceCnt[KNIGHT | 8] + pieceCnt[BISHOP | 8];
  const wMajor = pieceCnt[ROOK] + pieceCnt[QUEEN], bMajor = pieceCnt[ROOK | 8] + pieceCnt[QUEEN | 8];
  if (wP + bP === 0 && wMajor + bMajor === 0 && wMinor <= 1 && bMinor <= 1) return 0;

  let mg = mgS[0] - mgS[1], eg = egS[0] - egS[1];

  for (let i = 0; i < 20; i++) { pMin[i] = 8; pMax[i] = -1; pCnt[i] = 0; }
  pAtt.fill(0);
  for (let c = 0; c < 2; c++) {
    const base = c * 16, cnt = pcount[c];
    for (let i = 0; i < cnt; i++) {
      const sq = plist[base + i];
      if ((board[sq] & 7) !== PAWN) continue;
      const k = c * 10 + (sq & 7) + 1, r = sq >> 4;
      pCnt[k]++;
      const fw = c === 0 ? 16 : -16;
      let a = sq + fw - 1; if (!(a & 0x88)) pAtt[c * 128 + a] = 1;
      a = sq + fw + 1; if (!(a & 0x88)) pAtt[c * 128 + a] = 1;
      if (r < pMin[k]) pMin[k] = r;
      if (r > pMax[k]) pMax[k] = r;
    }
  }

  const wk = kingSq[0], bk = kingSq[1];
  const kaUnits = evKaUnits, kaCount = evKaCount, mgc = evMg, egc = evEg, npm = evNpm;
  npm[0] = pieceCnt[KNIGHT] * 3 + pieceCnt[BISHOP] * 3 + pieceCnt[ROOK] * 5 + pieceCnt[QUEEN] * 9;
  npm[1] = pieceCnt[KNIGHT | 8] * 3 + pieceCnt[BISHOP | 8] * 3 + pieceCnt[ROOK | 8] * 5 + pieceCnt[QUEEN | 8] * 9;

  for (let c = 0; c < 2; c++) {
    const them = c ^ 1, base = c * 16, cnt = pcount[c];
    const ek = kingSq[them], ok = kingSq[c];
    const pa = them * 128;
    let m = 0, e = 0, units = 0, attackers = 0;
    for (let i = 0; i < cnt; i++) {
      const sq = plist[base + i], p = board[sq], t = p & 7;
      if (t === PAWN) {
        const f = (sq & 7) + 1, r = sq >> 4, rr = c === 0 ? r : 7 - r;
        const k = c * 10 + f, ke = them * 10 + f;
        // doubled: penalise the rear pawns
        if (pCnt[k] > 1 && r !== (c === 0 ? pMax[k] : pMin[k])) { m -= 10; e -= 20; }
        // isolated
        if (pCnt[k - 1] === 0 && pCnt[k + 1] === 0) { m -= 10; e -= 12; }
        // passed
        let passed;
        if (c === 0) passed = pMax[ke - 1] <= r && pMax[ke] <= r && pMax[ke + 1] <= r;
        else passed = pMin[ke - 1] >= r && pMin[ke] >= r && pMin[ke + 1] >= r;
        if (passed) {
          m += PASSED_MG[rr]; e += PASSED_EG[rr];
          const fwd = c === 0 ? 16 : -16;
          const stop = sq + fwd;
          if (rr >= 3) {
            // king proximity to the square in front of the pawn
            e += (DIST[ek - stop + 119] * 5 - DIST[ok - stop + 119] * 2) * (rr - 2);
            if (board[stop]) e -= PASSED_EG[rr] >> 1;
          }
          // unstoppable passer: opponent has only king + pawns
          if (npm[them] === 0) {
            const promo = c === 0 ? 0x70 + (sq & 7) : (sq & 7);
            const dist = 7 - rr - (rr === 1 ? 1 : 0);
            const kd = DIST[ek - promo + 119] - (side === them ? 1 : 0);
            if (kd > dist) e += 500;
          }
        }
        continue;
      }
      if (t === KING) continue;
      // threatened by an enemy pawn
      if (pAtt[them * 128 + sq]) { m -= THREAT_MG[t]; e -= THREAT_EG[t]; }
      // mobility + king attack
      let mob = 0, hits = 0;
      if (t === KNIGHT) {
        for (let k = 0; k < 8; k++) {
          const s = sq + N_DIRS[k];
          if (s & 0x88) continue;
          if (DIST[s - ek + 119] <= 1) hits++;
          const q = board[s];
          if (q && (q >> 3) === c) continue;
          if (pAtt[pa + s]) continue;
          mob++;
        }
      } else {
        const dirs = t === BISHOP ? B_DIRS : t === ROOK ? R_DIRS : K_DIRS;
        const nd = dirs.length;
        for (let k = 0; k < nd; k++) {
          const d = dirs[k];
          let s = sq + d;
          while (!(s & 0x88)) {
            if (DIST[s - ek + 119] <= 1) hits++;
            const q = board[s];
            if (q && (q >> 3) === c) break;
            if (!pAtt[pa + s]) mob++;
            if (q) break;
            s += d;
          }
        }
        if (t === ROOK) {
          const f = (sq & 7) + 1;
          if (pCnt[c * 10 + f] === 0) {
            if (pCnt[them * 10 + f] === 0) { m += 25; e += 10; } else { m += 12; e += 5; }
          }
          const rr = c === 0 ? sq >> 4 : 7 - (sq >> 4);
          if (rr === 6) { m += 10; e += 20; }
        }
      }
      m += MOB_MG[t] * (mob - MOB_BASE[t]);
      e += MOB_EG[t] * (mob - MOB_BASE[t]);
      if (hits) { attackers++; units += KA_WEIGHT[t] * hits; }
    }
    if (pieceCnt[BISHOP | (c << 3)] >= 2) { m += 30; e += 50; }
    kaUnits[c] = units; kaCount[c] = attackers;
    mgc[c] = m; egc[c] = e;
  }

  // king safety (applied against the defending side)
  for (let c = 0; c < 2; c++) {
    const them = c ^ 1;
    if (kaCount[them] >= 2 && pieceCnt[QUEEN | (them << 3)]) {
      const u = kaUnits[them];
      mgc[c] -= Math.min(500, (u * u) >> 2);
    }
    // pawn shield
    const ks = kingSq[c], kr = c === 0 ? ks >> 4 : 7 - (ks >> 4);
    if (kr <= 1) {
      const kf = ks & 7, fwd = c === 0 ? 16 : -16, own = PAWN | (c << 3);
      let shield = 0;
      for (let f = Math.max(0, kf - 1); f <= Math.min(7, kf + 1); f++) {
        const s1 = (ks & 0x70) + f + fwd;
        if (board[s1] === own) shield += 12;
        else if (board[s1 + fwd] === own) shield += 6;
        else {
          shield -= 10;
          if (pCnt[c * 10 + f + 1] === 0) shield -= 10;
        }
      }
      mgc[c] += shield;
    }
  }

  mg += mgc[0] - mgc[1];
  eg += egc[0] - egc[1];
  mg += side === 0 ? 10 : -10;

  const ph = phase > 24 ? 24 : phase;
  let score = ((mg * ph + eg * (24 - ph)) / 24) | 0;

  // endgame scaling
  const strong = score > 0 ? 0 : 1;
  const sP = strong === 0 ? wP : bP;
  if (sP === 0) {
    const diff = npm[strong] - npm[strong ^ 1];
    if (diff <= 3) score = (score / 8) | 0;                 // e.g. KBK, KRKB, KRKN: drawish
    else if (npm[strong] === 6 && pieceCnt[KNIGHT | (strong << 3)] === 2) score = (score / 8) | 0; // KNNK
  }
  if (wMajor + bMajor === 0 && wMinor === 1 && bMinor === 1 && pieceCnt[BISHOP] === 1 && pieceCnt[BISHOP | 8] === 1) {
    // opposite coloured bishops
    let wb = 0, bb = 0;
    for (let i = 0; i < pcount[0]; i++) { const s = plist[i]; if (board[s] === BISHOP) wb = ((s >> 4) + (s & 7)) & 1; }
    for (let i = 0; i < pcount[1]; i++) { const s = plist[16 + i]; if (board[s] === (BISHOP | 8)) bb = ((s >> 4) + (s & 7)) & 1; }
    if (wb !== bb) score = (score / 2) | 0;
  }
  // mop-up: drive the lone king to the edge when clearly winning
  const weak = strong ^ 1;
  if ((weak === 0 ? wP : bP) === 0 && npm[weak] <= 3 && npm[strong] >= npm[weak] + 4 && Math.abs(score) > 200) {
    const lk = kingSq[weak], sk = kingSq[strong];
    let bonus = CENTER_DIST[lk] * 12 + (14 - MDIST[lk - sk + 119]) * 6;
    const sb = strong << 3;
    if (npm[strong] === 6 && pieceCnt[BISHOP | sb] === 1 && pieceCnt[KNIGHT | sb] === 1 && npm[weak] === 0) {
      // KBNK: drive the king to a corner of the bishop's colour
      let bsq = 0;
      for (let i = 0; i < pcount[strong]; i++) { const q = plist[strong * 16 + i]; if (board[q] === (BISHOP | sb)) bsq = q; }
      const light = ((bsq >> 4) + (bsq & 7)) & 1;   // 1 = light square
      const c1 = light ? 0x07 : 0x00, c2 = light ? 0x70 : 0x77;
      const cd = Math.min(MDIST[lk - c1 + 119], MDIST[lk - c2 + 119]);
      bonus = (14 - cd) * 30 + (14 - MDIST[lk - sk + 119]) * 8 + CENTER_DIST[lk] * 6;
    }
    score += strong === 0 ? bonus : -bonus;
  }
  return side === 0 ? score : -score;
}

// ---------------------------------------------------------------- SEE
const seeGain = new Int32Array(40);
const seeSq = new Int32Array(40), seePc = new Int32Array(40);

function leastAttacker(sq, c) {
  const cb = c << 3;
  let s;
  if (c === 0) {
    s = sq - 15; if (!(s & 0x88) && board[s] === PAWN) return s;
    s = sq - 17; if (!(s & 0x88) && board[s] === PAWN) return s;
  } else {
    s = sq + 15; if (!(s & 0x88) && board[s] === (PAWN | 8)) return s;
    s = sq + 17; if (!(s & 0x88) && board[s] === (PAWN | 8)) return s;
  }
  const kn = KNIGHT | cb;
  for (let i = 0; i < 8; i++) { s = sq + N_DIRS[i]; if (!(s & 0x88) && board[s] === kn) return s; }
  let best = -1, bestT = 7;
  for (let i = 0; i < 8; i++) {
    const d = K_DIRS[i], diag = (i === 0 || i === 2 || i === 5 || i === 7);
    s = sq + d;
    let first = true;
    while (!(s & 0x88)) {
      const p = board[s];
      if (p) {
        if ((p >> 3) === c) {
          const t = p & 7;
          if ((t === QUEEN || (diag ? t === BISHOP : t === ROOK) || (first && t === KING)) && t < bestT) { best = s; bestT = t; }
        }
        break;
      }
      first = false;
      s += d;
    }
  }
  return best;
}

// static exchange evaluation of move m for the side to move
function see(m) {
  const from = m & 127, to = (m >> 7) & 127, flags = m >> 17;
  let n = 0;
  const victim = (flags & FLAG_EP) ? PAWN : (board[to] & 7);
  seeGain[0] = SEE_VAL[victim];
  let attackerVal = SEE_VAL[board[from] & 7];
  seeSq[n] = from; seePc[n] = board[from]; n++; board[from] = 0;
  let epCap = -1;
  if (flags & FLAG_EP) { epCap = side === 0 ? to - 16 : to + 16; seeSq[n] = epCap; seePc[n] = board[epCap]; n++; board[epCap] = 0; }
  let c = side ^ 1, d = 0;
  while (true) {
    d++;
    seeGain[d] = attackerVal - seeGain[d - 1];
    if (Math.max(-seeGain[d - 1], seeGain[d]) < 0) break;
    const s = leastAttacker(to, c);
    if (s < 0) break;
    attackerVal = SEE_VAL[board[s] & 7];
    seeSq[n] = s; seePc[n] = board[s]; n++; board[s] = 0;
    c ^= 1;
  }
  while (--d) seeGain[d - 1] = -Math.max(-seeGain[d - 1], seeGain[d]);
  for (let i = 0; i < n; i++) board[seeSq[i]] = seePc[i];
  return seeGain[0];
}

// ---------------------------------------------------------------- transposition table
let ttBits = 22, ttSize = 1 << ttBits, ttMask = ttSize - 1;
let ttKey, ttMove, ttScore, ttDepth, ttFlag, ttAge;
let searchAge = 0;
const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
function allocTT(mb) {
  const entries = Math.max(1 << 14, (mb * 1048576 / 12) | 0);
  ttBits = Math.floor(Math.log2(entries)); ttSize = 1 << ttBits; ttMask = ttSize - 1;
  ttKey = new Int32Array(ttSize); ttMove = new Int32Array(ttSize); ttScore = new Int16Array(ttSize);
  ttDepth = new Int8Array(ttSize); ttFlag = new Uint8Array(ttSize); ttAge = new Uint8Array(ttSize);
}
allocTT(typeof window === 'undefined' && typeof self === 'undefined' ? 64 : 16);
function clearTT() { ttKey.fill(0); ttMove.fill(0); ttScore.fill(0); ttDepth.fill(0); ttFlag.fill(0); ttAge.fill(0); }

function ttStore(depth, flag, score, move, ply) {
  const i = hashLo & ttMask;
  if (ttKey[i] === hashHi && ttFlag[i] && ttAge[i] === searchAge && depth < ttDepth[i] - 2 && flag !== TT_EXACT) return;
  if (score > MATE_BOUND) score += ply; else if (score < -MATE_BOUND) score -= ply;
  if (move || ttKey[i] !== hashHi) ttMove[i] = move;
  ttKey[i] = hashHi; ttScore[i] = score; ttDepth[i] = depth; ttFlag[i] = flag; ttAge[i] = searchAge;
}

// ---------------------------------------------------------------- search state
const killers = new Int32Array(MAX_PLY * 2 + 4);
const history = new Int32Array(2 * 128 * 128);
const counterMove = new Int32Array(16 * 128);
const pvTable = new Int32Array(MAX_PLY * MAX_PLY);
const pvLen = new Int32Array(MAX_PLY + 1);
const evalStack = new Int32Array(MAX_PLY + 4);
const moveStack = new Int32Array(MAX_PLY + 4);   // move played at each ply (for countermoves)
const pieceStack = new Int32Array(MAX_PLY + 4);  // piece that moved
const quietsTried = new Int32Array(MAX_PLY * 64);
const LMR = [];
for (let d = 0; d < 64; d++) {
  LMR.push(new Int32Array(64));
  for (let m = 0; m < 64; m++) LMR[d][m] = d && m ? Math.floor(0.75 + Math.log(d) * Math.log(m) / 2.25) : 0;
}

let nodes = 0, selDepth = 0, stopped = false, startTime = 0, hardLimit = 0, nodeLimit = 0;
let stopSignal = null;   // Int32Array over a SharedArrayBuffer (optional)
let rootBest = 0, rootBestScore = 0;
const now = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();

function checkLimits() {
  if (hardLimit && now() - startTime >= hardLimit) stopped = true;
  else if (nodeLimit && nodes >= nodeLimit) stopped = true;
  else if (stopSignal && Atomics.load(stopSignal, 0)) stopped = true;
}

function isRepetition() {
  const lim = Math.max(0, histLen - 1 - halfmove);
  for (let i = histLen - 3; i >= lim; i -= 2) {
    if (histLo[i] === hashLo && histHi[i] === hashHi) return true;
  }
  return false;
}

function hasNonPawn(c) {
  const b = c << 3;
  return pieceCnt[KNIGHT | b] + pieceCnt[BISHOP | b] + pieceCnt[ROOK | b] + pieceCnt[QUEEN | b] > 0;
}

function scoreMoves(start, end, ttm, ply) {
  const k1 = killers[ply * 2], k2 = killers[ply * 2 + 1];
  const prev = ply > 0 ? moveStack[ply - 1] : 0;
  const cm = prev ? counterMove[pieceStack[ply - 1] * 128 + ((prev >> 7) & 127)] : 0;
  const hb = side * 16384;
  for (let i = start; i < end; i++) {
    const m = moves[i];
    if (m === ttm) { mscore[i] = 10000000; continue; }
    const to = (m >> 7) & 127, promo = (m >> 14) & 7;
    const victim = board[to] & 7;
    if (victim || (m >> 17) & FLAG_EP) {
      const att = board[m & 127] & 7;
      const v = victim || PAWN;
      let s = SEE_VAL[v] * 10 - att;
      if (att > v && SEE_VAL[att] > SEE_VAL[v] && see(m) < 0) mscore[i] = -1000000 + s;
      else mscore[i] = 2000000 + s + (promo === QUEEN ? 5000 : 0);
    } else if (promo) {
      mscore[i] = promo === QUEEN ? 1950000 : -2000000 + promo;
    } else if (m === k1) mscore[i] = 1900000;
    else if (m === k2) mscore[i] = 1899999;
    else if (m === cm) mscore[i] = 1800000;
    else mscore[i] = history[hb + (m & 127) * 128 + to];
  }
}

function pickMove(i, end) {
  let bi = i, bs = mscore[i];
  for (let j = i + 1; j < end; j++) if (mscore[j] > bs) { bs = mscore[j]; bi = j; }
  if (bi !== i) {
    const tm = moves[i]; moves[i] = moves[bi]; moves[bi] = tm;
    const ts = mscore[i]; mscore[i] = mscore[bi]; mscore[bi] = ts;
  }
  return moves[i];
}

function updateHistory(idx, bonus) {
  history[idx] += bonus - ((history[idx] * Math.abs(bonus)) >> 14);
}

function qsearch(alpha, beta, ply) {
  nodes++;
  if ((nodes & 1023) === 0) checkLimits();
  if (stopped) return 0;
  if (ply > selDepth) selDepth = ply;
  if (ply >= MAX_PLY - 1) return evaluate();

  // TT probe
  const ti = hashLo & ttMask;
  let ttm = 0;
  if (ttKey[ti] === hashHi && ttFlag[ti]) {
    ttm = ttMove[ti];
    let s = ttScore[ti];
    if (s > MATE_BOUND) s -= ply; else if (s < -MATE_BOUND) s += ply;
    const f = ttFlag[ti];
    if (f === TT_EXACT || (f === TT_LOWER && s >= beta) || (f === TT_UPPER && s <= alpha)) return s;
  }

  const check = isAttacked(kingSq[side], side ^ 1);
  let best, standPat = 0;
  if (check) best = -MATE + ply;
  else {
    standPat = evaluate();
    if (standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;
    best = standPat;
  }
  const start = ply * 256;
  const end = genMoves(start, check);
  scoreMoves(start, end, ttm, ply);
  let bestMove = 0;
  const oldAlpha = alpha;
  for (let i = start; i < end; i++) {
    const m = pickMove(i, end);
    if (!check) {
      if (mscore[i] < 0) break;  // losing captures and underpromotions
      const victim = board[(m >> 7) & 127] & 7;
      if (!((m >> 14) & 7) && standPat + SEE_VAL[victim] + 200 <= alpha) continue; // delta pruning
    }
    if (!makeLegalFast(m, check)) continue;
    const score = -qsearch(-beta, -alpha, ply + 1);
    unmakeMove(m);
    if (stopped) return 0;
    if (score > best) {
      best = score;
      if (score > alpha) {
        alpha = score; bestMove = m;
        if (score >= beta) break;
      }
    }
  }
  ttStore(0, best >= beta ? TT_LOWER : (alpha > oldAlpha ? TT_EXACT : TT_UPPER), best, bestMove, ply);
  return best;
}

function negamax(alpha, beta, depth, ply, doNull, excluded) {
  const pvNode = beta - alpha > 1;
  pvLen[ply] = ply;
  const check = isAttacked(kingSq[side], side ^ 1);
  if (check) depth++;
  if (depth <= 0) return qsearch(alpha, beta, ply);
  nodes++;
  if ((nodes & 1023) === 0) checkLimits();
  if (stopped) return 0;
  if (ply > selDepth) selDepth = ply;

  if (ply > 0) {
    if (halfmove >= 100 || isRepetition()) return 0;
    if (pieceCnt[PAWN] + pieceCnt[PAWN | 8] === 0 && pcount[0] + pcount[1] <= 3 &&
        pieceCnt[ROOK] + pieceCnt[ROOK | 8] + pieceCnt[QUEEN] + pieceCnt[QUEEN | 8] === 0) return 0;
    const ma = -MATE + ply, mb = MATE - ply - 1;
    if (alpha < ma) alpha = ma;
    if (beta > mb) beta = mb;
    if (alpha >= beta) return alpha;
    if (ply >= MAX_PLY - 1) return evaluate();
  }

  // TT probe
  const ti = hashLo & ttMask;
  let ttm = 0, ttHit = false, ttS = 0, ttF = 0, ttD = -1;
  if (ttKey[ti] === hashHi && ttFlag[ti]) {
    ttHit = true;
    ttm = ttMove[ti]; ttF = ttFlag[ti]; ttD = ttDepth[ti];
    ttS = ttScore[ti];
    if (ttS > MATE_BOUND) ttS -= ply; else if (ttS < -MATE_BOUND) ttS += ply;
    if (!pvNode && ttD >= depth && halfmove < 90 &&
        (ttF === TT_EXACT || (ttF === TT_LOWER && ttS >= beta) || (ttF === TT_UPPER && ttS <= alpha))) {
      if (ttF === TT_LOWER && ttm && board[(ttm >> 7) & 127] === 0 && !((ttm >> 14) & 7)) {
        // reward quiet tt move causing a cutoff
        updateHistory(side * 16384 + (ttm & 127) * 128 + ((ttm >> 7) & 127), depth * depth);
      }
      return ttS;
    }
  }

  let staticEval;
  if (check) staticEval = -INF;
  else {
    staticEval = evaluate();
    if (ttHit && ((ttF === TT_LOWER && ttS > staticEval) || (ttF === TT_UPPER && ttS < staticEval) || ttF === TT_EXACT)) {
      if (Math.abs(ttS) < MATE_BOUND) staticEval = ttS;
    }
  }
  evalStack[ply] = check ? -INF : staticEval;
  const improving = !check && ply >= 2 && staticEval > evalStack[ply - 2];

  if (!pvNode && !check) {
    // reverse futility pruning
    if (depth <= 7 && staticEval - (improving ? 70 : 90) * depth >= beta && Math.abs(beta) < MATE_BOUND) return staticEval;
    // razoring
    if (depth <= 3 && staticEval + 250 * depth < alpha) {
      const q = qsearch(alpha, alpha + 1, ply);
      if (q <= alpha) return q;
    }
    // null move pruning
    if (doNull && depth >= 3 && staticEval >= beta && hasNonPawn(side)) {
      const R = 3 + ((depth / 4) | 0) + Math.min(3, ((staticEval - beta) / 200) | 0);
      moveStack[ply] = 0; pieceStack[ply] = 0;
      makeNull();
      let s = -negamax(-beta, -beta + 1, depth - 1 - R, ply + 1, false, 0);
      unmakeNull();
      if (stopped) return 0;
      if (s >= beta) {
        if (s >= MATE_BOUND) s = beta;
        if (depth < 10) return s;
        // verification at high depth
        const v = negamax(beta - 1, beta, depth - 1 - R, ply, false, 0);
        if (v >= beta) return s;
      }
    }
  }

  // internal iterative reduction
  if (depth >= 4 && !ttm) depth--;

  const start = ply * 256;
  const end = genMoves(start, true);
  scoreMoves(start, end, ttm, ply);

  let legal = 0, best = -INF, bestMove = 0, quiets = 0;
  const oldAlpha = alpha;
  const qBase = ply * 64;
  const hb = side * 16384;
  const futile = !pvNode && !check && depth <= 8 && staticEval + 90 + 100 * depth <= alpha;
  const lmpLimit = (3 + depth * depth) / (improving ? 1 : 2);
  let skipQuiets = false;

  for (let i = start; i < end; i++) {
    const m = pickMove(i, end);
    const from = m & 127, to = (m >> 7) & 127;
    const isCap = board[to] !== 0 || ((m >> 17) & FLAG_EP);
    const promo = (m >> 14) & 7;
    const isQuiet = !isCap && !promo;

    if (ply > 0 && best > -MATE_BOUND) {
      if (isQuiet) {
        if (skipQuiets) continue;
        if (!pvNode && !check && depth <= 8 && quiets >= lmpLimit) { skipQuiets = true; continue; }
        if (futile) { skipQuiets = true; continue; }
        if (!pvNode && depth <= 3 && mscore[i] < -2000 * depth && m !== killers[ply * 2]) continue;
        if (depth <= 7 && !check && see(m) < -60 * depth) continue;
      } else if (depth <= 6 && mscore[i] < 1000000 && see(m) < -100 * depth) continue;
    }

    const piece = board[from];
    if (!makeLegalFast(m, check)) continue;
    legal++;
    moveStack[ply] = m; pieceStack[ply] = piece;
    const givesCheck = isAttacked(kingSq[side], side ^ 1);
    const newDepth = depth - 1;
    let score;
    if (legal === 1) {
      score = -negamax(-beta, -alpha, newDepth, ply + 1, true, 0);
    } else {
      let R = 0;
      if (depth >= 3 && (isQuiet || mscore[i] < 0)) {
        R = LMR[Math.min(depth, 63)][Math.min(legal, 63)];
        if (pvNode) R--;
        if (!improving) R++;
        if (givesCheck) R--;
        if (mscore[i] >= 1800000) R--;
        if (isQuiet) R -= (history[hb + from * 128 + to] / 6000) | 0;
        if (R < 0) R = 0;
        if (R > newDepth - 1) R = newDepth - 1;
        if (R < 0) R = 0;
      }
      score = -negamax(-alpha - 1, -alpha, newDepth - R, ply + 1, true, 0);
      if (score > alpha && R > 0) score = -negamax(-alpha - 1, -alpha, newDepth, ply + 1, true, 0);
      if (score > alpha && score < beta) score = -negamax(-beta, -alpha, newDepth, ply + 1, true, 0);
    }
    unmakeMove(m);
    if (stopped) return 0;

    if (score > best) {
      best = score;
      if (score > alpha) {
        alpha = score; bestMove = m;
        // update PV
        const b = ply * MAX_PLY, nb = (ply + 1) * MAX_PLY;
        pvTable[b + ply] = m;
        for (let j = ply + 1; j < pvLen[ply + 1]; j++) pvTable[b + j] = pvTable[nb + j];
        pvLen[ply] = Math.max(pvLen[ply + 1], ply + 1);
        if (ply === 0) { rootBest = m; rootBestScore = score; }
        if (score >= beta) {
          if (isQuiet) {
            if (killers[ply * 2] !== m) { killers[ply * 2 + 1] = killers[ply * 2]; killers[ply * 2] = m; }
            const bonus = Math.min(1600, depth * depth * 16);
            updateHistory(hb + from * 128 + to, bonus);
            for (let q = 0; q < quiets; q++) {
              const qm = quietsTried[qBase + q];
              updateHistory(hb + (qm & 127) * 128 + ((qm >> 7) & 127), -bonus);
            }
            if (ply > 0 && moveStack[ply - 1]) counterMove[pieceStack[ply - 1] * 128 + ((moveStack[ply - 1] >> 7) & 127)] = m;
          }
          break;
        }
      }
    }
    if (isQuiet && quiets < 64) quietsTried[qBase + quiets++] = m;
  }

  if (legal === 0) return check ? -MATE + ply : 0;
  ttStore(depth, best >= beta ? TT_LOWER : (alpha > oldAlpha ? TT_EXACT : TT_UPPER), best, bestMove, ply);
  return best;
}

// ---------------------------------------------------------------- root search driver
function scoreToUci(s) {
  if (s > MATE_BOUND) return { mate: ((MATE - s + 1) / 2) | 0 };
  if (s < -MATE_BOUND) return { mate: -(((MATE + s) / 2) | 0) };
  return { cp: s };
}

const LEGAL_BASE = (MAX_PLY + 2) * 256;
function legalMoveInts() {
  const end = genMoves(LEGAL_BASE, true);
  const out = [];
  for (let i = LEGAL_BASE; i < end; i++) {
    const m = moves[i];
    if (makeLegal(m)) { unmakeMove(m); out.push(m); }
  }
  return out;
}

function search(opts) {
  opts = opts || {};
  const onInfo = opts.onInfo || null;
  startTime = now(); stopped = false; nodes = 0; evalCalls = 0;
  searchAge = (searchAge + 1) & 255;
  sp = 0;
  hardLimit = 0; nodeLimit = opts.nodes || 0;
  let softLimit = 0;
  const clock = opts.wtime != null || opts.btime != null;
  const maxDepth = Math.min(opts.depth || 64, MAX_PLY - 10);
  if (opts.movetime) {
    const overhead = opts.overhead != null ? opts.overhead : Math.min(30, opts.movetime * 0.1);
    hardLimit = Math.max(1, opts.movetime - overhead);
  } else if (clock && !opts.infinite) {
    const t = (side === 0 ? opts.wtime : opts.btime) || 0;
    const inc = (side === 0 ? opts.winc : opts.binc) || 0;
    const mtg = opts.movestogo ? Math.min(opts.movestogo, 35) : 30;
    const overhead = opts.overhead != null ? opts.overhead : 40;
    const avail = Math.max(5, t - overhead);
    const opt = Math.min(avail / mtg + inc * 0.8, avail * 0.4);
    softLimit = opt;
    hardLimit = Math.max(5, Math.min(avail * 0.75, opt * 3.5));
  }

  const rootMoves = legalMoveInts();
  if (rootMoves.length === 0) return { bestMove: null, ponder: null, score: 0, depth: 0 };
  if (rootMoves.length === 1 && clock) return { bestMove: moveToUci(rootMoves[0]), ponder: null, score: 0, depth: 0 };

  for (let i = 0; i < history.length; i++) history[i] >>= 1;
  killers.fill(0);
  rootBest = rootMoves[0]; rootBestScore = 0;
  let score = 0, completedPv = [], completedDepth = 0, prevBest = 0, stable = 0, bestScore = 0;

  for (let depth = 1; depth <= maxDepth; depth++) {
    selDepth = 0;
    let delta = 20, a = -INF, b = INF;
    if (depth >= 5) { a = Math.max(-INF, score - delta); b = Math.min(INF, score + delta); }
    let s;
    while (true) {
      s = negamax(a, b, depth, 0, false, 0);
      if (stopped) break;
      if (s <= a) { b = ((a + b) / 2) | 0; a = Math.max(-INF, s - delta); delta += delta; }
      else if (s >= b) { b = Math.min(INF, s + delta); delta += delta; }
      else break;
      if (delta > 600) { a = -INF; b = INF; }
    }
    if (stopped && depth > 1) {
      // keep a move improved during the partial iteration
      break;
    }
    score = s; bestScore = s;
    completedDepth = depth;
    const pv = [];
    for (let j = 0; j < pvLen[0]; j++) pv.push(pvTable[j]);
    if (pv.length === 0 || pv[0] !== rootBest) { pv.length = 0; pv.push(rootBest); }
    completedPv = pv;
    const elapsed = now() - startTime;
    if (onInfo) {
      const info = { depth, seldepth: selDepth, nodes, time: Math.round(elapsed),
        nps: Math.round(nodes * 1000 / Math.max(1, elapsed)), pv: pv.map(moveToUci) };
      Object.assign(info, scoreToUci(score));
      onInfo(info);
    }
    if (stopped) break;
    if (rootBest === prevBest) stable++; else stable = 0;
    prevBest = rootBest;
    if (!opts.infinite) {
      if (Math.abs(score) > MATE_BOUND && depth >= (MATE - Math.abs(score)) + 6) break;
      if (softLimit) {
        const scale = stable >= 6 ? 0.45 : stable >= 3 ? 0.7 : stable >= 1 ? 1.0 : 1.4;
        if (elapsed > softLimit * scale * 0.6) break;
      }
    }
  }
  const best = rootBest;
  let ponder = null;
  if (completedPv.length > 1 && completedPv[0] === best) ponder = moveToUci(completedPv[1]);
  return { bestMove: moveToUci(best), ponder, score: bestScore, depth: completedDepth, nodes,
    time: Math.round(now() - startTime) };
}

// ---------------------------------------------------------------- game-level helpers
function moveToSan(m, legal) {
  legal = legal || legalMoveInts();
  const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flags = m >> 17;
  const t = board[from] & 7;
  const isCap = board[to] !== 0 || (flags & FLAG_EP);
  let s;
  if (flags & FLAG_CASTLE) s = to > from ? 'O-O' : 'O-O-O';
  else if (t === PAWN) {
    s = (isCap ? 'abcdefgh'[from & 7] + 'x' : '') + sqName(to);
    if (promo) s += '=' + ' PNBRQK'[promo];
  } else {
    s = ' PNBRQK'[t];
    let amb = false, sameFile = false, sameRank = false;
    for (const o of legal) {
      const of = o & 127;
      if (o === m || ((o >> 7) & 127) !== to || of === from || (board[of] & 7) !== t) continue;
      amb = true;
      if ((of & 7) === (from & 7)) sameFile = true;
      if ((of >> 4) === (from >> 4)) sameRank = true;
    }
    if (amb) {
      if (!sameFile) s += 'abcdefgh'[from & 7];
      else if (!sameRank) s += (from >> 4) + 1;
      else s += sqName(from);
    }
    if (isCap) s += 'x';
    s += sqName(to);
  }
  makeMove(m);
  if (isAttacked(kingSq[side], side ^ 1)) s += legalMoveInts().length ? '+' : '#';
  unmakeMove(m);
  return s;
}

function normSan(s) { return s.replace(/[+#!?x=]/g, '').replace(/e\.p\./, '').replace(/0/g, 'O'); }

function findMove(str) {
  str = String(str).trim();
  const legal = legalMoveInts();
  const low = str.toLowerCase();
  for (const m of legal) if (moveToUci(m) === low) return m;
  if (/^[a-h][1-8][a-h][1-8]$/.test(low)) for (const m of legal) if (moveToUci(m) === low + 'q') return m;
  const n = normSan(str);
  for (const m of legal) if (normSan(moveToSan(m, legal)) === n) return m;
  // lenient: pawn promotion without '=' or piece letter case
  return 0;
}

function setPosition(fen, moveList) {
  setFen(fen && fen !== 'startpos' ? fen : START_FEN);
  for (const mv of (moveList || [])) {
    const m = findMove(mv);
    if (!m) throw new Error('illegal move: ' + mv);
    makeMove(m);
  }
  sp = 0;
}

function playMove(str) {
  const m = findMove(str);
  if (!m) return null;
  const san = moveToSan(m);
  const uci = moveToUci(m);
  makeMove(m);
  sp = 0;
  return { san, uci };
}

function repetitionCount() {
  let c = 1;
  const lim = Math.max(0, histLen - 1 - halfmove);
  for (let i = histLen - 3; i >= lim; i -= 2) if (histLo[i] === hashLo && histHi[i] === hashHi) c++;
  return c;
}

function gameStatus() {
  const legal = legalMoveInts();
  const check = inCheck();
  if (legal.length === 0) return check ? 'checkmate' : 'stalemate';
  if (halfmove >= 100) return 'fifty';
  if (repetitionCount() >= 3) return 'threefold';
  const P = pieceCnt[PAWN] + pieceCnt[PAWN | 8], M = pieceCnt[ROOK] + pieceCnt[ROOK | 8] + pieceCnt[QUEEN] + pieceCnt[QUEEN | 8];
  const minors = pieceCnt[KNIGHT] + pieceCnt[BISHOP] + pieceCnt[KNIGHT | 8] + pieceCnt[BISHOP | 8];
  if (P === 0 && M === 0 && minors <= 1) return 'insufficient';
  return null;
}

function legalMoves() {
  const legal = legalMoveInts();
  return legal.map(m => ({ from: sqName(m & 127), to: sqName((m >> 7) & 127),
    promo: (m >> 14) & 7 ? ' pnbrqk'[(m >> 14) & 7] : null, uci: moveToUci(m), san: moveToSan(m, legal) }));
}

function pieceAt(name) { const p = board[sqFromName(name)]; return p ? PIECE_CHARS[p] : null; }

function newGame() { clearTT(); history.fill(0); counterMove.fill(0); killers.fill(0); }

const API = {
  START_FEN, setFen, getFen, setPosition, playMove, legalMoves, gameStatus, pieceAt, perft, search, newGame,
  inCheck, evaluate: () => evaluate(), sideToMove: () => (side === 0 ? 'w' : 'b'),
  setHash: (mb) => allocTT(mb), setStopSignal: (arr) => { stopSignal = arr; },
  stop: () => { stopped = true; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof importScripts === 'function' && typeof self !== 'undefined') {
  // Browser Web Worker mode
  self.onmessage = function (e) {
    const d = e.data || {};
    if (d.cmd === 'newgame') newGame();
    else if (d.cmd === 'search') {
      setPosition(d.fen, d.moves);
      const r = search({ movetime: d.movetime, depth: d.depth, nodes: d.nodes,
        onInfo: (info) => self.postMessage({ type: 'info', id: d.id, info }) });
      self.postMessage({ type: 'bestmove', id: d.id, result: r });
    }
  };
} else if (typeof window !== 'undefined') window.ChessEngine = API;
})();
