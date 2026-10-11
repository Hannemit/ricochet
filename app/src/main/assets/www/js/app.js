// Solo game flow (practice and daily) and the shared UI. A practice game is
// one board played through all of its targets, with robots staying where the
// previous round left them, as in the tabletop game. Multiplayer lives in
// versus.js and plugs into the same screen.
(function () {
  'use strict';

  const RR = self.RR;
  const NAMES = ['Red', 'Green', 'Blue', 'Yellow', 'Silver'];
  const SHAPES = ['circle', 'triangle', 'square', 'star'];
  const DIR_WORDS = ['up', 'right', 'down', 'left'];
  const KEYS = {
    practice: 'ricochet.game.v2',
    daily: 'ricochet.daily.v1',
    stats: 'ricochet.stats.v1',
    settings: 'ricochet.settings.v1',
  };
  // Preferred length of the best solution for each difficulty.
  const DIFFICULTY = {
    easy: { label: 'Easy', lo: 2, hi: 4 },
    medium: { label: 'Medium', lo: 4, hi: 7 },
    hard: { label: 'Hard', lo: 7, hi: 11 },
  };
  // The daily puzzle is five targets that get steadily harder.
  const DAILY_RANGES = [[2, 4], [3, 5], [4, 6], [5, 7], [6, 8]];
  const TIMER_PRESETS = [0, 30, 60, 120];

  const $ = (id) => document.getElementById(id);
  const renderer = new RR.Renderer($('board'));
  const versus = () => RR.versus;

  let S = null; // current solo game (practice or daily)
  const U = {   // transient view state
    selected: -1,
    panel: 'play',
    hintLevel: 0,
    hint: null,
    hintArrow: null,
    thinking: false,
    dealing: false,
    playback: null,
    token: 0,   // bumps when a new round is dealt or the game changes
    stamp: 0,   // bumps on every change to the robots
  };

  /* ---------- storage ---------- */

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  }

  const settings = Object.assign({
    difficulty: 'medium',
    timer: 60,       // seconds per target; 0 turns the timer off
    silver: true,
    sound: true,
    name: '',
    pid: Math.random().toString(36).slice(2, 10),
  }, load(KEYS.settings, {}));
  if (!DIFFICULTY[settings.difficulty]) settings.difficulty = 'medium';
  const saveSettings = () => { store(KEYS.settings, settings); RR.sound.enabled = settings.sound; };
  saveSettings();

  function save() {
    // A daily puzzle that is still being generated is not worth keeping.
    if (S && !(S.mode === 'daily' && !S.plan.length)) store(KEYS[S.mode], S);
  }

  function loadStats() {
    return Object.assign({ games: 0, rounds: 0, stars: 0, perfect: 0, streak: 0, bestStreak: 0, lastDaily: '' },
      load(KEYS.stats, {}));
  }

  function dateKey(offsetDays) {
    const d = new Date();
    d.setDate(d.getDate() + (offsetDays || 0));
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // The streak only counts while yesterday's or today's daily is done.
  function currentStreak(stats) {
    return stats.lastDaily === dateKey(0) || stats.lastDaily === dateKey(-1) ? stats.streak : 0;
  }

  /* ---------- solver client ---------- */

  let worker = null;
  let requestId = 0;
  const pending = new Map();

  function runLocally(job) {
    setTimeout(() => job.resolve(RR.solve(job.q.walls, job.q.robots, job.q.target, job.q.active, job.q.opts)), 0);
  }

  try {
    worker = new Worker('js/solver-worker.js');
    worker.onmessage = (e) => {
      const job = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (job) job.resolve(e.data.result);
    };
    worker.onerror = () => {
      worker = null;
      for (const job of pending.values()) runLocally(job);
      pending.clear();
    };
  } catch (e) {
    worker = null;
  }

  function solveAsync(board, robots, targetIndex, opts) {
    const t = board.targets[targetIndex];
    const q = {
      id: ++requestId,
      walls: board.walls,
      robots: robots.slice(),
      target: t.y * RR.SIZE + t.x,
      active: t.color === RR.WILD ? -1 : t.color,
      opts,
    };
    return new Promise((resolve) => {
      const job = { q, resolve };
      if (worker) {
        pending.set(q.id, job);
        worker.postMessage(q);
      } else {
        runLocally(job);
      }
    });
  }

  const packOpt = (res) => ({ depth: res.depth, solutions: RR.distinctSolutions(res.solutions, 5) });

  // Chooses the next target from `queue`: the first whose best solution fits
  // the difficulty, otherwise whichever comes closest. Resolves to
  // { ti, opt } (opt is null if no solution was found in time), to null if
  // every remaining target already has its robot on it, or to undefined if
  // `stale()` turned true while searching.
  async function pickTarget(board, robots, queue, difficulty, stale) {
    const { lo, hi } = DIFFICULTY[difficulty] || DIFFICULTY.medium;
    let pick = null;
    let shallow = null;
    const beyond = [];
    for (const ti of queue) {
      const res = await solveAsync(board, robots, ti, { maxDepth: hi, maxSolutions: 200, timeMs: 2500 });
      if (stale()) return undefined;
      if (res.depth >= lo) { pick = { ti, res }; break; }
      if (res.depth >= 1) {
        if (!shallow || res.depth > shallow.res.depth) shallow = { ti, res };
      } else if (res.depth < 0) {
        beyond.push(ti);
      }
    }
    if (!pick) {
      let deep = null;
      for (const ti of beyond.slice(0, 3)) {
        const res = await solveAsync(board, robots, ti, { maxDepth: 18, maxSolutions: 200, timeMs: 6000 });
        if (stale()) return undefined;
        if (res.depth > 0 && (!deep || res.depth < deep.res.depth)) deep = { ti, res };
        if (deep && deep.res.depth <= hi + 2) break;
      }
      if (deep && shallow) pick = deep.res.depth - hi <= lo - shallow.res.depth ? deep : shallow;
      else pick = deep || shallow;
      if (!pick && beyond.length) return { ti: beyond[0], opt: null };
    }
    return pick ? { ti: pick.ti, opt: packOpt(pick.res) } : null;
  }

  /* ---------- solo game flow ---------- */

  // The game shown on screen: the multiplayer view while one is running,
  // otherwise the solo game. Both use the same field names.
  const G = () => (versus().active() ? versus().view() : S);

  function blankRound() {
    return {
      target: -1, start: null, moves: [], solved: false, best: null, bestEnd: null,
      revealed: false, timedOut: false, hintMove: false, bestShown: false, opt: null, timeLeft: null,
    };
  }

  function newPractice() {
    const seed = (Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0;
    const board = RR.generateBoard(seed);
    const rng = RR.mulberry32(seed ^ 0x5bd1e995);
    S = Object.assign({
      v: 2,
      mode: 'practice',
      seed,
      walls: board.walls,
      targets: board.targets,
      robots: RR.randomRobots(rng, board, settings.silver ? 5 : 4),
      queue: RR.shuffle(rng, board.targets.map((_, i) => i)),
      results: [],
      done: false,
    }, blankRound());
    renderer.setBoard(S);
    deal();
  }

  function hashText(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  // Builds today's puzzle. Everything is derived from the date and the solver
  // is limited by node count rather than time, so every phone gets the same
  // five targets.
  async function startDaily() {
    const date = dateKey(0);
    const saved = load(KEYS.daily, null);
    if (saved && saved.v === 2 && saved.date === date && saved.plan.length === DAILY_RANGES.length) {
      adopt(saved);
      if (S.done) openSummary();
      return;
    }
    const token = ++U.token;
    const seed = hashText('ricochet-daily-' + date);
    const board = RR.generateBoard(seed);
    const rng = RR.mulberry32(seed ^ 0x2545f491);
    S = Object.assign({
      v: 2, mode: 'daily', date, seed,
      walls: board.walls, targets: board.targets,
      robots: RR.randomRobots(rng, board, 5),
      queue: [], plan: [], results: [], done: false,
    }, blankRound());
    resetRoundView();
    U.dealing = true;
    U.selected = -1;
    renderer.setBoard(S);
    render();

    const pool = RR.shuffle(rng, board.targets.map((_, i) => i));
    const used = new Set();
    const plan = [];
    let at = 0;
    for (const [lo, hi] of DAILY_RANGES) {
      for (let tries = 0; ; tries++) {
        const robots = RR.randomRobots(rng, board, 5);
        const ti = pool[at++ % pool.length];
        if (used.has(ti)) continue;
        const res = await solveAsync(board, robots, ti, { maxDepth: hi, maxSolutions: 200, maxNodes: 300000 });
        if (token !== U.token) return;
        // After many misses, accept anything that is at least two moves.
        if (res.depth >= (tries < 80 ? lo : 2)) {
          used.add(ti);
          plan.push({ robots, ti, opt: packOpt(res) });
          break;
        }
      }
    }
    S.plan = plan;
    deal();
  }

  function adopt(game) {
    U.token++;
    resetRoundView();
    U.dealing = false;
    S = game;
    renderer.setBoard(S);
    if (!S.done && S.target < 0) { deal(); return; }
    U.panel = S.done ? 'play' : S.solved ? 'solved' : S.timedOut ? 'timeup' : 'play';
    U.selected = -1;
    if (!S.done) {
      const color = S.targets[S.target].color;
      U.selected = color === RR.WILD ? -1 : color;
    }
    render();
  }

  function resetRoundView() {
    stopPlayback();
    U.panel = 'play';
    U.hintLevel = 0;
    U.hint = null;
    U.hintArrow = null;
    U.thinking = false;
    U.stamp++;
  }

  function totalRounds() {
    if (S.mode === 'daily') return DAILY_RANGES.length;
    return S.results.length + S.queue.length + (S.target >= 0 ? 1 : 0);
  }

  async function deal() {
    const token = ++U.token;
    const game = S;
    resetRoundView();
    U.dealing = true;
    U.selected = -1;
    Object.assign(S, blankRound());
    save();
    render();

    let pick;
    if (S.mode === 'daily') {
      const p = S.plan[S.results.length];
      S.robots = p.robots.slice();
      pick = { ti: p.ti, opt: p.opt };
    } else {
      pick = await pickTarget(S, S.robots, S.queue, settings.difficulty, () => token !== U.token || game !== S);
      if (pick === undefined) return;
      if (pick === null) {
        // Only targets that already have their robot parked on them are left.
        S.queue = [];
        finishGame();
        return;
      }
      S.queue.splice(S.queue.indexOf(pick.ti), 1);
    }

    S.target = pick.ti;
    S.start = S.robots.slice();
    S.opt = pick.opt;
    S.timeLeft = settings.timer > 0 ? settings.timer * 1000 : null;
    U.dealing = false;
    const color = S.targets[S.target].color;
    U.selected = color === RR.WILD ? -1 : color;
    save();
    render();
  }

  function playable() {
    return S && !versus().active() && !S.done && !U.dealing && !U.playback && S.target >= 0;
  }

  // Whether the player may move robots right now.
  function canMove() {
    if (versus().active()) return !U.playback && versus().canMove();
    return playable() && !S.solved;
  }

  function clearHint() {
    U.hint = null;
    U.hintArrow = null;
    if (U.hintLevel > 2) U.hintLevel = 2;
  }

  const roundClosed = () => S.best !== null || S.revealed || S.timedOut;

  function move(r, d) {
    if (!canMove()) return;
    if (versus().active()) { versus().move(r, d); return; }
    const from = S.robots[r];
    const to = RR.slide(S.walls, S.robots, r, d);
    U.selected = r;
    if (to === from) { render(); return; }
    S.robots[r] = to;
    S.moves.push({ r, d, from, to });
    U.stamp++;
    clearHint();
    U.panel = 'play';
    if (RR.isSolved(S.robots, S.targets[S.target])) {
      S.solved = true;
      S.bestShown = true;
      if (S.best === null || S.moves.length < S.best) {
        S.best = S.moves.length;
        S.bestEnd = S.robots.slice();
      }
      U.panel = 'solved';
      RR.sound.solved(!!S.opt && S.moves.length <= S.opt.depth);
    }
    save();
    render();
    renderer.animateMove(r, from, to);
  }

  function undo() {
    if (!playable() || !S.moves.length) return;
    const m = S.moves.pop();
    S.robots[m.r] = m.from;
    S.solved = false;
    U.selected = m.r;
    U.stamp++;
    clearHint();
    U.panel = 'play';
    save();
    render();
    renderer.animateMove(m.r, m.to, m.from);
  }

  function resetRound() {
    if (versus().active() || !S || S.done || U.dealing || S.target < 0) return;
    stopPlayback();
    S.robots = S.start.slice();
    S.moves = [];
    S.solved = false;
    U.stamp++;
    clearHint();
    U.panel = 'play';
    save();
    render();
  }

  async function hint() {
    if (!playable() || S.solved || U.thinking) return;
    U.panel = 'play';
    if (!U.hint) {
      if (!S.moves.length && S.opt) {
        U.hint = { depth: S.opt.depth, moves: S.opt.solutions[0], fromStart: true };
      } else {
        const stamp = U.stamp;
        U.thinking = true;
        render();
        const res = await solveAsync(S, S.robots, S.target, { maxDepth: 16, timeMs: 5000 });
        U.thinking = false;
        if (stamp !== U.stamp) { render(); return; }
        U.hint = res.depth > 0
          ? { depth: res.depth, moves: res.solutions[0], fromStart: !S.moves.length }
          : { depth: -1 };
      }
    }
    if (U.hint.depth > 0) {
      U.hintLevel = Math.min(3, U.hintLevel + 1);
      if (U.hint.fromStart) S.bestShown = true;
      if (U.hintLevel === 3) {
        const m = U.hint.moves[0];
        S.hintMove = true;
        U.selected = m.r;
        U.hintArrow = { from: S.robots[m.r], to: RR.slide(S.walls, S.robots, m.r, m.d) };
      }
      save();
    }
    render();
  }

  function showSolutions(confirmed) {
    const g = G();
    if (!g || !g.opt || g.target < 0 || U.dealing) return;
    if (versus().active()) {
      if (!versus().canSeeSolutions()) return;
    } else {
      if (S.done) return;
      if (!roundClosed() && !confirmed) {
        U.panel = 'confirm-reveal';
        render();
        return;
      }
      if (S.best === null) S.revealed = true;
      S.bestShown = true;
      clearHint();
      save();
    }
    U.panel = 'solutions';
    startPlayback(0);
  }

  function starsFor() {
    if (S.best === null || S.revealed || S.timedOut) return 0;
    const opt = S.opt ? S.opt.depth : S.best;
    let stars = S.best <= opt ? 3 : S.best <= opt + 2 ? 2 : 1;
    if (S.hintMove) stars = Math.min(stars, 2);
    return stars;
  }

  function next(confirmed) {
    if (versus().active()) { stopPlayback(); versus().next(); return; }
    if (!S || S.done || U.dealing || S.target < 0) return;
    if (!roundClosed() && !confirmed) {
      U.panel = 'confirm-skip';
      render();
      return;
    }
    stopPlayback();
    const stars = starsFor();
    S.results.push({
      target: S.target,
      moves: S.revealed || S.timedOut ? null : S.best,
      optimal: S.opt ? S.opt.depth : null,
      stars,
    });
    const stats = loadStats();
    stats.rounds++;
    stats.stars += stars;
    if (stars === 3) stats.perfect++;
    store(KEYS.stats, stats);

    // The next round starts from the player's best finish, or from the best
    // solution if they did not find one.
    if (S.bestEnd) S.robots = S.bestEnd.slice();
    else if (S.opt) S.robots = RR.replay(S.walls, S.start, S.opt.solutions[0]).pop();
    else S.robots = S.start.slice();

    const more = S.mode === 'daily' ? S.results.length < S.plan.length : S.queue.length > 0;
    if (more) deal();
    else finishGame();
  }

  function finishGame() {
    U.token++;
    resetRoundView();
    U.dealing = false;
    U.selected = -1;
    S.done = true;
    Object.assign(S, blankRound());
    const stats = loadStats();
    stats.games++;
    if (S.mode === 'daily' && stats.lastDaily !== S.date) {
      stats.streak = stats.lastDaily === dateKey(-1) ? stats.streak + 1 : 1;
      stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
      stats.lastDaily = S.date;
    }
    store(KEYS.stats, stats);
    save();
    render();
    openSummary();
  }

  /* ---------- timer ---------- */

  let lastTick = performance.now();
  let lastSecond = -1;

  function soloTimerRunning() {
    return S && !versus().active() && S.timeLeft !== null && !S.done && !U.dealing && S.target >= 0 &&
      !roundClosed() && $('scrim').hidden && !document.hidden;
  }

  function tick() {
    const now = performance.now();
    const dt = Math.min(1000, now - lastTick);
    lastTick = now;
    if (versus().connected()) versus().tick();
    if (soloTimerRunning()) {
      S.timeLeft -= dt;
      if (S.timeLeft <= 0) {
        S.timeLeft = 0;
        S.timedOut = true;
        S.bestShown = true;
        clearHint();
        U.panel = 'timeup';
        RR.sound.timeUp();
        save();
        render();
      }
    }
    updateTimer();
  }

  function formatTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function updateTimer() {
    let t = null; // { left, total } in ms
    if (versus().active()) t = versus().timer();
    else if (S && S.timeLeft !== null && !S.done && S.target >= 0 && !U.dealing) {
      t = { left: S.timeLeft, total: settings.timer * 1000, frozen: roundClosed() };
    }
    const el = $('timeText');
    const bar = $('timeBar');
    if (!t) {
      el.textContent = '';
      bar.style.width = '0';
      lastSecond = -1;
      return;
    }
    const low = t.left <= 10000 && !t.frozen;
    el.textContent = ' · ' + formatTime(t.left);
    el.classList.toggle('low', low);
    bar.classList.toggle('low', low);
    bar.style.width = Math.max(0, Math.min(100, t.left / Math.max(1, t.total) * 100)) + '%';
    const sec = Math.ceil(t.left / 1000);
    if (sec !== lastSecond && sec <= 5 && sec > 0 && !t.frozen && lastSecond !== -1) RR.sound.tick();
    lastSecond = sec;
  }

  /* ---------- solution playback ---------- */

  function startPlayback(index) {
    stopPlayback();
    const g = G();
    const moves = g.opt.solutions[index];
    U.playback = {
      index,
      moves,
      states: RR.replay(g.walls, g.start, moves),
      step: 0,
      timer: 0,
    };
    U.selected = -1;
    render();
    setPlaying(true);
  }

  function stopPlayback() {
    if (U.playback) clearInterval(U.playback.timer);
    U.playback = null;
  }

  function setPlaying(on) {
    const pb = U.playback;
    if (!pb) return;
    clearInterval(pb.timer);
    pb.timer = 0;
    if (on) {
      if (pb.step >= pb.moves.length) pb.step = 0;
      pb.timer = setInterval(() => {
        stepPlayback(1);
        if (pb.step >= pb.moves.length) setPlaying(false);
      }, 750);
    }
    render();
  }

  function stepPlayback(delta) {
    const pb = U.playback;
    if (!pb) return;
    const to = Math.max(0, Math.min(pb.moves.length, pb.step + delta));
    if (to === pb.step) return;
    const forward = to > pb.step;
    const m = pb.moves[forward ? pb.step : to];
    const a = pb.states[pb.step][m.r];
    pb.step = to;
    render();
    renderer.animateMove(m.r, a, pb.states[to][m.r]);
  }

  function closeSolutions() {
    stopPlayback();
    U.panel = versus().active() ? 'play' : S.solved ? 'solved' : S.timedOut ? 'timeup' : 'play';
    render();
  }

  /* ---------- rendering ---------- */

  const FLAME = '<svg class="flame" viewBox="0 0 24 24"><path d="M12 2c1 4 5 5.5 5 11a5 5 0 0 1-10 0c0-2 1-3.2 2-4.2.3 1.6 1 2.2 1.7 2.2C11 8 10.5 5 12 2z"/></svg>';
  const ARROW = (d) => `<svg class="d${d}" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
  const chip = (m, cls) => `<span class="chip r${m.r} ${cls || ''}">${ARROW(m.d)}</span>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function starsHtml(n) {
    return '★'.repeat(n) + `<span class="off">${'★'.repeat(3 - n)}</span>`;
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function targetWords(t) {
    if (t.color === RR.WILD) return '<span class="who">Any robot</span> to the vortex';
    return `<span class="who r${t.color}">${NAMES[t.color]} robot</span> to the ${NAMES[t.color].toLowerCase()} ${SHAPES[t.shape]}`;
  }

  function hintHtml() {
    if (U.thinking) return '<div class="card"><div class="label">Hint</div><p>Working out the best route from here…</p></div>';
    const h = U.hint;
    if (!h) return '';
    if (h.depth < 0) {
      return '<div class="card"><div class="label">Hint</div><p>There is no short route from this position. Undo a few moves or reset, then ask again.</p></div>';
    }
    const lines = [];
    lines.push(h.fromStart
      ? `The best solution takes <b>${plural(h.depth, 'move')}</b>.`
      : `From here it can be done in <b>${plural(h.depth, 'move')}</b>.`);
    if (U.hintLevel >= 2) {
      const used = [...new Set(h.moves.map((m) => m.r))].sort();
      const names = used.map((r) => `<b>${NAMES[r].toLowerCase()}</b>`);
      const list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
      lines.push(used.length === 1 ? `Only the ${list} robot moves.` : `It uses the ${list} robots.`);
    }
    if (U.hintLevel >= 3) {
      const m = h.moves[0];
      lines.push(`<span class="inline-move">Next move: ${chip(m)} <b>${NAMES[m.r]} ${DIR_WORDS[m.d]}</b></span>`);
    }
    const more = U.hintLevel < 3 ? '<p class="muted">Tap Hint again for more.</p>' : '';
    return `<div class="card"><div class="label">Hint ${U.hintLevel} of 3</div>${lines.map((l) => `<p>${l}</p>`).join('')}${more}</div>`;
  }

  function solutionsHtml() {
    const pb = U.playback;
    const opt = G().opt;
    const count = opt.solutions.length;
    const rows = opt.solutions.map((moves, i) => {
      const active = i === pb.index;
      const chips = moves.map((m, k) => {
        const cls = active ? (k < pb.step ? 'done' : '') + (k === pb.step - 1 ? ' now' : '') : '';
        return `<span data-step="${k + 1}">${chip(m, cls)}</span>`;
      }).join('');
      return `<li class="sol ${active ? 'active' : ''}" data-sol="${i}"><span class="sol-n">${i + 1}</span><span class="chips">${chips}</span></li>`;
    }).join('');
    const playing = !!pb.timer;
    return `<div class="sol-head"><b>${count === 1 ? 'Best solution' : `${count} best solutions`} · ${plural(opt.depth, 'move')}</b>` +
      '<button class="link" data-act="close-solutions">Back to game</button></div>' +
      `<ol class="sols">${rows}</ol>` +
      '<div class="transport">' +
      '<button data-act="pb-start" aria-label="Back to start"><svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14l-10-7z"/></svg></button>' +
      '<button data-act="pb-prev" aria-label="Step back"><svg viewBox="0 0 24 24"><path d="M17 5v14L7 12z"/></svg></button>' +
      `<button data-act="pb-play" aria-label="${playing ? 'Pause' : 'Play'}"><svg viewBox="0 0 24 24">${playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>'}</svg></button>` +
      '<button data-act="pb-next" aria-label="Step forward"><svg viewBox="0 0 24 24"><path d="M7 5v14l10-7z"/></svg></button>' +
      '</div>';
  }

  function panelHtml() {
    if (U.panel === 'solutions' && U.playback) return solutionsHtml();
    if (versus().active()) return versus().panelHtml();

    if (S.done) {
      return '<p class="tip">' + (S.mode === 'daily' ? 'Today’s puzzle is done. A new one arrives at midnight.' : 'Board complete.') + '</p>' +
        '<div class="row"><button class="btn primary" data-act="summary">See results</button>' +
        (S.mode === 'daily' ? '<button class="btn" data-act="practice">Practice</button>' : '<button class="btn" data-act="new-confirmed">New board</button>') + '</div>';
    }
    if (U.dealing) {
      return `<p class="tip">${S.mode === 'daily' && !S.plan.length ? 'Preparing today’s puzzle…' : 'Setting up the next target…'}</p>`;
    }
    if (U.panel === 'confirm-reveal') {
      return '<div class="card"><p><b>Show the best solution?</b></p><p>This round will score no stars.</p></div>' +
        '<div class="row"><button class="btn" data-act="cancel">Keep trying</button><button class="btn primary" data-act="reveal">Show it</button></div>';
    }
    if (U.panel === 'confirm-skip') {
      return '<div class="card"><p><b>Skip this target?</b></p><p>The round scores no stars.</p></div>' +
        '<div class="row"><button class="btn" data-act="cancel">Keep trying</button><button class="btn primary" data-act="skip">Skip</button></div>';
    }
    if (U.panel === 'timeup' && S.timedOut && !S.solved) {
      return '<div class="card"><p><b>Time’s up</b></p><p>No stars for this target. You can keep trying, or look at the best solution.</p></div>' +
        '<div class="row"><button class="btn" data-act="cancel">Keep trying</button>' +
        (S.opt ? '<button class="btn" data-act="solutions">Best solutions</button>' : '') +
        '<button class="btn primary" data-act="next">Next target</button></div>';
    }
    if (U.panel === 'solved' && S.solved) {
      const stars = starsFor();
      const n = S.moves.length;
      let note;
      if (!S.opt) note = 'Nicely done.';
      else if (n <= S.opt.depth) note = 'That is the best possible.';
      else note = `The best possible is ${plural(S.opt.depth, 'move')}.`;
      if (S.timedOut) note += ' No stars after the timer ran out.';
      else if (S.revealed) note += ' No stars after seeing the solution.';
      else if (S.hintMove && stars === 2 && n <= (S.opt ? S.opt.depth : n)) note += ' One star off for the move hint.';
      const canImprove = S.opt && n > S.opt.depth;
      return `<div class="card result"><div class="stars">${starsHtml(stars)}</div>` +
        `<div class="result-text"><b>Solved in ${plural(n, 'move')}</b><span>${note}</span></div></div>` +
        '<div class="row">' +
        (canImprove ? '<button class="btn" data-act="retry">Try again</button>' : '') +
        (S.opt ? '<button class="btn" data-act="solutions">Best solutions</button>' : '') +
        '<button class="btn primary" data-act="next">Next target</button></div>';
    }
    const hint = hintHtml();
    if (hint) return hint;
    if (!S.moves.length) {
      return '<p class="tip">Tap a robot, then swipe to send it sliding. It only stops at a wall or another robot.</p>';
    }
    const trail = S.moves.slice(-12).map((m) => chip(m)).join('');
    return `<div class="chips centered">${trail}</div>`;
  }

  function drawGoalIcon() {
    const c = $('goalIcon');
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const g = G();
    if (!g || g.target < 0) return;
    const t = g.targets[g.target];
    RR.drawTarget(ctx, c.width / 2, c.height / 2, c.width * 0.36, t.color, t.shape, renderer.theme.robots);
  }

  function render() {
    const g = G();
    if (!g) return;
    const vs = versus().active();
    if (renderer.board !== g) renderer.setBoard(g);

    if (vs) {
      $('round').innerHTML = versus().roundLabel();
    } else {
      const total = totalRounds();
      const stars = S.results.reduce((a, r) => a + r.stars, 0);
      const what = S.mode === 'daily' ? 'Daily' : 'Round';
      $('round').innerHTML = S.done
        ? `Finished · <b>★ ${stars}</b>`
        : `${what} <b>${Math.min(S.results.length + 1, total)}</b> of ${total} · <b>★ ${stars}</b>`;
    }

    const hasTarget = g.target >= 0;
    $('goalText').innerHTML = hasTarget ? targetWords(g.targets[g.target]) : (!vs && S.done ? 'All done' : '…');
    $('moveCount').textContent = g.moves.length;
    $('bestLabel').textContent = vs ? 'bid' : 'best';
    $('bestCount').textContent = vs ? versus().bidText() : (hasTarget && S.opt && S.bestShown ? S.opt.depth : '?');
    drawGoalIcon();

    const pb = U.playback;
    let scene;
    if (pb) {
      scene = {
        robots: pb.states[pb.step],
        target: g.target,
        trails: pb.moves.slice(0, pb.step).map((m, i) => ({ r: m.r, from: pb.states[i][m.r], to: pb.states[i + 1][m.r] })),
        selected: -1,
        ghosts: [],
        hint: null,
      };
    } else {
      const ghosts = [];
      const movable = canMove();
      if (U.selected >= g.robots.length) U.selected = -1;
      if (movable && U.selected >= 0) {
        for (let d = 0; d < 4; d++) {
          const to = RR.slide(g.walls, g.robots, U.selected, d);
          if (to !== g.robots[U.selected]) ghosts.push(to);
        }
      }
      scene = {
        robots: g.robots,
        target: g.target,
        trails: g.moves,
        selected: movable ? U.selected : -1,
        ghosts,
        hint: vs ? null : U.hintArrow,
      };
    }
    renderer.setScene(scene);

    $('panel').innerHTML = panelHtml();

    if (vs) {
      const canNext = versus().canNext();
      $('undoBtn').disabled = true;
      $('resetBtn').disabled = true;
      $('hintBtn').disabled = true;
      $('solutionBtn').disabled = !versus().canSeeSolutions();
      $('nextBtn').disabled = !canNext;
      $('nextBtn').classList.toggle('primary', canNext);
      $('nextLabel').textContent = 'Next';
    } else {
      const idle = !S.done && !U.dealing && hasTarget;
      $('undoBtn').disabled = !idle || !!pb || !S.moves.length;
      $('resetBtn').disabled = !idle || (!S.moves.length && !pb);
      $('hintBtn').disabled = !idle || !!pb || S.solved;
      $('solutionBtn').disabled = !idle || !S.opt;
      $('nextBtn').disabled = !idle;
      $('nextBtn').classList.toggle('primary', idle && roundClosed());
      $('nextLabel').textContent = roundClosed() ? 'Next' : 'Skip';
    }
    updateTimer();
  }

  /* ---------- dialogs ---------- */

  let dialogKind = '';

  function openDialog(html, kind) {
    dialogKind = kind || '';
    $('dialog').innerHTML = html;
    $('scrim').hidden = false;
  }

  function closeDialog() {
    dialogKind = '';
    $('scrim').hidden = true;
    lastTick = performance.now();
  }

  function openHome() {
    if (versus().connected()) { versus().openMenu(); return; }
    const stats = loadStats();
    const streak = currentStreak(stats);
    const daily = load(KEYS.daily, null);
    const today = daily && daily.date === dateKey(0) && daily.plan.length ? daily : null;
    const practice = load(KEYS.practice, null);
    const practiceLive = practice && practice.v === 2 && !practice.done;

    let dailyNote;
    if (today && today.done) {
      const stars = today.results.reduce((a, r) => a + r.stars, 0);
      dailyNote = `Done today · ★ ${stars} of ${DAILY_RANGES.length * 3}`;
    } else if (today) {
      dailyNote = `In progress · target ${today.results.length + 1} of ${DAILY_RANGES.length}`;
    } else {
      dailyNote = streak > 0 && stats.lastDaily !== dateKey(0)
        ? `Five targets · play today to keep your streak`
        : 'Five targets, the same for everyone today';
    }
    const practiceNote = practiceLive
      ? `Continue · round ${practice.results.length + 1} of ${practice.results.length + practice.queue.length + (practice.target >= 0 ? 1 : 0)}`
      : 'A fresh board, as many as you like';

    openDialog(
      '<div class="home-head"><h2>Ricochet</h2>' +
      `<div class="streak ${streak ? 'lit' : ''}" title="Daily streak">${FLAME}<b>${streak}</b> day${streak === 1 ? '' : 's'}</div></div>` +
      '<div class="stack">' +
      `<button class="tile" data-act="daily"><b>Daily puzzle</b><span>${dailyNote}</span></button>` +
      `<button class="tile" data-act="practice"><b>Practice</b><span>${practiceNote}</span></button>` +
      (practiceLive ? '<button class="tile slim" data-act="new"><b>New practice board</b></button>' : '') +
      '<button class="tile" data-act="friend"><b>Play with a friend</b><span>Live bidding over the internet</span></button>' +
      '</div>' +
      '<div class="row"><button class="btn" data-act="settings">Settings</button><button class="btn" data-act="help">How to play</button></div>' +
      '<div class="stats">' +
      `<div><b>${stats.rounds}</b><span class="muted">targets</span></div>` +
      `<div><b>${stats.stars}</b><span class="muted">stars</span></div>` +
      `<div><b>${stats.bestStreak}</b><span class="muted">best streak</span></div></div>` +
      (S ? '<button class="btn quiet" data-act="close">Back to game</button>' : ''), 'home');
  }

  function seg(name, options, value) {
    return `<div class="seg" role="radiogroup" style="grid-template-columns:repeat(${options.length},1fr)">` +
      options.map((o) => `<button role="radio" aria-checked="${o[0] === value}" data-set="${name}" data-value="${o[0]}">${o[1]}</button>`).join('') +
      '</div>';
  }

  function openSettings() {
    const d = DIFFICULTY[settings.difficulty];
    const custom = TIMER_PRESETS.indexOf(settings.timer) < 0;
    const timerValue = custom ? 'custom' : String(settings.timer);
    openDialog(
      '<h2>Settings</h2>' +
      '<div class="field"><div class="label">Difficulty</div>' +
      seg('difficulty', Object.keys(DIFFICULTY).map((k) => [k, DIFFICULTY[k].label]), settings.difficulty) +
      `<p class="muted">Practice targets whose best solution takes ${d.lo} to ${d.hi} moves. Applies from the next target.</p></div>` +
      '<div class="field"><div class="label">Timer per target</div>' +
      seg('timer', [['0', 'Off'], ['30', '0:30'], ['60', '1:00'], ['120', '2:00'], ['custom', 'Custom']], timerValue) +
      (custom ? `<label class="inline-field">Seconds <input id="timerCustom" type="number" inputmode="numeric" min="5" max="900" value="${settings.timer}"></label>` : '') +
      '<p class="muted">When it runs out the target scores no stars. In a game with a friend it is the time left to bid once someone has bid first.</p></div>' +
      '<div class="field"><div class="label">Silver robot</div>' +
      seg('silver', [['true', 'On'], ['false', 'Off']], String(settings.silver)) +
      '<p class="muted">A fifth robot with no target of its own. Applies to new practice boards.</p></div>' +
      '<div class="field"><div class="label">Sound</div>' +
      seg('sound', [['true', 'On'], ['false', 'Off']], String(settings.sound)) + '</div>' +
      '<button class="btn primary" data-act="home">Done</button>', 'settings');
  }

  function applySetting(name, value) {
    if (name === 'difficulty') settings.difficulty = value;
    else if (name === 'timer') settings.timer = value === 'custom' ? 90 : +value;
    else if (name === 'silver') settings.silver = value === 'true';
    else if (name === 'sound') settings.sound = value === 'true';
    saveSettings();
    if (name === 'sound' && settings.sound) RR.sound.bid();
    openSettings();
  }

  function openHelp() {
    openDialog(
      '<h2>How to play</h2>' +
      '<ol>' +
      '<li>Each round names a robot and a target. Get that robot to stop exactly on the target. The vortex accepts any robot.</li>' +
      '<li>Robots slide in a straight line and only stop when they hit a wall or another robot. Use the other robots as blockers. The silver robot is only ever a blocker.</li>' +
      '<li>Tap a robot to select it, then swipe in a direction. You can also tap one of the ring markers, or anywhere in the robot’s row or column.</li>' +
      '<li>Fewer moves is better. Three stars for matching the best possible solution, two for coming within two moves, one for solving it at all.</li>' +
      '</ol>' +
      '<p class="muted">Hint reveals a little more each time you tap it: the best move count, the robots involved, then the next move. Solution shows every best solution and plays it on the board.</p>' +
      '<p class="muted">With a friend, nobody moves anything at first. Find a route in your head and bid its length. The lowest bid gets to prove it on the board and wins the target.</p>' +
      '<button class="btn primary" data-act="home">Got it</button>', 'help');
  }

  function openSummary() {
    const rounds = S.results.length;
    const stars = S.results.reduce((a, r) => a + r.stars, 0);
    const solved = S.results.filter((r) => r.moves !== null);
    const perfect = S.results.filter((r) => r.stars === 3).length;
    const moves = solved.reduce((a, r) => a + r.moves, 0);
    const optimal = solved.reduce((a, r) => a + (r.optimal === null ? r.moves : r.optimal), 0);
    const daily = S.mode === 'daily';
    const streak = currentStreak(loadStats());
    openDialog(
      `<h2>${daily ? 'Daily puzzle complete' : 'Board complete'}</h2>` +
      `<div class="big-stars">★ ${stars} <small>of ${rounds * 3}</small></div>` +
      (daily ? `<div class="streak lit centered">${FLAME}<b>${streak}</b> day streak</div>` : '') +
      '<div class="stats">' +
      `<div><b>${solved.length}/${rounds}</b><span class="muted">solved</span></div>` +
      `<div><b>${perfect}</b><span class="muted">perfect</span></div>` +
      `<div><b>${moves}</b><span class="muted">moves (best ${optimal})</span></div></div>` +
      '<div class="stack">' +
      (daily ? '<button class="btn primary" data-act="practice">Keep playing: practice</button>'
        : '<button class="btn primary" data-act="new-confirmed">New board</button>') +
      '<button class="btn quiet" data-act="home">Home</button></div>', 'summary');
  }

  /* ---------- input ---------- */

  const actions = {
    cancel() { U.panel = S.solved ? 'solved' : 'play'; render(); },
    reveal() { showSolutions(true); },
    skip() { next(true); },
    next() { next(false); },
    retry() { resetRound(); },
    solutions() { showSolutions(false); },
    'close-solutions': closeSolutions,
    'pb-start'() { setPlaying(false); U.playback.step = 0; render(); },
    'pb-prev'() { setPlaying(false); stepPlayback(-1); },
    'pb-next'() { setPlaying(false); stepPlayback(1); },
    'pb-play'() { setPlaying(!U.playback.timer); },
    summary: openSummary,
    close: closeDialog,
    home: openHome,
    help: openHelp,
    settings: openSettings,
    friend() { versus().openEntry(); },
    daily() { closeDialog(); save(); startDaily(); },
    practice() {
      closeDialog();
      save();
      const saved = load(KEYS.practice, null);
      if (saved && saved.v === 2 && !saved.done) adopt(saved);
      else newPractice();
    },
    new() {
      openDialog('<h2>Start a new board?</h2><p>Your current practice board will be discarded.</p>' +
        '<div class="stack"><button class="btn primary" data-act="new-confirmed">Start new board</button>' +
        '<button class="btn quiet" data-act="home">Cancel</button></div>', 'confirm');
    },
    'new-confirmed'() { closeDialog(); save(); U.token++; newPractice(); },
  };

  function onAction(e) {
    const el = e.target.closest('[data-act], [data-set], [data-step], [data-sol], [data-vs]');
    if (!el) return;
    if (el.dataset.vs) {
      versus().onAction(el.dataset.vs, el);
    } else if (el.dataset.act) {
      const fn = actions[el.dataset.act];
      if (fn) fn();
    } else if (el.dataset.set) {
      applySetting(el.dataset.set, el.dataset.value);
    } else if (el.dataset.step && U.playback) {
      const sol = +el.closest('[data-sol]').dataset.sol;
      if (sol !== U.playback.index) { startPlayback(sol); return; }
      setPlaying(false);
      U.playback.step = +el.dataset.step;
      render();
    } else if (el.dataset.sol && U.playback) {
      startPlayback(+el.dataset.sol);
    }
  }

  $('panel').addEventListener('click', onAction);
  $('dialog').addEventListener('click', onAction);
  $('dialog').addEventListener('change', (e) => {
    if (e.target.id === 'timerCustom') {
      settings.timer = Math.max(5, Math.min(900, Math.round(+e.target.value) || 60));
      saveSettings();
      e.target.value = settings.timer;
    }
  });
  $('scrim').addEventListener('click', (e) => {
    // Only dialogs that are safe to dismiss close on an outside tap.
    if (e.target === $('scrim') && S && ['home', 'help', 'settings', 'summary'].indexOf(dialogKind) >= 0) closeDialog();
  });
  $('menuBtn').addEventListener('click', openHome);
  $('undoBtn').addEventListener('click', undo);
  $('resetBtn').addEventListener('click', resetRound);
  $('hintBtn').addEventListener('click', hint);
  $('solutionBtn').addEventListener('click', () => {
    if (U.playback) closeSolutions(); else showSolutions(false);
  });
  $('nextBtn').addEventListener('click', () => next(false));
  document.addEventListener('pointerdown', () => RR.sound.unlock(), true);

  // Board gestures: press a robot to select it, swipe to move, or tap a cell
  // in line with the selected robot.
  let gesture = null;
  const canvas = $('board');

  function robotNear(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const cell = rect.width / RR.SIZE;
    let best = -1;
    let bestDist = cell * 0.95;
    G().robots.forEach((c, i) => {
      const dx = rect.left + ((c % RR.SIZE) + 0.5) * cell - clientX;
      const dy = rect.top + ((c >> 4) + 0.5) * cell - clientY;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!canMove()) return;
    canvas.setPointerCapture(e.pointerId);
    const cell = renderer.cellAt(e.clientX, e.clientY);
    const hit = G().robots.indexOf(cell);
    gesture = { x: e.clientX, y: e.clientY, cell, hit, near: robotNear(e.clientX, e.clientY), moved: false };
    if (hit >= 0 && hit !== U.selected) {
      U.selected = hit;
      render();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!gesture || gesture.moved) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    const threshold = Math.max(14, renderer.cell * 0.5);
    if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return;
    gesture.moved = true;
    const r = gesture.hit >= 0 ? gesture.hit : gesture.near >= 0 ? gesture.near : U.selected;
    if (r < 0) return;
    const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RR.E : RR.W) : (dy > 0 ? RR.S : RR.N);
    move(r, d);
  });

  canvas.addEventListener('pointerup', () => {
    const g = gesture;
    gesture = null;
    if (!g || g.moved || g.hit >= 0 || g.cell < 0 || !canMove()) return;
    if (U.selected >= 0) {
      const at = G().robots[U.selected];
      const dx = (g.cell % RR.SIZE) - (at % RR.SIZE);
      const dy = (g.cell >> 4) - (at >> 4);
      if (dx === 0 && dy !== 0) { move(U.selected, dy > 0 ? RR.S : RR.N); return; }
      if (dy === 0 && dx !== 0) { move(U.selected, dx > 0 ? RR.E : RR.W); return; }
    }
    if (g.near >= 0) {
      U.selected = g.near;
      render();
    }
  });

  canvas.addEventListener('pointercancel', () => { gesture = null; });

  document.addEventListener('keydown', (e) => {
    if (!$('scrim').hidden) return;
    const dir = { ArrowUp: RR.N, ArrowRight: RR.E, ArrowDown: RR.S, ArrowLeft: RR.W }[e.key];
    if (dir !== undefined && U.selected >= 0) { e.preventDefault(); move(U.selected, dir); return; }
    if (e.key >= '1' && e.key <= '5' && canMove() && +e.key <= G().robots.length) { U.selected = +e.key - 1; render(); }
    else if (e.key === 'z' || e.key === 'Backspace') undo();
    else if (e.key === 'r') resetRound();
    else if (e.key === 'h') hint();
  });

  /* ---------- start-up ---------- */

  function fitBoard() {
    const size = Math.floor($('boardWrap').clientWidth);
    if (size > 0 && size !== renderer.size) renderer.resize(size);
  }

  new ResizeObserver(fitBoard).observe($('boardWrap'));
  window.addEventListener('resize', fitBoard);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    renderer.refreshTheme();
    drawGoalIcon();
  });
  document.addEventListener('visibilitychange', () => {
    lastTick = performance.now();
    if (document.hidden) save();
  });
  setInterval(tick, 200);

  // What versus.js needs from here.
  RR.app = {
    settings, saveSettings, render, openDialog, closeDialog, openHome, pickTarget,
    esc, chip, plural, NAMES, DIFFICULTY,
    dialogKind: () => dialogKind,
    animate: (r, from, to) => renderer.animateMove(r, from, to),
    select(r) { U.selected = r; },
    // Called when a multiplayer game starts or ends.
    reset() { U.token++; resetRoundView(); U.dealing = false; U.selected = -1; },
    state: () => S,
    view: () => U,
  };

  fitBoard();
  const saved = load(KEYS.practice, null);
  if (saved && saved.v === 2 && Array.isArray(saved.walls) && saved.walls.length === RR.CELLS) adopt(saved);
  else newPractice();
  openHome();
})();
