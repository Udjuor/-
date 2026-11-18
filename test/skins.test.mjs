import test from 'node:test';
import assert from 'node:assert/strict';
import { SHAPES, SKINS, SKIN_MODES, activeSkin, garlandLayout, holidayGreeting } from '../src/renderer/skins.mjs';

test('скин по празднику включается сам, в том числе через Новый год', () => {
  assert.equal(activeSkin('auto', '2026-12-25').id, 'newyear');
  assert.equal(activeSkin('auto', '2027-01-05').id, 'newyear');
  assert.equal(activeSkin('auto', '2027-01-11'), null);
  assert.equal(activeSkin('auto', '2027-01-25').id, 'tatiana');
  assert.equal(activeSkin('auto', '2027-02-14').id, 'valentine');
  assert.equal(activeSkin('auto', '2027-02-23').id, 'defender');
  assert.equal(activeSkin('auto', '2027-03-08').id, 'womensday');
  assert.equal(activeSkin('auto', '2027-04-27').id, 'sakha');
  assert.equal(activeSkin('auto', '2027-05-09').id, 'victory');
  assert.equal(activeSkin('auto', '2027-06-12').id, 'russia');
  assert.equal(activeSkin('auto', '2027-06-21').id, 'ysyakh');
  assert.equal(activeSkin('auto', '2026-11-18'), null, 'в обычный день без украшений');
});

test('выбранный вручную скин и выключенное оформление', () => {
  assert.equal(activeSkin('victory', '2026-11-18').id, 'victory');
  assert.equal(activeSkin('off', '2026-12-31'), null);
  assert.equal(activeSkin('нет-такого', '2026-12-31'), null);
  assert.deepEqual(SKIN_MODES.slice(0, 2), ['off', 'auto']);
});

test('поздравление в бегущей строке только в сам праздник и не при выключенном оформлении', () => {
  assert.match(holidayGreeting('auto', '2027-01-01').text, /С Новым годом/);
  assert.equal(holidayGreeting('auto', '2026-12-25'), null, 'гирлянда уже висит, а поздравлять рано');
  assert.match(holidayGreeting('newyear', '2027-05-09').text, /Победы/, 'поздравление уместно при любом выбранном скине');
  assert.equal(holidayGreeting('off', '2027-05-09'), null);
});

test('у каждого скина есть фигура, цвета, даты и поздравление', () => {
  for (const skin of SKINS) {
    assert.ok(SHAPES[skin.shape], skin.id);
    assert.ok(skin.colors.length >= 2, skin.id);
    assert.match(skin.from, /^\d{2}-\d{2}$/);
    assert.ok(skin.greet.length && skin.greeting, skin.id);
  }
  const { points, path } = garlandLayout(1280);
  assert.equal(points.length, 20);
  assert.match(path, /^M0 2 Q/);
});
