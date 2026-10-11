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
  let tableKeys = null;
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

  // walls: 256 wall masks. robots: 4 cell indices. target: cell index.
  // active: index of the robot that must reach the target, or -1 for any.
  // Returns { depth, solutions, nodes, complete } where depth is -1 if nothing
  // was found within the limits and each solution is a list of { r, d } moves.
  function solve(walls, robotsIn, target, active, opts) {
    opts = opts || {};
    const maxDepth = opts.maxDepth || 20;
    const maxSolutions = opts.maxSolutions || 1;
    const deadline = opts.timeMs ? Date.now() + opts.timeMs : Infinity;

    const robots = Int32Array.from(robotsIn);
    const result = { depth: -1, solutions: [], nodes: 0, complete: true };

    if (active >= 0 ? robots[active] === target : robotsIn.indexOf(target) >= 0) {
      result.depth = 0;
      result.solutions.push([]);
      return result;
    }

    if (!tableKeys) {
      tableKeys = new Uint32Array(TABLE_SIZE);
      tableDepth = new Uint8Array(TABLE_SIZE);
    } else {
      tableKeys.fill(0);
    }
    const keys = tableKeys;
    const depths = tableDepth;

    const dist = minMoves(walls, target);
    const occupied = new Uint8Array(256);
    for (let i = 0; i < 4; i++) occupied[robots[i]] = 1;

    const pathR = new Int8Array(maxDepth + 1);
    const pathD = new Int8Array(maxDepth + 1);
    let ply = 0;
    let nodes = 0;
    let aborted = false;

    // Robots that are interchangeable for the goal are sorted so that
    // equivalent layouts share one table entry. Keys are never zero because
    // no two robots share a cell.
    function stateKey() {
      let a, b, c, d;
      if (active >= 0) {
        a = robots[active];
        b = robots[active === 0 ? 1 : 0];
        c = robots[active <= 1 ? 2 : 1];
        d = robots[active === 3 ? 2 : 3];
      } else {
        a = robots[0]; b = robots[1]; c = robots[2]; d = robots[3];
        if (a > b) { const t = a; a = b; b = t; }
      }
      if (c > d) { const t = c; c = d; d = t; }
      if (b > c) { const t = b; b = c; c = t; }
      if (c > d) { const t = c; c = d; d = t; }
      if (active < 0) {
        if (a > b) { const t = a; a = b; b = t; }
        if (b > c) { const t = b; b = c; c = t; }
      }
      return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    }

    function lowerBound() {
      if (active >= 0) return dist[robots[active]];
      let h = dist[robots[0]];
      for (let i = 1; i < 4; i++) if (dist[robots[i]] < h) h = dist[robots[i]];
      return h;
    }

    function search(remaining) {
      if ((++nodes & 8191) === 0 && Date.now() > deadline) aborted = true;
      if (aborted || lowerBound() > remaining) return 0;

      const key = stateKey();
      const slot = Math.imul(key, 0x9E3779B1) >>> (32 - TABLE_BITS);
      if (keys[slot] === key && depths[slot] >= remaining) return 0;

      let found = 0;
      for (let r = 0; r < 4; r++) {
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
        keys[slot] = key;
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
      const key = moves.map((m) => m.r * 4 + m.d).sort().join(',');
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
