'use strict';
// Каждое мероприятие — отдельный JSON-файл в <папка данных>/events.
// Запись одного мероприятия не затрагивает остальные, а файл заменяется атомарно.
// Удалённое мероприятие остаётся отметкой { deleted: true }: иначе устройство,
// которое было выключено, вернуло бы его при следующем обмене.
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
    devices: cleanList(raw.devices),
    updatedAt: String(raw.updatedAt ?? ''),
    updatedBy: String(raw.updatedBy ?? ''),
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

const REF_KINDS = new Set(['group', 'student', 'equipment', 'teacher']);

/** Запись справочника: группа, студент, техника или преподаватель. */
function normalizeRef(raw) {
  if (!raw || !REF_KINDS.has(raw.kind)) return null;
  const ref = {
    id: String(raw.id ?? ''),
    kind: raw.kind,
    name: String(raw.name ?? '').trim(),
    updatedAt: String(raw.updatedAt ?? ''),
    updatedBy: String(raw.updatedBy ?? ''),
  };
  if (raw.kind === 'student') ref.groupId = String(raw.groupId ?? '');
  const valid = ID_RE.test(ref.id) && ref.name && (raw.kind !== 'student' || ID_RE.test(ref.groupId));
  return valid ? ref : null;
}

/** Запись для хранения и обмена: мероприятие, справочник или отметка об удалении. */
function normalizeRecord(raw) {
  if (raw && raw.deleted === true) {
    const id = String(raw.id ?? '');
    return ID_RE.test(id)
      ? { id, deleted: true, updatedAt: String(raw.updatedAt ?? ''), updatedBy: String(raw.updatedBy ?? '') }
      : null;
  }
  return raw?.kind ? normalizeRef(raw) : normalizeEvent(raw);
}

/** Какая запись новее. Равные метки времени разводит номер устройства. */
const revision = (record) => `${record.updatedAt}|${record.updatedBy ?? ''}`;

/** Метка новой версии всегда позже предыдущей, даже если часы устройства отстают. */
function nextStamp(previous) {
  const now = Date.now();
  const before = previous ? Date.parse(previous) : 0;
  return new Date(Math.max(now, (before || 0) + 1)).toISOString();
}

class EventStore {
  constructor(dataDir, deviceId = '') {
    this.dir = path.join(dataDir, 'events');
    this.deviceId = deviceId;
    this.cache = new Map(); // имя файла → { stamp, record }
  }

  fileFor(id) {
    return path.join(this.dir, `${id}.json`);
  }

  /** Читает папку. Неизменившиеся файлы берёт из памяти: по сети это важно. */
  async records() {
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
          const record = normalizeRecord(JSON.parse(await fsp.readFile(full, 'utf8')));
          if (record) fresh.set(name, { stamp, record });
          else console.error('Пропущен неверный файл мероприятия:', name);
        } catch (err) {
          // Файл могли удалить на другой панели, пока мы читали папку.
          if (err.code !== 'ENOENT') console.error('Файл мероприятия не прочитан:', name, err.message);
        }
      }),
    );
    this.cache = fresh;
    return [...fresh.values()].map((entry) => entry.record).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Действующие мероприятия, без отметок об удалении. */
  async list() {
    return (await this.records()).filter((record) => !record.deleted && !record.kind);
  }

  /** Записи справочников. */
  async directory() {
    return (await this.records()).filter((record) => !record.deleted && record.kind);
  }

  async readCurrent(id) {
    try {
      return JSON.parse(await fsp.readFile(this.fileFor(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Отказывает, если запись успели изменить или удалить на другом устройстве. */
  async assertUnchanged(id, baseUpdatedAt) {
    const current = await this.readCurrent(id);
    if (!current || current.deleted || current.updatedAt !== baseUpdatedAt) {
      throw new StoreError('conflict', 'Мероприятие изменили на другом устройстве');
    }
    return current;
  }

  async write(record) {
    await fsp.mkdir(this.dir, { recursive: true });
    const target = this.fileFor(record.id);
    const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(record, null, 2), 'utf8');
    await fsp.rename(temp, target);
  }

  async save(input, baseUpdatedAt = null) {
    const isNew = !input.id;
    const draft = normalizeEvent({
      ...input,
      id: input.id || crypto.randomUUID(),
      updatedAt: '',
      updatedBy: this.deviceId,
    });
    if (!draft) throw new StoreError('invalid', 'Проверьте название, дату и время');
    const current = isNew ? null : await this.assertUnchanged(draft.id, baseUpdatedAt);
    const event = { ...draft, updatedAt: nextStamp(current?.updatedAt) };
    await this.write(event);
    return event;
  }

  async saveRef(input, baseUpdatedAt = null) {
    const isNew = !input.id;
    const draft = normalizeRef({ ...input, id: input.id || crypto.randomUUID(), updatedAt: '', updatedBy: this.deviceId });
    if (!draft) throw new StoreError('invalid', 'Проверьте название');
    const current = isNew ? null : await this.assertUnchanged(draft.id, baseUpdatedAt);
    const ref = { ...draft, updatedAt: nextStamp(current?.updatedAt) };
    await this.write(ref);
    return ref;
  }

  async remove(id, baseUpdatedAt) {
    if (!ID_RE.test(String(id))) throw new StoreError('invalid', 'Неверный номер мероприятия');
    const current = await this.assertUnchanged(id, baseUpdatedAt);
    await this.write({ id, deleted: true, updatedAt: nextStamp(current.updatedAt), updatedBy: this.deviceId });
  }

  /** Принимает записи с другого устройства, оставляя более новую версию. */
  async merge(incoming) {
    const known = new Map((await this.records()).map((record) => [record.id, record]));
    let changed = 0;
    for (const raw of incoming) {
      const record = normalizeRecord(raw);
      if (!record || !STAMP_RE.test(record.updatedAt)) continue;
      const mine = known.get(record.id);
      if (mine && revision(mine) >= revision(record)) continue;
      await this.write(record);
      known.set(record.id, record);
      changed += 1;
    }
    return changed;
  }
}

module.exports = { EventStore, StoreError, normalizeEvent, normalizeRecord, revision };
