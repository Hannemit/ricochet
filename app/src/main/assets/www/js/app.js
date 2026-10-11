// Game flow and UI. A game is one board played through all of its targets;
// robots stay where the previous round left them, as in the tabletop game.
(function () {
  'use strict';

  const RR = self.RR;
  const NAMES = ['Red', 'Green', 'Blue', 'Yellow'];
  const SHAPES = ['circle', 'triangle', 'square', 'star'];
  const DIR_WORDS = ['up', 'right', 'down', 'left'];
  const STORE = 'ricochet.game.v1';
  const STATS = 'ricochet.stats.v1';
  // Preferred length of the best solution for each difficulty.
  const DIFFICULTY = {
    easy: { label: 'Easy', lo: 2, hi: 4 },
    medium: { label: 'Medium', lo: 4, hi: 7 },
    hard: { label: 'Hard', lo: 7, hi: 11 },
  };

  const $ = (id) => document.getElementById(id);
  const renderer = new RR.Renderer($('board'));

  let S = null; // saved game state
  const U = {   // transient view state
    selected: -1,
    panel: 'play',
    hintLevel: 0,
    hint: null,
    hintArrow: null,
    thinking: false,
    dealing: false,
    playback: null,
    token: 0,   // bumps when a new round is dealt
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

  const save = () => store(STORE, S);

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

  function solveAsync(robots, targetIndex, opts) {
    const t = S.targets[targetIndex];
    const q = {
      id: ++requestId,
      walls: S.walls,
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

  /* ---------- game flow ---------- */

  function newGame(difficulty) {
    const seed = (Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0;
    const board = RR.generateBoard(seed);
    const rng = RR.mulberry32(seed ^ 0x5bd1e995);
    S = {
      v: 1,
      seed,
      difficulty,
      walls: board.walls,
      targets: board.targets,
      robots: RR.randomRobots(rng, board),
      queue: RR.shuffle(rng, board.targets.map((_, i) => i)),
      results: [],
      target: -1,
      start: null,
      moves: [],
      solved: false,
      best: null,
      bestEnd: null,
      revealed: false,
      hintMove: false,
      bestShown: false,
      opt: null,
      done: false,
    };
    renderer.setBoard(S);
    deal();
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

  // Chooses the next target: the first one in the queue whose best solution
  // fits the difficulty, otherwise whichever comes closest.
  async function deal() {
    const token = ++U.token;
    resetRoundView();
    U.dealing = true;
    U.selected = -1;
    S.target = -1;
    save();
    render();

    const { lo, hi } = DIFFICULTY[S.difficulty] || DIFFICULTY.medium;
    let pick = null;
    let shallow = null;
    const beyond = [];
    for (const ti of S.queue) {
      const res = await solveAsync(S.robots, ti, { maxDepth: hi, maxSolutions: 200, timeMs: 2500 });
      if (token !== U.token) return;
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
        const res = await solveAsync(S.robots, ti, { maxDepth: 18, maxSolutions: 200, timeMs: 6000 });
        if (token !== U.token) return;
        if (res.depth > 0 && (!deep || res.depth < deep.res.depth)) deep = { ti, res };
        if (deep && deep.res.depth <= hi + 2) break;
      }
      if (deep && shallow) pick = deep.res.depth - hi <= lo - shallow.res.depth ? deep : shallow;
      else pick = deep || shallow;
      if (!pick && beyond.length) pick = { ti: beyond[0], res: null };
    }
    if (!pick) {
      // Only targets that already have their robot parked on them are left.
      S.queue = [];
      finishGame();
      return;
    }

    S.queue.splice(S.queue.indexOf(pick.ti), 1);
    S.target = pick.ti;
    S.start = S.robots.slice();
    S.moves = [];
    S.solved = false;
    S.best = null;
    S.bestEnd = null;
    S.revealed = false;
    S.hintMove = false;
    S.bestShown = false;
    S.opt = pick.res
      ? { depth: pick.res.depth, solutions: RR.distinctSolutions(pick.res.solutions, 5) }
      : null;
    U.dealing = false;
    const color = S.targets[S.target].color;
    U.selected = color === RR.WILD ? -1 : color;
    save();
    render();
  }

  function playable() {
    return S && !S.done && !U.dealing && !U.playback && S.target >= 0;
  }

  function clearHint() {
    U.hint = null;
    U.hintArrow = null;
    if (U.hintLevel > 2) U.hintLevel = 2;
  }

  function move(r, d) {
    if (!playable() || S.solved) return;
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
    if (!S || S.done || U.dealing || S.target < 0) return;
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
        const res = await solveAsync(S.robots, S.target, { maxDepth: 16, timeMs: 5000 });
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
    if (!S || S.done || U.dealing || S.target < 0) return;
    if (!S.opt) return;
    if (S.best === null && !S.revealed && !confirmed) {
      U.panel = 'confirm-reveal';
      render();
      return;
    }
    if (S.best === null) S.revealed = true;
    S.bestShown = true;
    clearHint();
    U.panel = 'solutions';
    save();
    startPlayback(0);
  }

  function starsFor() {
    if (S.best === null || S.revealed) return 0;
    const opt = S.opt ? S.opt.depth : S.best;
    let stars = S.best <= opt ? 3 : S.best <= opt + 2 ? 2 : 1;
    if (S.hintMove) stars = Math.min(stars, 2);
    return stars;
  }

  function next(confirmed) {
    if (!S || S.done || U.dealing || S.target < 0) return;
    if (S.best === null && !S.revealed && !confirmed) {
      U.panel = 'confirm-skip';
      render();
      return;
    }
    stopPlayback();
    const stars = starsFor();
    S.results.push({
      target: S.target,
      moves: S.revealed ? null : S.best,
      optimal: S.opt ? S.opt.depth : null,
      stars,
    });
    const stats = load(STATS, { games: 0, rounds: 0, stars: 0, perfect: 0 });
    stats.rounds++;
    stats.stars += stars;
    if (stars === 3) stats.perfect++;
    store(STATS, stats);

    // The next round starts from the player's best finish, or from the best
    // solution if they did not find one.
    if (S.bestEnd) S.robots = S.bestEnd.slice();
    else if (S.opt) S.robots = RR.replay(S.walls, S.start, S.opt.solutions[0]).pop();
    else S.robots = S.start.slice();

    if (S.queue.length) deal();
    else finishGame();
  }

  function finishGame() {
    resetRoundView();
    U.dealing = false;
    U.selected = -1;
    S.done = true;
    S.target = -1;
    S.moves = [];
    const stats = load(STATS, { games: 0, rounds: 0, stars: 0, perfect: 0 });
    stats.games++;
    store(STATS, stats);
    save();
    render();
    openSummary();
  }

  /* ---------- solution playback ---------- */

  function startPlayback(index) {
    stopPlayback();
    const moves = S.opt.solutions[index];
    U.playback = {
      index,
      moves,
      states: RR.replay(S.walls, S.start, moves),
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
    U.panel = S.solved ? 'solved' : 'play';
    render();
  }

  /* ---------- rendering ---------- */

  const ARROW = (d) => `<svg class="d${d}" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
  const chip = (m, cls) => `<span class="chip r${m.r} ${cls || ''}">${ARROW(m.d)}</span>`;

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
    const more = U.hintLevel < 3 ? '<p class="tip" style="text-align:left;padding:0">Tap Hint again for more.</p>' : '';
    return `<div class="card"><div class="label">Hint ${U.hintLevel} of 3</div>${lines.map((l) => `<p>${l}</p>`).join('')}${more}</div>`;
  }

  function panelHtml() {
    if (S.done) {
      return '<p class="tip">Board complete.</p><div class="row"><button class="btn primary" data-act="summary">See results</button><button class="btn" data-act="new">New board</button></div>';
    }
    if (U.dealing) return '<p class="tip">Setting up the next target…</p>';

    if (U.panel === 'confirm-reveal') {
      return '<div class="card"><p><b>Show the best solution?</b></p><p>This round will score no stars.</p></div>' +
        '<div class="row"><button class="btn" data-act="cancel">Keep trying</button><button class="btn primary" data-act="reveal">Show it</button></div>';
    }
    if (U.panel === 'confirm-skip') {
      return '<div class="card"><p><b>Skip this target?</b></p><p>The robots will move as in the best solution and the round scores no stars.</p></div>' +
        '<div class="row"><button class="btn" data-act="cancel">Keep trying</button><button class="btn primary" data-act="skip">Skip</button></div>';
    }
    if (U.panel === 'solutions' && U.playback) {
      const pb = U.playback;
      const count = S.opt.solutions.length;
      const rows = S.opt.solutions.map((moves, i) => {
        const active = i === pb.index;
        const chips = moves.map((m, k) => {
          const cls = active ? (k < pb.step ? 'done' : '') + (k === pb.step - 1 ? ' now' : '') : '';
          return `<span data-step="${k + 1}">${chip(m, cls)}</span>`;
        }).join('');
        return `<li class="sol ${active ? 'active' : ''}" data-sol="${i}"><span class="sol-n">${i + 1}</span><span class="chips">${chips}</span></li>`;
      }).join('');
      const playing = !!pb.timer;
      return `<div class="sol-head"><b>${count === 1 ? 'Best solution' : `${count} best solutions`} · ${plural(S.opt.depth, 'move')}</b>` +
        '<button class="link" data-act="close-solutions">Back to game</button></div>' +
        `<ol class="sols">${rows}</ol>` +
        '<div class="transport">' +
        '<button data-act="pb-start" aria-label="Back to start"><svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14l-10-7z"/></svg></button>' +
        '<button data-act="pb-prev" aria-label="Step back"><svg viewBox="0 0 24 24"><path d="M17 5v14L7 12z"/></svg></button>' +
        `<button data-act="pb-play" aria-label="${playing ? 'Pause' : 'Play'}"><svg viewBox="0 0 24 24">${playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>'}</svg></button>` +
        '<button data-act="pb-next" aria-label="Step forward"><svg viewBox="0 0 24 24"><path d="M7 5v14l10-7z"/></svg></button>' +
        '</div>';
    }
    if (U.panel === 'solved' && S.solved) {
      const stars = starsFor();
      const n = S.moves.length;
      let note;
      if (!S.opt) note = 'Nicely done.';
      else if (n <= S.opt.depth) note = 'That is the best possible.';
      else note = `The best possible is ${plural(S.opt.depth, 'move')}.`;
      if (S.revealed) note += ' No stars after seeing the solution.';
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
    return `<div class="chips" style="justify-content:center">${trail}</div>`;
  }

  function drawGoalIcon() {
    const c = $('goalIcon');
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (!S || S.target < 0) return;
    const t = S.targets[S.target];
    RR.drawTarget(ctx, c.width / 2, c.height / 2, c.width * 0.36, t.color, t.shape, renderer.theme.robots);
  }

  function render() {
    if (!S) return;
    const total = S.results.length + S.queue.length + (S.target >= 0 ? 1 : 0);
    const stars = S.results.reduce((a, r) => a + r.stars, 0);
    $('round').innerHTML = S.done
      ? `Finished · <b>★ ${stars}</b>`
      : `Round <b>${Math.min(S.results.length + 1, total)}</b> of ${total} · <b>★ ${stars}</b>`;

    const hasTarget = S.target >= 0;
    $('goalText').innerHTML = hasTarget ? targetWords(S.targets[S.target]) : (S.done ? 'Board complete' : '…');
    $('moveCount').textContent = S.moves.length;
    $('bestCount').textContent = hasTarget && S.opt && S.bestShown ? S.opt.depth : '?';
    drawGoalIcon();

    const pb = U.playback;
    let scene;
    if (pb) {
      scene = {
        robots: pb.states[pb.step],
        target: S.target,
        trails: pb.moves.slice(0, pb.step).map((m, i) => ({ r: m.r, from: pb.states[i][m.r], to: pb.states[i + 1][m.r] })),
        selected: -1,
        ghosts: [],
        hint: null,
      };
    } else {
      const ghosts = [];
      const canMove = playable() && !S.solved;
      if (canMove && U.selected >= 0) {
        for (let d = 0; d < 4; d++) {
          const to = RR.slide(S.walls, S.robots, U.selected, d);
          if (to !== S.robots[U.selected]) ghosts.push(to);
        }
      }
      scene = {
        robots: S.robots,
        target: S.target,
        trails: S.moves,
        selected: canMove ? U.selected : -1,
        ghosts,
        hint: U.hintArrow,
      };
    }
    renderer.setScene(scene);

    $('panel').innerHTML = panelHtml();

    const idle = !S.done && !U.dealing && hasTarget;
    $('undoBtn').disabled = !idle || !!pb || !S.moves.length;
    $('resetBtn').disabled = !idle || (!S.moves.length && !pb);
    $('hintBtn').disabled = !idle || !!pb || S.solved;
    $('solutionBtn').disabled = !idle || !S.opt;
    $('nextBtn').disabled = !idle;
    const finished = S.best !== null || S.revealed;
    $('nextBtn').classList.toggle('primary', idle && finished);
    $('nextLabel').textContent = finished ? 'Next' : 'Skip';
  }

  /* ---------- dialogs ---------- */

  function openDialog(html) {
    $('dialog').innerHTML = html;
    $('scrim').hidden = false;
  }

  function closeDialog() {
    $('scrim').hidden = true;
  }

  function openMenu(confirmNew) {
    const stats = load(STATS, { games: 0, rounds: 0, stars: 0, perfect: 0 });
    const inProgress = S && !S.done && S.results.length > 0;
    const seg = Object.keys(DIFFICULTY).map((k) =>
      `<button role="radio" aria-checked="${S.difficulty === k}" data-diff="${k}">${DIFFICULTY[k].label}</button>`).join('');
    const d = DIFFICULTY[S.difficulty];
    openDialog(
      '<h2>Ricochet</h2>' +
      `<div class="field"><div class="label">Difficulty</div><div class="seg" role="radiogroup">${seg}</div>` +
      `<p class="muted">Targets whose best solution takes ${d.lo} to ${d.hi} moves. Applies from the next target.</p></div>` +
      '<div class="stack">' +
      (confirmNew && inProgress
        ? '<button class="btn primary" data-act="new-confirmed">Discard this game and start</button>'
        : '<button class="btn primary" data-act="new">New board</button>') +
      '<button class="btn" data-act="help">How to play</button></div>' +
      '<div class="field"><div class="label">Your record</div><div class="stats">' +
      `<div><b>${stats.rounds}</b><span class="muted">rounds</span></div>` +
      `<div><b>${stats.stars}</b><span class="muted">stars</span></div>` +
      `<div><b>${stats.perfect}</b><span class="muted">perfect</span></div></div></div>` +
      '<button class="btn quiet" data-act="close">Close</button>');
  }

  function openHelp() {
    openDialog(
      '<h2>How to play</h2>' +
      '<ol>' +
      '<li>Each round names a robot and a target. Get that robot to stop exactly on the target. The vortex accepts any robot.</li>' +
      '<li>Robots slide in a straight line and only stop when they hit a wall or another robot. Use the other robots as blockers.</li>' +
      '<li>Tap a robot to select it, then swipe in a direction. You can also tap one of the ring markers, or anywhere in the robot’s row or column.</li>' +
      '<li>Fewer moves is better. Three stars for matching the best possible solution, two for coming within two moves, one for solving it at all.</li>' +
      '</ol>' +
      '<p class="muted">Hint reveals a little more each time you tap it: the best move count, the robots involved, then the next move. Solution shows every best solution and plays it on the board.</p>' +
      '<button class="btn primary" data-act="close">Got it</button>');
  }

  function openSummary() {
    const rounds = S.results.length;
    const stars = S.results.reduce((a, r) => a + r.stars, 0);
    const solved = S.results.filter((r) => r.moves !== null);
    const perfect = S.results.filter((r) => r.stars === 3).length;
    const moves = solved.reduce((a, r) => a + r.moves, 0);
    const optimal = solved.reduce((a, r) => a + (r.optimal === null ? r.moves : r.optimal), 0);
    openDialog(
      '<h2>Board complete</h2>' +
      `<div class="big-stars">★ ${stars} <small>of ${rounds * 3}</small></div>` +
      '<div class="stats">' +
      `<div><b>${solved.length}/${rounds}</b><span class="muted">solved</span></div>` +
      `<div><b>${perfect}</b><span class="muted">perfect</span></div>` +
      `<div><b>${moves}</b><span class="muted">moves (best ${optimal})</span></div></div>` +
      '<div class="stack"><button class="btn primary" data-act="new-confirmed">New board</button>' +
      '<button class="btn quiet" data-act="close">Close</button></div>');
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
    help: openHelp,
    new() {
      if (S && !S.done && S.results.length > 0) openMenu(true);
      else actions['new-confirmed']();
    },
    'new-confirmed'() { closeDialog(); newGame(S.difficulty); },
  };

  function onAction(e) {
    const el = e.target.closest('[data-act], [data-diff], [data-step], [data-sol]');
    if (!el) return;
    if (el.dataset.act) {
      const fn = actions[el.dataset.act];
      if (fn) fn();
    } else if (el.dataset.diff) {
      S.difficulty = el.dataset.diff;
      save();
      openMenu(false);
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
  $('scrim').addEventListener('click', (e) => { if (e.target === $('scrim')) closeDialog(); });
  $('menuBtn').addEventListener('click', () => openMenu(false));
  $('undoBtn').addEventListener('click', undo);
  $('resetBtn').addEventListener('click', resetRound);
  $('hintBtn').addEventListener('click', hint);
  $('solutionBtn').addEventListener('click', () => {
    if (U.playback) closeSolutions(); else showSolutions(false);
  });
  $('nextBtn').addEventListener('click', () => next(false));

  // Board gestures: press a robot to select it, swipe to move, or tap a cell
  // in line with the selected robot.
  let gesture = null;
  const canvas = $('board');

  function robotNear(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const cell = rect.width / RR.SIZE;
    let best = -1;
    let bestDist = cell * 0.95;
    S.robots.forEach((c, i) => {
      const dx = rect.left + ((c % RR.SIZE) + 0.5) * cell - clientX;
      const dy = rect.top + ((c >> 4) + 0.5) * cell - clientY;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!playable() || S.solved) return;
    canvas.setPointerCapture(e.pointerId);
    const cell = renderer.cellAt(e.clientX, e.clientY);
    const hit = S.robots.indexOf(cell);
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
    if (!g || g.moved || g.hit >= 0 || g.cell < 0) return;
    if (U.selected >= 0) {
      const at = S.robots[U.selected];
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
    if (!$('scrim').hidden) {
      if (e.key === 'Escape') closeDialog();
      return;
    }
    const dir = { ArrowUp: RR.N, ArrowRight: RR.E, ArrowDown: RR.S, ArrowLeft: RR.W }[e.key];
    if (dir !== undefined && U.selected >= 0) { e.preventDefault(); move(U.selected, dir); return; }
    if (e.key >= '1' && e.key <= '4' && playable()) { U.selected = +e.key - 1; render(); }
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

  fitBoard();
  const saved = load(STORE, null);
  if (saved && saved.v === 1 && Array.isArray(saved.walls) && saved.walls.length === RR.CELLS) {
    S = saved;
    renderer.setBoard(S);
    if (S.done) render();
    else if (S.target < 0) deal();
    else {
      U.panel = S.solved ? 'solved' : 'play';
      const color = S.targets[S.target].color;
      U.selected = color === RR.WILD ? -1 : color;
      render();
    }
  } else {
    newGame('medium');
    openHelp();
  }

  // Test hook; harmless in production.
  self.__ricochet = { state: () => S, view: () => U };
})();
