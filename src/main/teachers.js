'use strict';
// Личные PIN преподавателей. Проверка идёт только здесь, в основном процессе:
// страница получает лишь временный номер сессии и не видит хеши.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { StoreError } = require('./store');

const scrypt = promisify(crypto.scrypt);
const PIN_RE = /^\d{6}$/;
const MAX_TRIES = 5;
const WAIT_MS = 5 * 60_000;
const IDLE_MS = 10 * 60_000;

const digest = async (pin, salt) =>
  (await scrypt(pin, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');

async function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: await digest(pin, salt) };
}

const sameText = (a, b) => {
  const hash = (text) => crypto.createHash('sha256').update(String(text)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
};

const checkPin = async (pin, stored) => sameText(await digest(String(pin), stored.salt), stored.hash);

class TeacherGate {
  /** networkKey: функция, потому что ключ может смениться в настройках. */
  constructor(store, networkKey, clock = Date.now) {
    this.store = store;
    this.networkKey = networkKey;
    this.clock = clock;
    this.tries = new Map();
    this.sessions = new Map();
  }

  async teacher(id) {
    const ref = await this.store.readCurrent(String(id)).catch(() => null);
    if (ref?.kind !== 'teacher' || ref.deleted) throw new StoreError('invalid', 'Преподаватель не найден');
    return ref;
  }

  assertNotBlocked(id) {
    if ((this.tries.get(id)?.until ?? 0) > this.clock()) throw new StoreError('pin-wait', 'Слишком много попыток');
  }

  failed(id) {
    const count = (this.tries.get(id)?.count ?? 0) + 1;
    this.tries.set(id, count >= MAX_TRIES ? { count: 0, until: this.clock() + WAIT_MS } : { count, until: 0 });
  }

  async login(id, pin) {
    const teacher = await this.teacher(id);
    if (!teacher.pin) throw new StoreError('no-pin', 'PIN не задан');
    this.assertNotBlocked(teacher.id);
    if (!await checkPin(pin, teacher.pin)) {
      this.failed(teacher.id);
      throw new StoreError('wrong-pin', 'Неверный PIN');
    }
    this.tries.delete(teacher.id);
    const token = crypto.randomUUID();
    this.sessions.set(token, { name: teacher.name, seen: this.clock() });
    return { token, name: teacher.name };
  }

  /** Имя вошедшего преподавателя или null. Каждое действие продлевает сессию. */
  session(token) {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (this.clock() - session.seen > IDLE_MS) {
      this.sessions.delete(token);
      return null;
    }
    session.seen = this.clock();
    return session.name;
  }

  logout(token) {
    this.sessions.delete(token);
  }

  /** Менять PIN можно по текущему PIN или ключу сети, которого нет у студентов. */
  async mayChange(teacher, proof) {
    this.assertNotBlocked(teacher.id);
    const key = this.networkKey();
    if (key && sameText(proof, key)) return;
    if (teacher.pin && await checkPin(proof, teacher.pin)) return;
    if (!key && !teacher.pin) return;
    this.failed(teacher.id);
    throw new StoreError('wrong-proof', 'Неверный ключ сети или PIN');
  }

  async setPin(id, proof, pin) {
    if (!PIN_RE.test(String(pin))) throw new StoreError('invalid-pin', 'PIN состоит из шести цифр');
    const teacher = await this.teacher(id);
    await this.mayChange(teacher, proof);
    await this.store.setTeacherPin(teacher.id, await hashPin(String(pin)));
  }

  /** Забытый PIN снимается только ключом сети. */
  async resetPin(id, key) {
    const teacher = await this.teacher(id);
    this.assertNotBlocked(teacher.id);
    if (!this.networkKey() || !sameText(key, this.networkKey())) {
      this.failed(teacher.id);
      throw new StoreError('wrong-proof', 'Неверный ключ сети');
    }
    await this.store.setTeacherPin(teacher.id, null);
  }
}

module.exports = { TeacherGate, hashPin, sameText };
