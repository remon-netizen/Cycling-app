// Accounts and riding together. Accounts come from Supabase Auth; a "room" is a
// Supabase Realtime channel on which every rider broadcasts where they are once
// a second. Nothing is stored on the server. Rooms are private channels: the
// rules in supabase/rooms.sql let only signed-in users in.
//
// For development, open two tabs with ?net=local&name=Anna : that skips the
// accounts and talks between tabs of the same browser.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const params = new URLSearchParams(location.search);
const LOCAL = params.get('net') === 'local';
const STALE_MS = 6000;
const MAX_PEERS = 40;
const num = (x, lo, hi) => (Number.isFinite(+x) ? Math.min(hi, Math.max(lo, +x)) : lo);

export const cleanCode = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
export const newCode = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

export class Net {
  constructor() {
    this.available = LOCAL || !!(SUPABASE_URL && SUPABASE_ANON_KEY);
    this.local = LOCAL;
    this.user = null; // { id, name, email }
    this.room = null; // room code
    this.peers = new Map(); // id -> { id, name, riding, finished, dist, v, power, wkg, cadence, crank, last }
    this.onauth = () => {};
    this.onpeers = () => {}; // someone joined or left
    this.onstart = () => {}; // someone started the group ride: ({ in, startDist })
  }

  async init() {
    if (LOCAL) {
      this.user = { id: 'local-' + Math.random().toString(36).slice(2, 10), name: params.get('name') || 'Rider ' + Math.floor(Math.random() * 90 + 10) };
      this.onauth();
      return;
    }
    if (!this.available) return;
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2/+esm');
    this.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    this.sb.auth.onAuthStateChange((_event, session) => this._setUser(session?.user));
    const { data } = await this.sb.auth.getSession();
    this._setUser(data.session?.user);
  }

  _setUser(u) {
    const next = u ? { id: u.id, email: u.email, name: u.user_metadata?.name || u.email.split('@')[0] } : null;
    if (this._known && next?.id === this.user?.id && next?.name === this.user?.name) return;
    this._known = true;
    this.user = next;
    if (!next) this.leave();
    this.onauth();
  }

  // Returns 'in' when signed in straight away, 'confirm' when Supabase first
  // wants the e-mail address confirmed.
  async signUp(email, password, name) {
    const { data, error } = await this.sb.auth.signUp({
      email, password, options: { data: { name }, emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
    return data.session ? 'in' : 'confirm';
  }
  async signIn(email, password) {
    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }
  async signOut() {
    await this.sb?.auth.signOut();
  }

  async join(code) {
    code = cleanCode(code);
    if (!code || !this.user) throw new Error('Enter a room code');
    this.leave();
    const name = 'sommet-' + code;
    if (LOCAL) {
      this._bc = new BroadcastChannel(name);
      this._bc.onmessage = (e) => this._receive(e.data.event, e.data.payload);
    } else {
      const ch = (this._ch = this.sb.channel(name, { config: { private: true, broadcast: { self: false } } }));
      for (const ev of ['state', 'start', 'bye']) ch.on('broadcast', { event: ev }, (m) => this._receive(ev, m.payload));
      await new Promise((resolve, reject) =>
        ch.subscribe((status) => {
          if (status === 'SUBSCRIBED') resolve();
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error('Could not join the room. Rooms are for signed-in riders; try signing out and in again.'));
        })
      );
    }
    this.room = code;
    return code;
  }

  leave() {
    if (this.room) this.send('bye', { id: this.user?.id });
    this._bc?.close();
    this._bc = null;
    if (this._ch) this.sb.removeChannel(this._ch);
    this._ch = null;
    this.room = null;
    if (this.peers.size) {
      this.peers.clear();
      this.onpeers();
    }
  }

  send(event, payload) {
    if (this._bc) this._bc.postMessage({ event, payload });
    else if (this._ch) this._ch.send({ type: 'broadcast', event, payload });
  }
  sendState(state) {
    if (this.room) this.send('state', { id: this.user.id, name: this.user.name, ...state });
  }

  _receive(event, p) {
    if (!p || p.id === this.user?.id) return;
    if (event === 'start') return this.onstart(p);
    if (event === 'bye') {
      if (this.peers.delete(p.id)) this.onpeers();
      return;
    }
    if (typeof p.id !== 'string' || p.id.length > 64 || !Number.isFinite(+p.dist) || !Number.isFinite(+p.v)) return;
    let peer = this.peers.get(p.id);
    const isNew = !peer;
    if (isNew && this.peers.size >= MAX_PEERS) return;
    if (isNew) this.peers.set(p.id, (peer = { id: p.id, crank: 0, shown: +p.dist }));
    const was = peer.riding, wasRoute = peer.route, wasDone = peer.finished;
    Object.assign(peer, {
      name: String(p.name || 'Rider').slice(0, 20), route: String(p.route || '').slice(0, 24), riding: !!p.riding, finished: !!p.finished, dist: num(p.dist, 0, 1e6),
      v: num(p.v, 0, 40), power: num(p.power, 0, 3000), wkg: num(p.wkg, 0, 30), cadence: num(p.cadence, 0, 250), last: performance.now(),
    });
    if (isNew || was !== peer.riding || wasRoute !== peer.route || wasDone !== peer.finished) this.onpeers();
  }

  // Between messages, keep everyone rolling at their last known speed.
  tick(dt, maxDist) {
    const now = performance.now();
    let dropped = false;
    for (const peer of this.peers.values()) {
      if (now - peer.last > STALE_MS) {
        this.peers.delete(peer.id);
        dropped = true;
        continue;
      }
      if (!peer.riding) continue;
      peer.dist = Math.min(maxDist, peer.dist + peer.v * dt);
      // ease towards the reported position instead of jumping
      peer.shown = Math.abs(peer.dist - peer.shown) > 150 ? peer.dist : peer.shown + peer.v * dt + (peer.dist - peer.shown - peer.v * dt) * Math.min(1, dt * 2);
      peer.crank += (peer.cadence / 60) * 2 * Math.PI * dt;
    }
    if (dropped) this.onpeers();
  }
}
