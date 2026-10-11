// Optimal solver: iterative-deepening depth-first search with a transposition
// table and a "free stopping" lower bound, so the first depth that yields a
// solution is the true minimum number of moves.
(function (root) {
  'use strict';

  const RR = root.RR || (typeof require !== 'undefined' ? require('./board.js') : {});
  const BIT = [1, 2, 4, 8];
  const OFFSET = [-16, 1, 16, -1];
  const UNREACHABLE = 255;

  const TABLE_BITS = 21;
  const TABLE_SIZE = 1 << TABLE_BITS;
  let tableLo = null;
  let tableHi = null;
  let tableDepth = null;

  // Fewest moves to reach `target` from every cell for a robot that could stop
  // anywhere along its path. Never overestimates the real distance.
  function minMoves(walls, target) {
    const dist = new Uint8Array(256).fill(UNREACHABLE);
    dist[target] = 0;
    let frontier = [target];
    let d = 0;
    while (frontier.length) {
      const next = [];
      d++;
      for (const cell of frontier) {
        for (let dir = 0; dir < 4; dir++) {
          let p = cell;
          while (!(walls[p] & BIT[dir])) {
            p += OFFSET[dir];
            if (dist[p] === UNREACHABLE) {
              dist[p] = d;
              next.push(p);
            }
          }
        }
      }
      frontier = next;
    }
    return dist;
  }

  // walls: 256 wall masks. robots: 4 or 5 cell indices. target: cell index.
  // active: index of the robot that must reach the target, or -1 for any.
  // opts: maxDepth, maxSolutions, timeMs, maxNodes. Use maxNodes rather than
  // timeMs when the result has to be the same on every device.
  // Returns { depth, solutions, nodes, complete } where depth is -1 if nothing
  // was found within the limits and each solution is a list of { r, d } moves.
  function solve(walls, robotsIn, target, active, opts) {
    opts = opts || {};
    const maxDepth = opts.maxDepth || 20;
    const maxSolutions = opts.maxSolutions || 1;
    const maxNodes = opts.maxNodes || Infinity;
    const deadline = opts.timeMs ? Date.now() + opts.timeMs : Infinity;

    const count = robotsIn.length;
    const robots = Int32Array.from(robotsIn);
    const result = { depth: -1, solutions: [], nodes: 0, complete: true };

    if (active >= 0 ? robots[active] === target : robotsIn.indexOf(target) >= 0) {
      result.depth = 0;
      result.solutions.push([]);
      return result;
    }

    if (!tableLo) {
      tableLo = new Uint32Array(TABLE_SIZE);
      tableHi = new Uint8Array(TABLE_SIZE);
      tableDepth = new Uint8Array(TABLE_SIZE);
    } else {
      tableLo.fill(0);
      tableHi.fill(0);
    }
    const keysLo = tableLo;
    const keysHi = tableHi;
    const depths = tableDepth;

    const dist = minMoves(walls, target);
    const occupied = new Uint8Array(256);
    for (let i = 0; i < count; i++) occupied[robots[i]] = 1;

    const pathR = new Int8Array(maxDepth + 1);
    const pathD = new Int8Array(maxDepth + 1);
    const sorted = new Int32Array(count);
    let ply = 0;
    let nodes = 0;
    let aborted = false;
    let keyLo = 0;
    let keyHi = 0;

    // Robots that are interchangeable for the goal are sorted so that
    // equivalent layouts share one table entry. The key is one byte per robot
    // (the low four in keyLo, a fifth in keyHi) and is never all zero because
    // no two robots share a cell.
    function computeKey() {
      let m = 0;
      if (active >= 0) sorted[m++] = robots[active];
      const first = m;
      for (let i = 0; i < count; i++) {
        if (i === active) continue;
        const v = robots[i];
        let j = m++;
        while (j > first && sorted[j - 1] > v) { sorted[j] = sorted[j - 1]; j--; }
        sorted[j] = v;
      }
      keyLo = ((sorted[0] << 24) | (sorted[1] << 16) | (sorted[2] << 8) | sorted[3]) >>> 0;
      keyHi = count > 4 ? sorted[4] : 0;
    }

    function lowerBound() {
      if (active >= 0) return dist[robots[active]];
      let h = dist[robots[0]];
      for (let i = 1; i < count; i++) if (dist[robots[i]] < h) h = dist[robots[i]];
      return h;
    }

    function search(remaining) {
      if (++nodes > maxNodes) aborted = true;
      else if ((nodes & 8191) === 0 && Date.now() > deadline) aborted = true;
      if (aborted || lowerBound() > remaining) return 0;

      computeKey();
      const lo = keyLo;
      const hi = keyHi;
      const slot = Math.imul(lo ^ Math.imul(hi + 1, 0x85EBCA6B), 0x9E3779B1) >>> (32 - TABLE_BITS);
      if (keysLo[slot] === lo && keysHi[slot] === hi && depths[slot] >= remaining) return 0;

      let found = 0;
      for (let r = 0; r < count; r++) {
        const from = robots[r];
        for (let d = 0; d < 4; d++) {
          const bit = BIT[d];
          const off = OFFSET[d];
          let to = from;
          while (!(walls[to] & bit) && !occupied[to + off]) to += off;
          if (to === from) continue;

          pathR[ply] = r;
          pathD[ply] = d;
          if (to === target && (active < 0 || r === active)) {
            const moves = [];
            for (let i = 0; i <= ply; i++) moves.push({ r: pathR[i], d: pathD[i] });
            result.solutions.push(moves);
            found++;
          } else if (remaining > 1) {
            robots[r] = to; occupied[from] = 0; occupied[to] = 1; ply++;
            found += search(remaining - 1);
            ply--; robots[r] = from; occupied[to] = 0; occupied[from] = 1;
          }
          if (aborted || result.solutions.length >= maxSolutions) return found;
        }
      }
      if (found === 0) {
        keysLo[slot] = lo;
        keysHi[slot] = hi;
        depths[slot] = remaining;
      }
      return found;
    }

    for (let depth = Math.max(1, lowerBound()); depth <= maxDepth; depth++) {
      search(depth);
      if (result.solutions.length) {
        result.depth = depth;
        break;
      }
      if (aborted) break;
    }
    result.nodes = nodes;
    result.complete = !aborted;
    return result;
  }

  // Collapses solutions that are the same moves in a different order and puts
  // the simplest ones (fewest robots, fewest switches) first.
  function distinctSolutions(solutions, limit) {
    const seen = new Set();
    const out = [];
    for (const moves of solutions) {
      const key = moves.map((m) => m.r * 4 + m.d).sort((a, b) => a - b).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      let switches = 0;
      for (let i = 1; i < moves.length; i++) if (moves[i].r !== moves[i - 1].r) switches++;
      out.push({ moves, robots: new Set(moves.map((m) => m.r)).size, switches });
    }
    out.sort((a, b) => a.robots - b.robots || a.switches - b.switches);
    return out.slice(0, limit).map((s) => s.moves);
  }

  const api = { solve, minMoves, distinctSolutions };
  root.RR = Object.assign(root.RR || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = root.RR;
})(typeof self !== 'undefined' ? self : globalThis);
