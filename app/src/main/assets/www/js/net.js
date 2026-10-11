// Minimal MQTT 3.1.1 client over WebSocket (QoS 0 only). Multiplayer uses a
// public MQTT broker purely as a message relay between the phones.
(function (root) {
  'use strict';

  // The first letter of a game code says which relay the game lives on, so a
  // guest always connects to the same one as the host. Only relays that run as
  // a single cluster belong here: broker.emqx.io, for one, hands out several
  // unconnected regional servers, so two phones often cannot see each other.
  const RELAYS = [
    'wss://broker.hivemq.com:8884/mqtt',
  ];

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function str(s) {
    const b = encoder.encode(s);
    const out = new Uint8Array(b.length + 2);
    out[0] = b.length >> 8;
    out[1] = b.length & 255;
    out.set(b, 2);
    return out;
  }

  function packet(type, parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const head = [type];
    let n = len;
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 128;
      head.push(b);
    } while (n > 0);
    const out = new Uint8Array(head.length + len);
    out.set(head, 0);
    let at = head.length;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  // handlers: onopen(), onmessage(topic, text), onclose()
  function Relay(url, handlers) {
    this.url = url;
    this.handlers = handlers;
    this.topics = new Set();
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.buffer = new Uint8Array(0);
    this.pingTimer = 0;
    this.retryTimer = 0;
    this.connect();
  }

  Relay.prototype.connect = function () {
    if (this.closed) return;
    let ws;
    try {
      ws = new WebSocket(this.url, 'mqtt');
    } catch (e) {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const id = 'rr' + Math.random().toString(36).slice(2, 12);
      // Protocol "MQTT" level 4, clean session, 30 s keep-alive.
      ws.send(packet(0x10, [str('MQTT'), Uint8Array.of(4, 2, 0, 30), str(id)]));
    };
    ws.onmessage = (e) => this.receive(new Uint8Array(e.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      const wasReady = this.ready;
      this.ready = false;
      clearInterval(this.pingTimer);
      if (wasReady && this.handlers.onclose) this.handlers.onclose();
      this.retry();
    };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* already closed */ } };
  };

  Relay.prototype.retry = function () {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), 2000);
  };

  Relay.prototype.receive = function (chunk) {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer, 0);
    joined.set(chunk, this.buffer.length);
    let buf = joined;
    for (;;) {
      if (buf.length < 2) break;
      let len = 0;
      let mult = 1;
      let at = 1;
      let done = false;
      while (at < buf.length && at <= 4) {
        const b = buf[at++];
        len += (b & 127) * mult;
        mult *= 128;
        if (!(b & 128)) { done = true; break; }
      }
      if (!done || buf.length < at + len) break;
      this.handle(buf[0], buf.subarray(at, at + len));
      buf = buf.subarray(at + len);
    }
    this.buffer = buf.slice();
  };

  Relay.prototype.handle = function (head, body) {
    const type = head >> 4;
    if (type === 2) { // CONNACK
      if (body[1] !== 0) { this.ws.close(); return; }
      this.ready = true;
      for (const t of this.topics) this.sendSubscribe(t);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ready) this.ws.send(Uint8Array.of(0xC0, 0));
      }, 20000);
      if (this.handlers.onopen) this.handlers.onopen();
    } else if (type === 3) { // PUBLISH
      const tlen = (body[0] << 8) | body[1];
      const topic = decoder.decode(body.subarray(2, 2 + tlen));
      const skip = (head & 6) ? 2 : 0;
      const text = decoder.decode(body.subarray(2 + tlen + skip));
      if (this.handlers.onmessage) this.handlers.onmessage(topic, text);
    }
  };

  Relay.prototype.sendSubscribe = function (topic) {
    this.ws.send(packet(0x82, [Uint8Array.of(0, 1), str(topic), Uint8Array.of(0)]));
  };

  Relay.prototype.subscribe = function (topic) {
    this.topics.add(topic);
    if (this.ready) this.sendSubscribe(topic);
  };

  // Returns false if the message could not be sent right now.
  Relay.prototype.publish = function (topic, text) {
    if (!this.ready) return false;
    try {
      this.ws.send(packet(0x30, [str(topic), encoder.encode(text)]));
      return true;
    } catch (e) {
      return false;
    }
  };

  Relay.prototype.close = function () {
    this.closed = true;
    this.ready = false;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    if (this.ws) { try { this.ws.close(); } catch (e) { /* already closed */ } }
  };

  root.RR = Object.assign(root.RR || {}, { Relay, RELAYS });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.RR;
})(typeof self !== 'undefined' ? self : globalThis);
