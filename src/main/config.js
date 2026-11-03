'use strict';
// Настройки хранятся в обычном config.ini, чтобы администратор мог
// подготовить его заранее или поправить в блокноте на панели.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = { fullscreen: true };

function parseIni(text) {
  const values = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

function loadConfig(homeDir) {
  const file = path.join(homeDir, 'config.ini');
  let values = {};
  try {
    values = parseIni(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('config.ini не прочитан:', err.message);
  }
  return {
    dataDir: values.dataDir || path.join(homeDir, 'data'),
    fullscreen: values.fullscreen === undefined ? DEFAULTS.fullscreen : values.fullscreen === '1',
  };
}

function saveConfig(homeDir, config) {
  fs.mkdirSync(homeDir, { recursive: true });
  const text = `[calendar]\r\ndataDir=${config.dataDir}\r\nfullscreen=${config.fullscreen ? 1 : 0}\r\n`;
  fs.writeFileSync(path.join(homeDir, 'config.ini'), text, 'utf8');
}

module.exports = { loadConfig, saveConfig, parseIni };
