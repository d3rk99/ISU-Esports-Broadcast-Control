'use strict';

// Per-cell agreement gate for Observer 3 scoreboard values.
// A single OCR read never changes a displayed value by itself:
// - the first value needs AGREE_FIRST matching reads in a row,
// - a normal change needs AGREE_CHANGE matching reads in a row,
// - a change that breaks a rule (K/D/A going down, ult "required" changing,
//   an implausible jump) needs AGREE_CORRECTION matching reads in a row,
//   so a real correction (wrong first lock, new map) still gets through.
const AGREE_FIRST = 2;
const AGREE_CHANGE = 2;
const AGREE_CORRECTION = 4;
const MAX_KDA_STEP = 5; // more than 5 kills/deaths/assists between two sweeps is treated as suspicious

function sameValue(left, right) {
  if (left && typeof left === 'object') return JSON.stringify(left) === JSON.stringify(right);
  return left === right;
}

function isSuspicious(kind, current, next) {
  if (current === null || current === undefined) return false;
  if (kind === 'kda') return next < current || next - current > MAX_KDA_STEP;
  if (kind === 'ultimate') {
    return Number.isFinite(current?.required) && Number.isFinite(next?.required) && current.required !== next.required;
  }
  return false;
}

class ObserverCellConsensus {
  constructor({ agreeFirst = AGREE_FIRST, agreeChange = AGREE_CHANGE, agreeCorrection = AGREE_CORRECTION } = {}) {
    this.agreeFirst = agreeFirst;
    this.agreeChange = agreeChange;
    this.agreeCorrection = agreeCorrection;
    this.cells = new Map();
  }

  // Returns { accept: boolean, value, streak, needed }.
  // `current` is the value currently shown; `kind` is 'kda' | 'credits' | 'ultimate' | 'value'.
  observe(key, kind, current, next) {
    if (next === null || next === undefined) return { accept: false, value: current, streak: 0, needed: 0 };
    let cell = this.cells.get(key);
    if (!cell || !sameValue(cell.candidate, next)) {
      cell = { candidate: next, streak: 0 };
      this.cells.set(key, cell);
    }
    cell.streak += 1;
    if (current !== null && current !== undefined && sameValue(current, next)) {
      return { accept: true, value: current, streak: cell.streak, needed: 1 };
    }
    const needed = current === null || current === undefined
      ? this.agreeFirst
      : isSuspicious(kind, current, next) ? this.agreeCorrection : this.agreeChange;
    const accept = cell.streak >= needed;
    return { accept, value: accept ? next : current, streak: cell.streak, needed };
  }

  reset() {
    this.cells.clear();
  }
}

module.exports = { ObserverCellConsensus, AGREE_FIRST, AGREE_CHANGE, AGREE_CORRECTION, MAX_KDA_STEP };
