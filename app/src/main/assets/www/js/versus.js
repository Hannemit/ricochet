// Multiplayer: two to four phones play the same board live, tabletop style.
// Nobody moves during a round at first; players bid the number of moves they
// think they need, and the lowest bidder then has to prove it on the board.
//
// One phone is the host and owns the game. Guests send it actions (join, bid,
// move ...) and it broadcasts a full snapshot of the game after every change
// and every few seconds, so a dropped message or a reconnect heals itself.
//
// Messages travel over a public MQTT relay, which is reliable but can lag by
// a second or more. So each guest also opens a direct WebRTC data channel to
// the host (the relay carries the handshake) and uses that when it is up.
(function () {
  'use strict';

  const RR = self.RR;
  const A = () => RR.app;
  const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const BEAT_MS = 2500;      // host snapshot / guest ping interval
  const ONLINE_MS = 12000;   // a player silent for longer counts as away
  const MAX_PLAYERS = 4;
  const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  const X = {
    role: null,       // 'host' | 'guest'
    code: '',
    relay: null,
    me: '',
    session: '',
    V: null,          // latest snapshot, what the screen shows
    H: null,          // host only: the authoritative game
    outbox: [],       // guest only: actions the host has not confirmed yet
    seq: 0,
    lastSnapAt: 0,
    deadline: null,   // local clock time at which the current timer ends
    lastBeat: 0,
    draft: 5,
    optimisticAt: 0,
    token: 0,
    timers: [],
    link: null,       // guest only: direct connection to the host
    links: {},        // host only: direct connections by guest id
    lastOffer: 0,
    lastRelayBeat: 0,
  };

  const now = () => performance.now();
  const topic = (kind) => `ricochet-hm/1/${X.code}/${kind}`;
  const connected = () => !!X.role;
  const active = () => !!(X.role && X.V && X.V.phase !== 'lobby' && X.V.walls);
  const player = (id) => X.V && X.V.players.find((p) => p.id === id);
  const label = (id) => (id === X.me ? 'You' : A().esc((player(id) || { name: 'Player' }).name));
  const bidOf = (v, id) => v.bids.find((b) => b.id === id);
  const bidOrder = (v) => v.bids.slice().sort((a, b) => a.n - b.n || a.k - b.k);

  function cleanName(name) {
    return String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 12) || 'Player';
  }

  function later(fn, ms) {
    const id = setTimeout(fn, ms);
    X.timers.push(id);
    return id;
  }

  /* ---------- direct links ---------- */

  // Resolves once the connection has collected its network candidates, so the
  // whole description can be sent as a single message.
  function gathered(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') resolve();
      });
      setTimeout(resolve, 2500);
    });
  }

  // `guestId` is null on the guest's own link to the host.
  function dropLink(link, guestId) {
    link.open = false;
    try { link.pc.close(); } catch (e) { /* already closed */ }
    if (guestId === null) { if (X.link === link) X.link = null; }
    else if (X.links[guestId] === link) delete X.links[guestId];
  }

  function wire(link, guestId) {
    link.dc.onopen = () => { link.open = true; if (guestId !== null) beat(); else refresh(); };
    link.dc.onclose = () => { dropLink(link, guestId); refresh(); };
    link.dc.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      if (guestId === null) guestMessage(e.data); else hostMessage(e.data);
    };
    link.pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].indexOf(link.pc.connectionState) >= 0) dropLink(link, guestId);
    };
  }

  async function offerLink() {
    if (X.role !== 'guest' || X.link || !self.RTCPeerConnection || !X.relay || !X.relay.ready) return;
    X.lastOffer = now();
    let link;
    try {
      link = { pc: new RTCPeerConnection(RTC_CONFIG), dc: null, open: false, at: now() };
      X.link = link;
      link.dc = link.pc.createDataChannel('game');
      wire(link, null);
      await link.pc.setLocalDescription(await link.pc.createOffer());
      await gathered(link.pc);
      if (X.link !== link) return;
      X.relay.publish(topic('a'), JSON.stringify({ t: 'rtc', id: X.me, sdp: link.pc.localDescription.sdp }));
    } catch (e) {
      if (link) dropLink(link, null);
    }
  }

  async function answerLink(id, sdp) {
    if (!self.RTCPeerConnection || typeof sdp !== 'string' || sdp.length > 20000) return;
    if (!X.H.players.some((p) => p.id === id)) return;
    if (X.links[id]) dropLink(X.links[id], id);
    let link;
    try {
      link = { pc: new RTCPeerConnection(RTC_CONFIG), dc: null, open: false, at: now() };
      X.links[id] = link;
      link.pc.ondatachannel = (e) => { link.dc = e.channel; wire(link, id); };
      await link.pc.setRemoteDescription({ type: 'offer', sdp });
      await link.pc.setLocalDescription(await link.pc.createAnswer());
      await gathered(link.pc);
      if (X.links[id] !== link || !X.relay) return;
      X.relay.publish(topic('s'), JSON.stringify({ t: 'rtc', to: id, sdp: link.pc.localDescription.sdp }));
    } catch (e) {
      if (link) dropLink(link, id);
    }
  }

  // Sends to the host over the direct link when there is one, else the relay.
  function toHost(text) {
    if (X.link && X.link.open) {
      try { X.link.dc.send(text); return; } catch (e) { /* fall back to the relay */ }
    }
    if (X.relay) X.relay.publish(topic('a'), text);
  }

  /* ---------- connecting ---------- */

  function begin(role) {
    teardown();
    X.role = role;
    X.me = A().settings.pid;
    X.session = Math.random().toString(36).slice(2, 10);
    X.seq = 0;
    X.outbox = [];
    X.V = null;
    X.H = null;
    X.lastSnapAt = now();
    X.lastBeat = 0;
    X.lastOffer = 0;
    X.lastRelayBeat = 0;
    X.link = null;
    X.links = {};
  }

  function readName() {
    const input = document.getElementById('vsName');
    const name = cleanName(input ? input.value : A().settings.name);
    A().settings.name = name;
    A().saveSettings();
    return name;
  }

  function createGame() {
    const name = readName();
    begin('host');
    X.H = {
      seq: 0, phase: 'lobby', players: [{ id: X.me, name, score: 0, done: false }],
      cfg: { rounds: 9 }, round: 0, total: 0, walls: null, targets: null, robots: [], start: [],
      target: -1, moves: [], bids: [], k: 0, prover: null, failed: [], winner: null, winMoves: 0,
      opt: null, deadline: null, span: 0, acks: {}, seen: {}, queue: [],
    };
    hostConnect(0);
  }

  function hostConnect(index) {
    // The first letter of the code encodes which relay the game is on.
    const first = [];
    for (let i = 0; i < LETTERS.length; i++) if (i % RR.RELAYS.length === index) first.push(LETTERS[i]);
    let code = first[Math.floor(Math.random() * first.length)];
    for (let i = 0; i < 4; i++) code += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    X.code = code;
    const relay = new RR.Relay(RR.RELAYS[index], {
      onopen() { beat(); },
      onmessage(t, text) { if (X.relay === relay) hostMessage(text); },
      onclose() { refresh(); },
    });
    X.relay = relay;
    relay.subscribe(topic('a'));
    commit();
    later(() => {
      if (X.relay !== relay || relay.ready || X.H.players.length > 1) return;
      relay.close();
      if (index + 1 < RR.RELAYS.length) hostConnect(index + 1);
      else ended('Could not reach the game server. Check your internet connection and try again.');
    }, RR.RELAYS.length > 1 ? 8000 : 25000);
  }

  function joinGame() {
    const input = document.getElementById('vsCode');
    const code = (input ? input.value : '').toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 5 || LETTERS.indexOf(code[0]) < 0) {
      const err = document.getElementById('vsError');
      if (err) err.textContent = 'Enter the five-letter code from your friend’s screen.';
      return;
    }
    const name = readName();
    begin('guest');
    X.code = code;
    const relay = new RR.Relay(RR.RELAYS[LETTERS.indexOf(code[0]) % RR.RELAYS.length], {
      onopen() {
        // A fresh join each time we (re)connect, so the host learns we are back.
        X.outbox = X.outbox.filter((m) => m.a !== 'join');
        send({ a: 'join', name });
      },
      onmessage(t, text) { if (X.relay === relay) guestMessage(text); },
      onclose() { refresh(); },
    });
    X.relay = relay;
    relay.subscribe(topic('s'));
    A().openDialog(`<h2>Joining ${code}…</h2><p class="muted">Looking for the game.</p>` +
      '<button class="btn quiet" data-vs="leave">Cancel</button>', 'join');
    later(() => {
      if (X.relay === relay && !X.V) {
        ended('No game found with that code. Check the code, and that your friend still has the game open.');
      }
    }, 25000);
  }

  function teardown() {
    for (const id of X.timers) clearTimeout(id);
    X.timers = [];
    X.token++;
    if (X.relay) X.relay.close();
    X.relay = null;
    if (X.link) dropLink(X.link, null);
    for (const id of Object.keys(X.links)) dropLink(X.links[id], id);
    X.role = null;
    X.V = null;
    X.H = null;
    X.outbox = [];
    X.deadline = null;
  }

  function leave() {
    if (X.role === 'host' && X.relay) X.relay.publish(topic('s'), JSON.stringify({ t: 'end' }));
    teardown();
    A().reset();
    A().closeDialog();
    A().render();
    A().showHome();
  }

  function ended(message) {
    teardown();
    A().reset();
    A().render();
    A().showHome();
    A().openDialog(`<h2>Game over</h2><p>${A().esc(message)}</p>` +
      '<button class="btn primary" data-act="home">Home</button>', 'ended');
  }

  /* ---------- host: authoritative game ---------- */

  function snapshot() {
    const h = X.H;
    const t = now();
    const reveal = h.phase === 'result' || h.phase === 'final';
    return {
      t: 's', seq: h.seq, phase: h.phase, host: X.me,
      players: h.players.map((p) => ({
        id: p.id, name: p.name, score: p.score, done: !!p.done,
        on: p.id === X.me || t - (h.seen[p.id] || 0) < ONLINE_MS,
      })),
      cfg: h.cfg, round: h.round, total: h.total,
      walls: h.walls, targets: h.targets, robots: h.robots, start: h.start, target: h.target,
      moves: h.moves, bids: h.bids, prover: h.prover, failed: h.failed,
      winner: h.winner, winMoves: h.winMoves,
      opt: reveal ? h.opt : null,
      left: h.deadline === null ? null : Math.max(0, h.deadline - t),
      span: h.span, acks: h.acks,
    };
  }

  // Broadcasts the current game and shows it locally.
  function beat() {
    if (X.role !== 'host') return;
    const t = now();
    X.lastBeat = t;
    const text = JSON.stringify(snapshot());
    let allDirect = true;
    for (const p of X.H.players) {
      if (p.id === X.me) continue;
      const link = X.links[p.id];
      let sent = false;
      if (link && link.open) {
        try { link.dc.send(text); sent = true; } catch (e) { /* use the relay */ }
      }
      if (!sent) allDirect = false;
    }
    // The relay still gets a regular heartbeat, for anyone joining or reconnecting.
    if (X.relay && (!allDirect || t - X.lastRelayBeat >= BEAT_MS)) {
      X.lastRelayBeat = t;
      X.relay.publish(topic('s'), text);
    }
    onSnapshot(JSON.parse(text));
  }

  function commit() {
    X.H.seq++;
    beat();
  }

  function hostMessage(text) {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    const h = X.H;
    if (!h || !m || typeof m.id !== 'string' || m.id.length > 16 || m.id === X.me) return;
    if (m.t === 'rtc') { answerLink(m.id, m.sdp); return; }
    if (m.t !== 'a') return;
    h.seen[m.id] = now();
    if (m.a === 'ping') return;
    // Each action is numbered per guest session so repeats are applied once.
    let ack = h.acks[m.id];
    if (!ack || ack.s !== m.s) ack = h.acks[m.id] = { s: String(m.s).slice(0, 16), n: 0 };
    if (m.n !== ack.n + 1) return;
    ack.n = m.n;
    try { apply(m.id, m); } catch (e) { /* ignore malformed actions */ }
    commit();
  }

  function apply(id, m) {
    const h = X.H;
    let p = h.players.find((q) => q.id === id);
    if (m.a === 'join') {
      if (p) p.name = cleanName(m.name);
      else if (h.players.length < MAX_PLAYERS) h.players.push({ id, name: cleanName(m.name), score: 0, done: false });
      return;
    }
    if (!p) return;

    if (m.a === 'bid' && h.phase === 'think') {
      const n = m.v;
      if (!Number.isInteger(n) || n < 1 || n > 40) return;
      const b = h.bids.find((q) => q.id === id);
      if (b && n >= b.n) return;
      if (b) { b.n = n; b.k = ++h.k; } else h.bids.push({ id, n, k: ++h.k });
      // The first bid starts the clock; any new bid reopens the round for the others.
      if (h.deadline === null) {
        h.span = h.cfg.timer * 1000;
        h.deadline = now() + h.span;
      }
      for (const q of h.players) if (q.id !== id) q.done = false;
    } else if (m.a === 'unbid' && h.phase === 'think') {
      // Taking back a bid; if it was the only one, the clock stops again.
      h.bids = h.bids.filter((q) => q.id !== id);
      p.done = false;
      if (!h.bids.length) { h.deadline = null; h.span = 0; }
    } else if (m.a === 'done' && h.phase === 'think') {
      p.done = true;
      closeBiddingIfAllDone();
    } else if (m.a === 'move' && h.phase === 'prove' && id === h.prover) {
      if (m.i !== h.moves.length || !(m.r >= 0 && m.r < h.robots.length) || !(m.d >= 0 && m.d < 4)) return;
      const from = h.robots[m.r];
      const to = RR.slide(h.walls, h.robots, m.r, m.d);
      if (to === from) return;
      h.robots[m.r] = to;
      h.moves.push({ r: m.r, d: m.d, from, to });
      const bid = h.bids.find((q) => q.id === id);
      if (RR.isSolved(h.robots, h.targets[h.target])) {
        h.winner = id;
        h.winMoves = h.moves.length;
        p.score++;
        h.phase = 'result';
        h.deadline = null;
      } else if (h.moves.length >= bid.n) {
        failProver();
      }
    } else if (m.a === 'next' && h.phase === 'result') {
      if (h.round >= h.total || !h.queue.length) { h.phase = 'final'; h.deadline = null; }
      else dealRound();
    }
  }

  function closeBiddingIfAllDone() {
    const h = X.H;
    if (h.phase !== 'think') return false;
    const t = now();
    const present = h.players.filter((p) => p.id === X.me || t - (h.seen[p.id] || 0) < ONLINE_MS);
    if (!present.every((p) => p.done)) return false;
    endBidding();
    return true;
  }

  function endBidding() {
    const h = X.H;
    const order = bidOrder(h);
    if (order.length) startProof(order[0].id);
    else noWinner();
  }

  function startProof(id) {
    const h = X.H;
    h.phase = 'prove';
    h.prover = id;
    h.robots = h.start.slice();
    h.moves = [];
    h.span = Math.max(30, h.cfg.timer) * 1000;
    h.deadline = now() + h.span;
  }

  function failProver() {
    const h = X.H;
    h.failed.push(h.prover);
    const nextUp = bidOrder(h).find((b) => h.failed.indexOf(b.id) < 0);
    if (nextUp) startProof(nextUp.id);
    else noWinner();
  }

  function noWinner() {
    const h = X.H;
    h.winner = null;
    h.winMoves = 0;
    h.prover = null;
    h.robots = h.start.slice();
    h.moves = [];
    h.phase = 'result';
    h.deadline = null;
  }

  function startGame() {
    const h = X.H;
    const s = A().settings;
    const seed = (Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0;
    const board = RR.generateBoard(seed);
    const rng = RR.mulberry32(seed ^ 0x1b873593);
    h.cfg = { rounds: h.cfg.rounds, timer: s.timer > 0 ? s.timer : 60, difficulty: s.difficulty, silver: s.silver };
    h.walls = board.walls;
    h.targets = board.targets;
    h.robots = RR.randomRobots(rng, board, s.silver ? 5 : 4);
    h.queue = RR.shuffle(rng, board.targets.map((_, i) => i));
    h.round = 0;
    h.total = Math.min(h.cfg.rounds, board.targets.length);
    for (const p of h.players) p.score = 0;
    dealRound();
  }

  async function dealRound() {
    const h = X.H;
    const token = ++X.token;
    h.phase = 'deal';
    h.target = -1;
    h.start = h.robots.slice();
    h.moves = [];
    h.bids = [];
    h.failed = [];
    h.winner = null;
    h.prover = null;
    h.opt = null;
    h.deadline = null;
    for (const p of h.players) p.done = false;
    commit();
    const pick = await A().pickTarget(h, h.robots, h.queue, h.cfg.difficulty, () => token !== X.token);
    if (pick === undefined || X.H !== h) return;
    if (pick === null) {
      h.phase = 'final';
    } else {
      h.queue.splice(h.queue.indexOf(pick.ti), 1);
      h.target = pick.ti;
      h.opt = pick.opt;
      h.round++;
      h.phase = 'think';
    }
    commit();
  }

  /* ---------- guest ---------- */

  function send(m) {
    m.t = 'a';
    m.id = X.me;
    m.s = X.session;
    m.n = ++X.seq;
    X.outbox.push(m);
    toHost(JSON.stringify(m));
  }

  // Performs an action as this player, whichever role this phone has.
  function act(m) {
    if (X.role === 'host') {
      apply(X.me, m);
      commit();
    } else if (X.role === 'guest') {
      send(m);
    }
  }

  function guestMessage(text) {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m) return;
    if (m.t === 'end') { ended('The host ended the game.'); return; }
    if (m.t === 'rtc') {
      if (m.to === X.me && X.link && !X.link.answered && typeof m.sdp === 'string' && m.sdp.length < 20000) {
        X.link.answered = true;
        X.link.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => { if (X.link) dropLink(X.link, null); });
      }
      return;
    }
    if (m.t !== 's' || typeof m.seq !== 'number' || !Array.isArray(m.players) || !Array.isArray(m.bids) ||
        !Array.isArray(m.moves) || !Array.isArray(m.robots)) return;
    if (m.phase !== 'lobby' && (!Array.isArray(m.walls) || m.walls.length !== RR.CELLS || !Array.isArray(m.targets))) return;
    for (const p of m.players) p.name = cleanName(p.name);
    try { onSnapshot(m); } catch (e) { /* a broken snapshot is dropped; the next one replaces it */ }
  }

  /* ---------- shared: showing a snapshot ---------- */

  function onSnapshot(s) {
    const prev = X.V;
    if (prev && prev.host === s.host && s.seq < prev.seq) return;
    const t = now();
    X.lastSnapAt = t;
    X.deadline = s.left === null || s.left === undefined ? null : t + s.left;

    if (X.role === 'guest') {
      const ack = s.acks && s.acks[X.me];
      if (ack && ack.s === X.session) X.outbox = X.outbox.filter((m) => m.n > ack.n);
      // Keep moves this phone has already shown while the host catches up.
      if (prev && s.phase === 'prove' && prev.phase === 'prove' && s.prover === X.me && prev.prover === X.me &&
          s.round === prev.round && s.failed.length === prev.failed.length &&
          s.moves.length < prev.moves.length && t - X.optimisticAt < 4000) {
        s.moves = prev.moves;
        s.robots = prev.robots;
      }
    }
    X.V = s;

    const app = A();
    const stepped = !prev || prev.phase !== s.phase || prev.round !== s.round || prev.prover !== s.prover;
    let animate = null;
    if (stepped) {
      app.reset();
      if (s.phase === 'think') {
        X.draft = 5;
      } else if (s.phase === 'prove') {
        if (prev && prev.phase === 'prove') RR.sound.fail();
        if (s.prover === X.me) {
          const color = s.targets[s.target].color;
          app.select(color === RR.WILD ? -1 : color);
          RR.sound.bid();
        }
      } else if (s.phase === 'result' && prev) {
        if (s.winner === X.me) RR.sound.solved(!!s.opt && s.winMoves <= s.opt.depth);
        else if (s.winner) RR.sound.timeUp();
        else if (s.bids.length) RR.sound.fail();
      }
    } else if (s.phase === 'prove' && s.moves.length === prev.moves.length + 1) {
      animate = s.moves[s.moves.length - 1];
    } else if (s.phase === 'think' && (s.bids.length !== prev.bids.length ||
        s.bids.some((b) => { const o = bidOf(prev, b.id); return !o || o.n !== b.n; }))) {
      RR.sound.bid();
    }
    // The winning move ends the proof, so it arrives together with the result.
    if (stepped && prev && prev.phase === 'prove' && s.phase === 'result' && s.winner &&
        s.moves.length === prev.moves.length + 1) {
      animate = s.moves[s.moves.length - 1];
    }

    const kind = app.dialogKind();
    if (active()) app.hideHome();
    if (s.phase === 'lobby') openLobby();
    else if (s.phase === 'final') { if (stepped || kind === 'final') openFinal(); }
    else if (kind === 'lobby' || kind === 'final' || kind === 'join') app.closeDialog();
    else if (kind === 'vsmenu') openMenu();

    app.render();
    if (animate) app.animate(animate.r, animate.from, animate.to);
  }

  function refresh() {
    if (!X.V) return;
    if (X.V.phase === 'lobby') openLobby();
    A().render();
  }

  function tick() {
    if (!connected()) return;
    const t = now();
    if (X.role === 'host') {
      const h = X.H;
      let changed = false;
      if (h.deadline !== null && t >= h.deadline) {
        if (h.phase === 'think') { endBidding(); changed = true; }
        else if (h.phase === 'prove') { failProver(); changed = true; }
      }
      if (!changed && h.phase === 'think' && h.players.some((p) => p.done)) changed = closeBiddingIfAllDone();
      if (changed) commit();
      else if (t - X.lastBeat > BEAT_MS) beat();
    } else if (t - X.lastBeat > BEAT_MS) {
      X.lastBeat = t;
      toHost(JSON.stringify({ t: 'a', id: X.me, s: X.session, a: 'ping' }));
      for (const m of X.outbox) toHost(JSON.stringify(m));
      // Try for a direct link once the game is found; retry if it does not come up.
      if (X.link && !X.link.open && t - X.link.at > 15000) dropLink(X.link, null);
      if (X.V && !X.link && t - X.lastOffer > 10000) offerLink();
      if (active() && t - X.lastSnapAt > 9000) A().render();
    }
  }

  /* ---------- what the main screen asks for ---------- */

  function timer() {
    if (!X.V || X.deadline === null) return null;
    return { left: X.deadline - now(), total: X.V.span || 1 };
  }

  function canMove() {
    const v = X.V;
    if (!v || v.phase !== 'prove' || v.prover !== X.me) return false;
    const bid = bidOf(v, X.me);
    return !!bid && v.moves.length < bid.n;
  }

  function move(r, d) {
    const v = X.V;
    if (!canMove()) return;
    A().select(r);
    const from = v.robots[r];
    const to = RR.slide(v.walls, v.robots, r, d);
    if (to === from) { A().render(); return; }
    if (X.role === 'guest') {
      // Show the move straight away; the host confirms it a moment later.
      v.robots[r] = to;
      v.moves.push({ r, d, from, to });
      X.optimisticAt = now();
      send({ a: 'move', r, d, i: v.moves.length - 1 });
      A().render();
      A().animate(r, from, to);
    } else {
      act({ a: 'move', r, d, i: v.moves.length });
    }
  }

  const canNext = () => !!X.V && X.V.phase === 'result';
  const canSeeSolutions = () => !!X.V && X.V.phase === 'result' && !!X.V.opt;
  const next = () => { if (canNext()) act({ a: 'next' }); };

  function roundLabel() {
    const v = X.V;
    const shown = Math.max(1, Math.min(v.total, v.round + (v.phase === 'deal' ? 1 : 0)));
    const scores = v.players.map((p) => `${label(p.id)} <b>${p.score}</b>`).join(' · ');
    return `${shown}/${v.total} · ${scores}`;
  }

  function bidText() {
    const v = X.V;
    if (v.phase === 'prove') return bidOf(v, v.prover).n;
    const order = bidOrder(v);
    return order.length ? order[0].n : '–';
  }

  function lostBanner() {
    const offline = X.role === 'guest' ? now() - X.lastSnapAt > 9000 : !(X.relay && X.relay.ready);
    return offline ? '<p class="tip warn">Connection lost. Reconnecting…</p>' : '';
  }

  function panelHtml() {
    const v = X.V;
    const app = A();
    const banner = lostBanner();
    if (v.phase === 'deal') return banner + '<p class="tip">Setting up the next target…</p>';

    if (v.phase === 'think') {
      const mine = bidOf(v, X.me);
      const me = player(X.me) || {};
      const max = mine ? mine.n - 1 : 30;
      X.draft = Math.max(1, Math.min(max, X.draft));
      const bids = v.players.map((p) => {
        const b = bidOf(v, p.id);
        return `<span class="pbid ${p.on ? '' : 'off'}"><b>${label(p.id)}</b> ${b ? b.n : '–'}${p.done ? ' ✓' : ''}</span>`;
      }).join('');
      const lead = mine
        ? `You bid <b>${mine.n}</b>. You can lower it until the time runs out, or take it back.`
        : 'Find a route in your head, then bid how many moves it takes. No moving yet.';
      let controls;
      if (me.done) {
        controls = '<p class="tip">Waiting for the others…</p>';
      } else {
        const canBid = max >= 1;
        controls = '<div class="row bidrow">' +
          '<div class="stepper"><button data-vs="minus" aria-label="Fewer">−</button>' +
          `<b>${X.draft}</b><button data-vs="plus" aria-label="More">+</button></div>` +
          `<button class="btn primary" data-vs="bid" ${canBid ? '' : 'disabled'}>${mine ? 'Lower to' : 'Bid'} ${X.draft}</button>` +
          `<button class="btn" data-vs="done">${mine ? 'Done' : 'Pass'}</button></div>` +
          (mine ? '<button class="link centered" data-vs="unbid">Undo my bid</button>' : '');
      }
      return banner + `<div class="card"><p>${lead}</p><div class="bids">${bids}</div></div>${controls}`;
    }

    if (v.phase === 'prove') {
      const bid = bidOf(v, v.prover).n;
      const trail = v.moves.map((m) => app.chip(m)).join('');
      const lead = v.prover === X.me
        ? `Your turn. Reach the target in <b>${app.plural(bid, 'move')}</b> or fewer. There is no undo.`
        : `<b>${label(v.prover)}</b> bid ${bid} and is showing the solution.`;
      return banner + `<div class="card"><p>${lead}</p>` +
        `<div class="chips">${trail}<span class="muted">${v.moves.length} of ${bid}</span></div></div>`;
    }

    if (v.phase === 'result') {
      let lead;
      if (v.winner === X.me) lead = `<b>You win the target</b> in ${app.plural(v.winMoves, 'move')}.`;
      else if (v.winner) lead = `<b>${label(v.winner)} wins the target</b> in ${app.plural(v.winMoves, 'move')}.`;
      else lead = v.bids.length ? '<b>Nobody proved their bid.</b> No point this round.' : '<b>Everyone passed.</b> No point this round.';
      const best = v.opt ? `<p>The best possible is ${app.plural(v.opt.depth, 'move')}.</p>` : '';
      const last = v.round >= v.total;
      return banner + `<div class="card"><p>${lead}</p>${best}</div><div class="row">` +
        (v.opt ? '<button class="btn" data-act="solutions">Best solutions</button>' : '') +
        `<button class="btn primary" data-vs="next">${last ? 'Final scores' : 'Next target'}</button></div>`;
    }

    return banner + '<p class="tip">Game finished.</p><div class="row"><button class="btn primary" data-vs="final">Scores</button></div>';
  }

  /* ---------- dialogs ---------- */

  function openEntry() {
    const app = A();
    app.openDialog(
      '<h2>Play with a friend</h2>' +
      `<label class="field"><span class="label">Your name</span><input id="vsName" type="text" maxlength="12" autocomplete="off" value="${app.esc(app.settings.name)}" placeholder="Player"></label>` +
      '<button class="btn primary" data-vs="create">Create a game</button>' +
      '<div class="or">or join one</div>' +
      '<label class="field"><span class="label">Game code</span><input id="vsCode" type="text" class="code-input" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE"></label>' +
      '<p class="error" id="vsError"></p>' +
      '<button class="btn" data-vs="join">Join game</button>' +
      '<p class="muted">Needs an internet connection. Your name and moves pass through a public relay server, so pick a name you don’t mind being visible.</p>' +
      '<button class="btn quiet" data-act="home">Back</button>', 'entry');
  }

  function playerRows(v, withScore) {
    return '<div class="plist">' + v.players.map((p) =>
      `<div class="${p.on ? '' : 'off'}"><span>${label(p.id)}${p.id === v.host ? ' <i>host</i>' : ''}${p.on ? '' : ' <i>away</i>'}</span>` +
      (withScore ? `<b>${p.score}</b>` : '') + '</div>').join('') + '</div>';
  }

  function openLobby() {
    const v = X.V;
    const app = A();
    const host = X.role === 'host';
    const online = X.relay && X.relay.ready;
    let body;
    if (host) {
      const s = app.settings;
      const rounds = [5, 9, 16].map((n) =>
        `<button role="radio" aria-checked="${v.cfg.rounds === n}" data-vs="rounds" data-value="${n}">${n}</button>`).join('');
      const timer = s.timer > 0 ? s.timer : 60;
      body = `<div class="field"><div class="label">Targets to play</div><div class="seg" role="radiogroup">${rounds}</div></div>` +
        `<p class="muted">Uses your settings: ${app.DIFFICULTY[s.difficulty].label.toLowerCase()} difficulty, ${timer} seconds to bid, silver robot ${s.silver ? 'on' : 'off'}.</p>` +
        `<button class="btn primary" data-vs="start" ${v.players.length > 1 ? '' : 'disabled'}>${v.players.length > 1 ? 'Start game' : 'Waiting for a friend…'}</button>`;
    } else {
      body = '<p>Waiting for the host to start the game…</p>';
    }
    app.openDialog(
      '<h2>Game code</h2>' +
      `<div class="code">${X.code}</div>` +
      (online ? '<p class="muted">Your friend taps Play with a friend and enters this code.</p>'
        : '<p class="muted">Connecting…</p>') +
      playerRows(v, false) + body +
      '<button class="btn quiet" data-vs="leave">Leave</button>', 'lobby');
  }

  function openFinal() {
    const v = X.V;
    const ranked = v.players.slice().sort((a, b) => b.score - a.score);
    const top = ranked[0].score;
    const winners = ranked.filter((p) => p.score === top);
    let title;
    if (winners.length > 1) title = 'It’s a tie';
    else title = winners[0].id === X.me ? 'You win!' : `${label(winners[0].id)} wins`;
    A().openDialog(
      `<h2>${title}</h2>` + playerRows({ players: ranked, host: v.host }, true) +
      '<div class="stack">' +
      (X.role === 'host' ? '<button class="btn primary" data-vs="again">Play again</button>'
        : '<p class="muted">The host can start another game.</p>') +
      '<button class="btn quiet" data-vs="leave">Leave</button></div>', 'final');
  }

  function openMenu() {
    const v = X.V;
    if (!v) return;
    if (v.phase === 'lobby') { openLobby(); return; }
    if (v.phase === 'final') { openFinal(); return; }
    A().openDialog(
      `<h2>Game ${X.code}</h2>` + playerRows(v, true) +
      `<p class="muted">Connection: ${directCount() ? 'direct' : 'through the relay (moves may lag a second or two)'}</p>` +
      '<div class="stack"><button class="btn primary" data-act="close">Back to game</button>' +
      '<button class="btn quiet" data-vs="leave">Leave game</button></div>', 'vsmenu');
  }

  function directCount() {
    if (X.role === 'guest') return X.link && X.link.open ? 1 : 0;
    return Object.keys(X.links).filter((id) => X.links[id].open).length;
  }

  function onAction(name, el) {
    if (name === 'create') createGame();
    else if (name === 'join') joinGame();
    else if (name === 'leave') leave();
    else if (name === 'final') openFinal();
    else if (!X.V) return;
    else if (name === 'rounds' && X.role === 'host') { X.H.cfg.rounds = +el.dataset.value; commit(); }
    else if (name === 'start' && X.role === 'host' && X.H.players.length > 1) startGame();
    else if (name === 'again' && X.role === 'host') { A().closeDialog(); startGame(); }
    else if (name === 'minus') { X.draft--; A().render(); }
    else if (name === 'plus') { X.draft++; A().render(); }
    else if (name === 'bid') act({ a: 'bid', v: X.draft });
    else if (name === 'done') act({ a: 'done' });
    else if (name === 'unbid') act({ a: 'unbid' });
    else if (name === 'next') next();
  }

  RR.versus = {
    connected, active, view: () => X.V, tick, timer, canMove, move, canNext, canSeeSolutions, next,
    roundLabel, bidText, panelHtml, openEntry, openMenu, onAction,
    debug: () => X,
  };
})();
