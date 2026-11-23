'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Access, allowed, fullCode, grantCode, newSecret, parseCode, recordScope, scopeContext, secretPrint } = require('../src/main/access');

const UNIT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';
const SUB = '44444444-4444-4444-8444-444444444444';

test('коды доступа: полный и с пропусками, подделка и чужая сеть', () => {
  const secret = newSecret();
  const full = new Access(fullCode(secret));
  assert.equal(full.full, true);
  assert.equal(full.matches({ print: secretPrint(secret) }), true);
  assert.equal(full.matches({ print: secretPrint(newSecret()) }), false, 'полный код другой сети');
  const unit = new Access(grantCode(secret, [`unit:${UNIT}`, `group:${GROUP}`]));
  assert.equal(unit.full, false);
  assert.deepEqual(unit.claims().sort(), [`group:${GROUP}`, `unit:${UNIT}`]);
  assert.equal(parseCode('KRD1-мусор'), null);
  assert.equal(parseCode('abc'), null);
  assert.throws(() => grantCode(secret, ['all']));
  // Код с пропуском, ключ которого не от этой сети, проверку не пройдёт.
  const forged = new Access(grantCode(newSecret(), [`unit:${OTHER}`]));
  const proofs = forged.prove('nonce', 'dev-x');
  assert.equal(full.verify(proofs, 'nonce', 'dev-x').size, 0);
});

test('доказательства пропусков: свой вызов, своё устройство, полный доступ доказывает заявленное', () => {
  const secret = newSecret();
  const full = new Access(fullCode(secret));
  const it = new Access(grantCode(secret, [`unit:${UNIT}`]));
  const art = new Access(grantCode(secret, [`unit:${OTHER}`]));
  const fromIt = it.prove('c1', 'it');
  assert.deepEqual([...full.verify(fromIt, 'c1', 'it')], [`unit:${UNIT}`]);
  assert.equal(full.verify(fromIt, 'c2', 'it').size, 0, 'другой вызов');
  assert.equal(full.verify(fromIt, 'c1', 'art').size, 0, 'другое устройство');
  assert.equal(art.verify(fromIt, 'c1', 'it').size, 0, 'чужой ПЦК проверить не может');
  const fromFull = full.prove('c3', 'office', it.claims());
  assert.deepEqual([...it.verify(fromFull, 'c3', 'office')], [`unit:${UNIT}`], 'учебная часть доказывает пропуск ПЦК');
  assert.equal(it.verify({ all: fromFull.all }, 'c3', 'office').size, 0, 'полный доступ ПЦК не проверит');
});

test('чьи записи: ПЦК по преподавателю, общее, кураторы групп с подгруппами, аудитория, отметки за событием', () => {
  const records = [
    { id: GROUP, kind: 'group', name: 'ИС-21' },
    { id: SUB, kind: 'group', name: 'ИС-21-1' },
    { id: 'st', kind: 'student', name: 'Иванов', groupId: SUB },
    { id: 't1', kind: 'teacher', name: 'Петрова', unit: UNIT },
    { id: 'e1', title: 'Сети', responsible: 'Петрова', participants: ['иванов'], place: 'Ауд. 204' },
    { id: 'e2', title: 'Линейка', responsible: 'Петрова', unit: 'all', participants: [] },
    { id: 'e3', title: 'Без ПЦК', responsible: 'Новиков', participants: [] },
    { id: 'e4', title: 'Совет', responsible: 'Новиков', unit: OTHER, participants: [] },
  ];
  const ctx = scopeContext(records);
  const scope = (id) => recordScope(records.find((r) => r.id === id) ?? { id, kind: 'attendance', eventId: id.slice(2) }, ctx);
  assert.deepEqual([...scope('e1')].sort(), [`group:${GROUP}`, `group:${SUB}`, 'room:ауд. 204', `unit:${UNIT}`]);
  assert.equal(scope('e2'), null, 'общее для колледжа');
  assert.equal(scope('e3'), null, 'преподаватель без ПЦК — общее');
  assert.deepEqual([...scope('e4')], [`unit:${OTHER}`]);
  assert.deepEqual([...recordScope({ id: 'a1', kind: 'attendance', eventId: 'e4' }, ctx)], [`unit:${OTHER}`]);
  assert.deepEqual([...recordScope({ id: 'a2', kind: 'attendance', eventId: 'нет' }, ctx)], ['unknown'], 'событие ещё не пришло');
  assert.equal(recordScope({ id: 'x', deleted: true }, ctx), null);
  assert.equal(recordScope(records[0], ctx), null, 'справочники общие');
  assert.equal(allowed(scope('e1'), new Set([`group:${GROUP}`])), true, 'куратор группы');
  assert.equal(allowed(scope('e1'), new Set([`unit:${OTHER}`])), false);
  assert.equal(allowed(scope('e4'), new Set(['all'])), true);
  assert.equal(allowed(scope('e1'), new Set(['room:ауд. 204'])), true, 'панель аудитории');
});
