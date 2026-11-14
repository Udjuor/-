'use strict';
// Обмен мероприятиями между устройствами без сервера.
//
// Каждое устройство хранит полную копию данных. Встретив другое устройство, оно
// сравнивает с ним списки записей и обе стороны забирают недостающее. Поэтому
// запись дойдёт до выключенного компьютера через любое устройство, которое
// связалось и с автором, и с ним.
//
// Все сообщения зашифрованы ключом сети (AES-256-GCM): в них фамилии студентов,
// а ключ заодно подтверждает, что отправитель из той же сети.
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { revision } = require('./store');

const DEFAULT_PORT = 47800;
const DISCOVERY_PORT = 47801;
const ROUND_MS = 60_000;
const HELLO_MS = 30_000;
const NUDGE_MS = 1500;
const REQUEST_MS = 8000;
const MAX_BODY = 32 * 1024 * 1024;
const FANOUT = 8; // за один круг: остальных запись догонит по цепочке
const PING_MS = 4000;
const LISTEN_MS = 3000;
/** Если ни с кем не было обмена столько времени, узел сам перезапускает поиск устройств. */
const HEAL_MS = 15 * 60_000;
/** Что умеет узел сверх обмена: проверку связи (ping) и встречную проверку (probe). */
const CAPS = ['diag'];
const ADDRESS = /^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/;

// Версия обмена. С 2 в записях есть типы событий: устройство старой версии
// потеряло бы их, сохраняя копию, поэтому такие устройства ждут обновления.
const PROTOCOL = 2;

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Случайный ключ сети: 100 бит, записывается группами, без похожих символов. */
function generateKey() {
  const chars = Array.from({ length: 20 }, () => KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)]);
  return chars.join('').match(/.{5}/g).join('-');
}

const deriveKey = (networkKey) => crypto.scryptSync(networkKey.trim(), 'student-calendar-sync-v1', 32);

function seal(key, label, message) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(label));
  const data = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

/** Бросает исключение, если сообщение подделано или ключ другой. */
function open(key, label, packet) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, packet.subarray(0, 12));
  decipher.setAAD(Buffer.from(label));
  decipher.setAuthTag(packet.subarray(12, 28));
  const text = Buffer.concat([decipher.update(packet.subarray(28)), decipher.final()]).toString('utf8');
  return JSON.parse(text);
}

/** IPv4-адреса компьютера и широковещательные адреса его подсетей. */
function localNetworks() {
  const addresses = [];
  const broadcasts = ['255.255.255.255'];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      addresses.push(entry.address);
      const ip = entry.address.split('.').map(Number);
      const mask = entry.netmask.split('.').map(Number);
      broadcasts.push(ip.map((part, i) => (part & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return { addresses, broadcasts: [...new Set(broadcasts)] };
}

function shuffled(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const withPort = (address, port) => (address.includes(':') ? address : `${address}:${port}`);

/** Отпечаток ключа сети: по нему видно, одинаковый ли ключ на двух устройствах, сам ключ не раскрывается. */
const keyPrint = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8).toUpperCase().replace(/(.{4})/, '$1-');

/** Подсети компьютера: адрес и маска, чтобы понять, в одной ли сети другое устройство. */
function localSubnets() {
  const list = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) list.push({ name, address: entry.address, netmask: entry.netmask });
    }
  }
  return list;
}

const toInt = (ip) => ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
function sameSubnet(address, subnets) {
  const ip = String(address).split(':')[0];
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  return subnets.some((net) => ((toInt(ip) & toInt(net.netmask)) >>> 0) === ((toInt(net.address) & toInt(net.netmask)) >>> 0));
}

/** Почему не удалось связаться: понятная причина вместо кода ошибки. */
function failure(err) {
  if (err.status) return err.status;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  const code = err.cause?.code ?? err.code;
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL') return 'unreachable';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'timeout';
  return 'offline';
}

class SyncNode {
  /**
   * @param options.store хранилище мероприятий
   * @param options.device { id, name }
   * @param options.networkKey ключ сети
   * @param options.peers адреса устройств, до которых не доходит рассылка
   * @param options.peersFile файл со списком известных устройств
   * @param options.onChange вызывается, когда с другого устройства пришли данные
   */
  constructor({
    store, device, networkKey, peers = [], peersFile = null, onChange = () => {},
    port = DEFAULT_PORT, discoveryPort = DISCOVERY_PORT, discoveryTargets = null, timers = true, protocol = PROTOCOL,
    version = '', edition = '', clock = () => Date.now(),
  }) {
    this.version = version;
    this.edition = edition;
    this.clock = clock;
    this.lastOkAt = null;
    this.lastHealAt = clock();
    this.heals = 0;
    this.store = store;
    this.device = device;
    this.key = deriveKey(networkKey);
    this.print = keyPrint(this.key);
    this.manual = peers.map((address) => withPort(address, DEFAULT_PORT));
    this.peersFile = peersFile;
    this.onChange = onChange;
    this.port = port;
    this.discoveryPort = discoveryPort;
    this.discoveryTargets = discoveryTargets;
    this.useTimers = timers;
    this.protocol = protocol;
    this.peers = new Map(); // id → { id, name, address, lastSync, status }
    this.manualStatus = new Map(); // адрес, с которым ещё не было связи → состояние
    this.timers = [];
    this.nudgeTimer = null;
    this.stopped = false;
    this.loadPeers();
  }

  loadPeers() {
    if (!this.peersFile) return;
    try {
      for (const peer of JSON.parse(fs.readFileSync(this.peersFile, 'utf8'))) {
        if (peer.id && peer.id !== this.device.id) this.peers.set(peer.id, { ...peer, status: 'unknown' });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Список устройств не прочитан:', err.message);
    }
  }

  savePeers() {
    if (!this.peersFile) return;
    const list = [...this.peers.values()].map(({ status, ...peer }) => peer);
    fs.promises.writeFile(this.peersFile, JSON.stringify(list, null, 2), 'utf8')
      .catch((err) => console.error('Список устройств не сохранён:', err.message));
  }

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.requestTimeout = REQUEST_MS * 2;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    await this.startDiscovery();
    if (this.useTimers) {
      this.timers.push(setInterval(() => this.round(), ROUND_MS));
      this.timers.push(setInterval(() => this.hello(), HELLO_MS));
      this.hello();
      this.round();
    }
  }

  async startDiscovery() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    this.discoveryReady = false;
    socket.on('error', (err) => console.error('Поиск устройств:', err.message));
    socket.on('message', (packet, info) => this.onHello(packet, info));
    await new Promise((resolve) => {
      socket.once('error', resolve);
      socket.bind(this.discoveryPort, () => {
        socket.setBroadcast(true);
        this.discoveryReady = true;
        resolve();
      });
    });
  }

  /** Заново открывает поиск устройств: помогает, когда сеть компьютера переподключилась. */
  async restartDiscovery() {
    try { this.socket?.close(); } catch { /* уже закрыт */ }
    await this.startDiscovery();
    this.hello();
  }

  async stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    clearTimeout(this.nudgeTimer);
    try { this.socket?.close(); } catch { /* уже закрыт */ }
    await new Promise((resolve) => {
      if (!this.server?.listening) return resolve();
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  identity() {
    return { id: this.device.id, name: this.device.name, port: this.port, protocol: this.protocol, version: this.version, edition: this.edition, caps: CAPS };
  }

  /** Сообщает о себе в подсетях. Посторонние не смогут прочитать пакет. */
  hello() {
    if (this.stopped || !this.socket) return;
    const packet = seal(this.key, 'hello', this.identity());
    const targets = this.discoveryTargets ?? localNetworks().broadcasts.map((address) => ({ address, port: this.discoveryPort }));
    for (const { address, port } of targets) {
      this.socket.send(packet, port, address, () => {});
    }
  }

  onHello(packet, info) {
    let peer;
    try {
      peer = open(this.key, 'hello', packet);
    } catch {
      return; // чужая сеть или случайный пакет
    }
    if (peer.id === this.device.id) return;
    const known = this.peers.has(peer.id);
    this.remember(peer.id, peer.name, `${info.address}:${peer.port}`, { ...about(peer), heardAt: this.clock() });
    if (!known) this.syncWith(this.peers.get(peer.id).address, peer.id);
  }

  remember(id, name, address, extra = {}) {
    if (!id || id === this.device.id) return;
    const peer = this.peers.get(id) ?? { id, name, address, lastSync: null, status: 'unknown' };
    this.peers.set(id, { ...peer, ...extra, name: name || peer.name, address: address || peer.address });
  }

  /** Адреса других устройств расходятся по сети, в том числе между подсетями. */
  learn(list) {
    for (const peer of list ?? []) {
      if (peer?.id && peer.id !== this.device.id && !this.peers.has(peer.id)) {
        this.remember(String(peer.id), String(peer.name ?? ''), String(peer.address ?? ''));
      }
    }
  }

  publicPeers() {
    return [...this.peers.values()].map(({ id, name, address }) => ({ id, name, address }));
  }

  async handle(req, res) {
    if (req.method !== 'POST' || req.url !== '/v1') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
    let message;
    try {
      message = open(this.key, 'request', Buffer.concat(chunks));
    } catch {
      res.writeHead(401).end();
      return;
    }
    if (!(message.from?.protocol >= PROTOCOL)) {
      res.writeHead(426).end();
      return;
    }
    try {
      const address = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      this.remember(message.from?.id, message.from?.name, address && `${address}:${message.from?.port}`, { ...about(message.from), contactAt: this.clock() });
      this.learn(message.peers);
      const reply = await this.answer(message);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        .end(seal(this.key, 'response', { from: this.identity(), peers: this.publicPeers(), ...reply }));
    } catch (err) {
      console.error('Ошибка обмена:', err.message);
      res.writeHead(500).end();
    }
  }

  async answer(message) {
    if (message.type === 'ping') return { count: (await this.store.records()).length };
    // Встречная проверка: «попробуй достучаться до меня» — так видно, что входящие блокирует брандмауэр.
    if (message.type === 'probe') {
      const targets = (message.targets ?? []).map(String).filter((a) => ADDRESS.test(a)).slice(0, 4);
      return { results: await Promise.all(targets.map(async (address) => ({ address, ...(await this.ping(address)) }))) };
    }
    if (message.type === 'push') {
      await this.accept(message.records ?? []);
      return {};
    }
    const mine = await this.store.records();
    const theirs = new Map((message.manifest ?? []).map((item) => [item.id, item.revision]));
    const ours = new Set(mine.map((record) => record.id));
    const send = mine.filter((record) => {
      const other = theirs.get(record.id);
      return other === undefined || revision(record) > other;
    });
    const want = [...theirs.keys()].filter((id) => {
      const local = mine.find((record) => record.id === id);
      return !ours.has(id) || revision(local) < theirs.get(id);
    });
    return { send, want };
  }

  async accept(records) {
    const changed = await this.store.merge(records);
    if (changed) {
      this.onChange();
      this.nudge();
    }
    return changed;
  }

  async request(address, message, timeout = REQUEST_MS) {
    const response = await fetch(`http://${address}/v1`, {
      method: 'POST',
      body: seal(this.key, 'request', { ...message, from: this.identity(), peers: this.publicPeers() }),
      signal: AbortSignal.timeout(timeout),
    });
    if (response.status === 426) throw Object.assign(new Error('старая версия'), { status: 'outdated' });
    if (response.status === 401) throw Object.assign(new Error('другой ключ сети'), { status: 'wrong-key' });
    if (!response.ok) throw new Error(`код ответа ${response.status}`);
    let reply;
    try {
      reply = open(this.key, 'response', Buffer.from(await response.arrayBuffer()));
    } catch {
      throw Object.assign(new Error('другой ключ сети'), { status: 'wrong-key' });
    }
    return reply;
  }

  async syncWith(address, peerId = null) {
    if (this.stopped) return false;
    const setStatus = (status, id) => {
      const peer = id && this.peers.get(id);
      if (peer) this.peers.set(id, { ...peer, status, ...(status === 'ok' ? { lastSync: new Date().toISOString() } : {}) });
    };
    try {
      const records = await this.store.records();
      const manifest = records.map((record) => ({ id: record.id, revision: revision(record) }));
      const reply = await this.request(address, { type: 'sync', manifest });
      if (reply.from?.id === this.device.id) return false; // в списке адресов оказался свой
      if (!(reply.from?.protocol >= PROTOCOL)) throw Object.assign(new Error('старая версия'), { status: 'outdated' });
      this.remember(reply.from?.id, reply.from?.name, address, about(reply.from));
      this.learn(reply.peers);
      await this.accept(reply.send ?? []);
      const wanted = new Set(reply.want ?? []);
      if (wanted.size) {
        await this.request(address, { type: 'push', records: records.filter((record) => wanted.has(record.id)) });
      }
      this.manualStatus.set(address, 'ok');
      setStatus('ok', reply.from?.id);
      this.lastOkAt = this.clock();
      return true;
    } catch (err) {
      const status = err.status ?? 'offline';
      this.manualStatus.set(address, status);
      setStatus(status, peerId);
      return false;
    }
  }

  /** Один круг обмена: адреса из настроек и несколько случайных устройств. */
  async round({ all = false } = {}) {
    if (this.stopped) return;
    this.hello();
    const known = shuffled(this.peers.values()).filter((peer) => peer.address);
    const chosen = all ? known : known.slice(0, FANOUT);
    const jobs = new Map(chosen.map((peer) => [peer.address, peer.id]));
    for (const address of this.manual) if (!jobs.has(address)) jobs.set(address, null);
    const results = await Promise.all([...jobs].map(([address, id]) => this.syncWith(address, id)));
    this.savePeers();
    await this.heal(jobs.size > 0 && !results.some(Boolean));
  }

  /**
   * Самовосстановление: долго нет ни одного обмена — заново открываем поиск устройств
   * и спрашиваем все известные адреса, а не только случайные.
   */
  async heal(failedRound) {
    const now = this.clock();
    const since = this.lastOkAt ?? this.lastHealAt;
    if (!failedRound || now - since < HEAL_MS || now - this.lastHealAt < HEAL_MS || this.stopped) return false;
    this.lastHealAt = now;
    this.heals += 1;
    await this.restartDiscovery().catch((err) => console.error('Поиск устройств не перезапущен:', err.message));
    return true;
  }

  /** Короткая проверка связи с одним адресом, без обмена данными. */
  async ping(address) {
    const started = this.clock();
    try {
      const reply = await this.request(address, { type: 'ping' }, PING_MS);
      if (reply.from?.id === this.device.id) return { status: 'self' };
      return { status: 'ok', ms: this.clock() - started, id: reply.from?.id, name: reply.from?.name, version: reply.from?.version ?? '', edition: reply.from?.edition ?? '', count: reply.count ?? null };
    } catch (err) {
      return { status: failure(err) };
    }
  }

  /** Добавляет адрес вручную (например, компьютер преподавателя с постоянным IP в другой подсети). */
  async addManual(address) {
    const target = withPort(String(address).trim(), DEFAULT_PORT);
    if (!ADDRESS.test(target)) throw Object.assign(new Error('bad address'), { code: 'bad-address' });
    if (!this.manual.includes(target)) this.manual.push(target);
    const ok = await this.syncWith(target);
    return { address: target, status: ok ? 'ok' : this.manualStatus.get(target) ?? 'offline' };
  }

  /** Забывает адреса, по которым давно нет связи: после смены сети они только мешают. */
  forgetStale() {
    let removed = 0;
    for (const [id, peer] of this.peers) {
      if (peer.status !== 'ok') {
        this.peers.delete(id);
        removed += 1;
      }
    }
    this.savePeers();
    this.hello();
    return removed;
  }

  /**
   * Полная проверка связи: сеть компьютера, поиск устройств рассылкой, связь с каждым
   * известным устройством и встречная проверка — доходят ли другие до этого компьютера.
   */
  async diagnose({ listenMs = LISTEN_MS } = {}) {
    const started = this.clock();
    const subnets = localSubnets();
    this.hello();
    await new Promise((resolve) => { setTimeout(resolve, listenMs); });
    const heard = new Set([...this.peers.values()].filter((p) => p.heardAt >= started).map((p) => p.id));
    const targets = new Map();
    for (const peer of this.peers.values()) if (peer.address) targets.set(peer.address, peer);
    for (const address of this.manual) if (!targets.has(address)) targets.set(address, null);
    const peers = await Promise.all([...targets].map(async ([address, peer]) => {
      // Старые версии не знают проверку связи: с ними проверяем обычным обменом.
      let result;
      if (!peer || (peer.caps ?? []).includes('diag')) result = await this.ping(address);
      else result = { status: (await this.syncWith(address, peer.id)) ? 'ok' : this.peers.get(peer.id)?.status ?? 'offline' };
      if (result.status === 'ok' && result.id) this.remember(result.id, result.name, address, { version: result.version, edition: result.edition, caps: CAPS, status: 'ok', lastSync: new Date(this.clock()).toISOString() });
      const known = (result.id && this.peers.get(result.id)) || peer;
      return {
        address,
        id: known?.id ?? null,
        name: result.name || known?.name || address,
        version: result.version || known?.version || '',
        edition: result.edition || known?.edition || '',
        manual: this.manual.includes(address),
        sameSubnet: sameSubnet(address, subnets),
        heard: Boolean(known?.id && heard.has(known.id)),
        lastSync: known?.lastSync ?? null,
        ...result,
      };
    }));
    const self = peers.filter((p) => p.status === 'self');
    const list = peers.filter((p) => p.status !== 'self');
    // Встречная проверка через тех, кто на связи и умеет её делать.
    let inbound = 'unknown';
    const helpers = list.filter((p) => p.status === 'ok' && p.version).slice(0, 3);
    const mine = subnets.map((net) => `${net.address}:${this.port}`);
    for (const helper of helpers) {
      try {
        const reply = await this.request(helper.address, { type: 'probe', targets: mine }, PING_MS * 2);
        if ((reply.results ?? []).some((r) => r.status === 'ok' || r.status === 'self')) {
          inbound = 'ok';
          break;
        }
        inbound = 'blocked';
      } catch {
        // этот помощник не ответил — спросим следующего
      }
    }
    this.savePeers();
    return {
      at: new Date(started).toISOString(),
      device: { ...this.identity(), keyPrint: this.print },
      subnets,
      listening: Boolean(this.server?.listening),
      discovery: Boolean(this.discoveryReady),
      heard: heard.size,
      peers: list.sort((a, b) => (a.status === 'ok') - (b.status === 'ok') || a.name.localeCompare(b.name, 'ru')),
      ignoredSelf: self.length,
      inbound,
      lastOkAt: this.lastOkAt,
      heals: this.heals,
    };
  }

  /** Просит разослать изменения вскоре, собирая несколько правок в один обмен. */
  nudge() {
    if (this.stopped || this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      this.round();
    }, NUDGE_MS);
    this.nudgeTimer.unref?.();
  }

  status() {
    const reached = new Set([...this.peers.values()].map((peer) => peer.address));
    // Связь была, если обменялись сами или к нам обратились: панель за брандмауэром сама ходит к другим.
    const lastSyncs = [...this.peers.values()].flatMap((p) => [Date.parse(p.lastSync ?? ''), p.contactAt ?? NaN]).filter(Number.isFinite);
    return {
      enabled: true,
      keyPrint: this.print,
      lastOkAt: Math.max(this.lastOkAt ?? 0, ...lastSyncs) || null,
      now: this.clock(),
      discovery: Boolean(this.discoveryReady),
      addresses: localNetworks().addresses,
      port: this.port,
      peers: [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      unreachable: this.manual
        .filter((address) => !reached.has(address))
        .map((address) => ({ address, status: this.manualStatus.get(address) ?? 'unknown' })),
    };
  }
}

/** Сведения об устройстве из его сообщения: версия программы и что оно умеет. */
function about(from) {
  if (!from) return {};
  const out = {};
  if (typeof from.version === 'string' && from.version) out.version = from.version.slice(0, 20);
  if (from.edition === 'admin' || from.edition === 'client') out.edition = from.edition;
  if (Array.isArray(from.caps)) out.caps = from.caps.filter((c) => typeof c === 'string').slice(0, 8);
  return out;
}

module.exports = { SyncNode, generateKey, seal, open, deriveKey, keyPrint, sameSubnet, failure, DEFAULT_PORT, localNetworks, HEAL_MS };
