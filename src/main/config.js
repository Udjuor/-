'use strict';
// Настройки хранятся в обычном config.ini, чтобы администратор мог
// подготовить его заранее или поправить в блокноте.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseIni(text) {
  const values = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

const splitPeers = (text) => String(text || '').split(/[\s,;]+/).filter(Boolean);

function saveConfig(homeDir, config) {
  fs.mkdirSync(homeDir, { recursive: true });
  const lines = [
    '[calendar]',
    `dataDir=${config.dataDir}`,
    `fullscreen=${config.fullscreen ? 1 : 0}`,
    `deviceId=${config.deviceId}`,
    `deviceName=${config.deviceName}`,
    `syncKey=${config.syncKey}`,
    `peers=${config.peers.join(',')}`,
    `showAll=${config.showAll ? 1 : 0}`,
    `theme=${config.theme}`,
    `uiSize=${config.uiSize}`,
  ];
  fs.writeFileSync(path.join(homeDir, 'config.ini'), `${lines.join('\r\n')}\r\n`, 'utf8');
}

function loadConfig(homeDir) {
  const file = path.join(homeDir, 'config.ini');
  let values = {};
  try {
    values = parseIni(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('config.ini не прочитан:', err.message);
  }
  const config = {
    dataDir: values.dataDir || path.join(homeDir, 'data'),
    fullscreen: values.fullscreen === undefined ? true : values.fullscreen === '1',
    deviceId: values.deviceId || crypto.randomUUID(),
    deviceName: values.deviceName || os.hostname(),
    syncKey: values.syncKey || '',
    peers: splitPeers(values.peers),
    showAll: values.showAll === '1',
    theme: ['dark', 'light', 'system'].includes(values.theme) ? values.theme : 'dark',
    uiSize: ['small', 'medium', 'large'].includes(values.uiSize) ? values.uiSize : 'medium',
  };
  if (!values.deviceId) {
    try {
      saveConfig(homeDir, config);
    } catch (err) {
      console.error('Номер устройства не сохранён:', err.message);
    }
  }
  return config;
}

module.exports = { loadConfig, saveConfig, parseIni, splitPeers };
