'use strict';
// Каждое мероприятие — отдельный JSON-файл в <папка данных>/events.
// Так несколько панелей могут работать с одной сетевой папкой: запись одного
// мероприятия не затрагивает остальные, а файл заменяется атомарно.
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const text = String(item).trim();
    const key = text.toLocaleLowerCase('ru');
    if (text && !seen.has(key)) {
      seen.add(key);
      result.push(text);
    }
  }
  return result;
}

/** Приводит запись к единому виду. Возвращает null, если она непригодна. */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const event = {
    id: String(raw.id ?? ''),
    title: String(raw.title ?? '').trim(),
    date: String(raw.date ?? ''),
    start: String(raw.start ?? ''),
    end: String(raw.end ?? ''),
    place: String(raw.place ?? '').trim(),
    responsible: String(raw.responsible ?? '').trim(),
    participants: cleanList(raw.participants),
    equipment: cleanList(raw.equipment),
    notes: String(raw.notes ?? '').trim(),
    updatedAt: String(raw.updatedAt ?? ''),
  };
  const valid =
    ID_RE.test(event.id) &&
    event.title &&
    DATE_RE.test(event.date) &&
    TIME_RE.test(event.start) &&
    TIME_RE.test(event.end) &&
    event.start < event.end;
  return valid ? event : null;
}

class EventStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'events');
    this.cache = new Map(); // имя файла → { stamp, event }
  }

  fileFor(id) {
    return path.join(this.dir, `${id}.json`);
  }

  /** Читает папку. Неизменившиеся файлы берёт из памяти: по сети это важно. */
  async list() {
    await fsp.mkdir(this.dir, { recursive: true });
    const names = (await fsp.readdir(this.dir)).filter((name) => name.endsWith('.json'));
    const fresh = new Map();
    await Promise.all(
      names.map(async (name) => {
        try {
          const full = path.join(this.dir, name);
          const stat = await fsp.stat(full);
          const stamp = `${stat.mtimeMs}:${stat.size}`;
          const known = this.cache.get(name);
          if (known && known.stamp === stamp) {
            fresh.set(name, known);
            return;
          }
          const event = normalizeEvent(JSON.parse(await fsp.readFile(full, 'utf8')));
          if (event) fresh.set(name, { stamp, event });
          else console.error('Пропущен неверный файл мероприятия:', name);
        } catch (err) {
          // Файл могли удалить на другой панели, пока мы читали папку.
          if (err.code !== 'ENOENT') console.error('Файл мероприятия не прочитан:', name, err.message);
        }
      }),
    );
    this.cache = fresh;
    return [...fresh.values()].map((entry) => entry.event).sort((a, b) => a.id.localeCompare(b.id));
  }

  async readCurrent(id) {
    try {
      return JSON.parse(await fsp.readFile(this.fileFor(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Отказывает, если запись успели изменить или удалить на другой панели. */
  async assertUnchanged(id, baseUpdatedAt) {
    const current = await this.readCurrent(id);
    if (!current || current.updatedAt !== baseUpdatedAt) {
      throw new StoreError('conflict', 'Мероприятие изменили на другой панели');
    }
  }

  async save(input, baseUpdatedAt = null) {
    const isNew = !input.id;
    const event = normalizeEvent({
      ...input,
      id: input.id || crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    });
    if (!event) throw new StoreError('invalid', 'Проверьте название, дату и время');
    if (!isNew) await this.assertUnchanged(event.id, baseUpdatedAt);

    await fsp.mkdir(this.dir, { recursive: true });
    const target = this.fileFor(event.id);
    const temp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(event, null, 2), 'utf8');
    await fsp.rename(temp, target);
    return event;
  }

  async remove(id, baseUpdatedAt) {
    if (!ID_RE.test(String(id))) throw new StoreError('invalid', 'Неверный номер мероприятия');
    await this.assertUnchanged(id, baseUpdatedAt);
    await fsp.rm(this.fileFor(id), { force: true });
  }
}

module.exports = { EventStore, StoreError, normalizeEvent };
