// Run with: node tests/net.test.js   (needs internet; checks each public relay)
const path = require('path');
const RR = require(path.join(__dirname, '../app/src/main/assets/www/js/net.js'));

function roundTrip(url) {
  return new Promise((resolve) => {
    const topic = 'ricochet-hm/test/' + Math.random().toString(36).slice(2);
    const text = JSON.stringify({ hello: 'wörld', big: 'x'.repeat(3000) });
    const t0 = Date.now();
    let a, b, repeat;
    const finish = (ok, why) => { clearInterval(repeat); a && a.close(); b && b.close(); clearTimeout(timer); resolve({ url, ok, why, ms: Date.now() - t0 }); };
    const timer = setTimeout(() => finish(false, 'timeout'), 15000);
    a = new RR.Relay(url, {
      onopen() {
        a.subscribe(topic);
        // Repeat until it arrives: a relay may take a moment to route a new subscription.
        b = new RR.Relay(url, { onopen() { repeat = setInterval(() => b.publish(topic, text), 500); } });
      },
      onmessage(t, m) { finish(t === topic && m === text, 'mismatch'); },
    });
  });
}

(async () => {
  let failed = 0;
  for (const url of RR.RELAYS) {
    const r = await roundTrip(url);
    console.log(r.ok ? 'ok  ' : 'FAIL', r.url, r.ok ? r.ms + 'ms' : r.why);
    if (!r.ok) failed++;
  }
  process.exit(failed ? 1 : 0);
})();
