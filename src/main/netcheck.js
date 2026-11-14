'use strict';
// Проверка и починка брандмауэра Windows для обмена между устройствами.
// Проверка идёт без прав администратора, починка спрашивает пароль администратора (UAC).
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const RULE = 'Kerdiis';
const PORT_RULE = 'Kerdiis sync';
const UDP_RULE = 'Kerdiis discovery';

function powershell(script, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve(String(stdout));
    });
  });
}

const CHECK = `
$ErrorActionPreference = 'SilentlyContinue'
$r = [ordered]@{}
$r.profiles = @(Get-NetConnectionProfile | ForEach-Object { [ordered]@{ name = [string]$_.Name; alias = [string]$_.InterfaceAlias; category = [string]$_.NetworkCategory } })
$r.firewall = @(Get-NetFirewallProfile | ForEach-Object { [ordered]@{ name = [string]$_.Name; enabled = [string]$_.Enabled; inbound = [string]$_.DefaultInboundAction; allowLocal = [string]$_.AllowLocalFirewallRules } })
$r.rules = @(Get-NetFirewallRule -DisplayName '${RULE}', '${PORT_RULE}', '${UDP_RULE}' | ForEach-Object {
  $app = $_ | Get-NetFirewallApplicationFilter
  $port = $_ | Get-NetFirewallPortFilter
  [ordered]@{ name = [string]$_.DisplayName; enabled = [string]$_.Enabled; action = [string]$_.Action; profile = [string]$_.Profile; program = [string]$app.Program; ports = [string]$port.LocalPort }
})
$r | ConvertTo-Json -Depth 4 -Compress
`;

/**
 * Состояние брандмауэра: есть ли наши правила, на ту ли программу, и какие профили у сетей.
 * Не на Windows возвращает null.
 */
async function firewallState(exePath) {
  if (process.platform !== 'win32') return null;
  try {
    const raw = JSON.parse((await powershell(CHECK)).trim() || '{}');
    const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);
    const rules = list(raw.rules);
    const program = rules.find((r) => r.name === RULE);
    const allowing = (r) => r.enabled === 'True' && r.action === 'Allow';
    return {
      profiles: list(raw.profiles),
      firewall: list(raw.firewall),
      programRule: program ? (allowing(program) ? (program.program.toLowerCase() === exePath.toLowerCase() ? 'ok' : 'wrong-path') : 'disabled') : 'missing',
      portRule: rules.some((r) => r.name === PORT_RULE && allowing(r)),
      udpRule: rules.some((r) => r.name === UDP_RULE && allowing(r)),
      // Политика колледжа может запрещать свои правила: тогда поможет только администратор сети.
      localRulesBlocked: list(raw.firewall).some((f) => f.allowLocal === 'False'),
    };
  } catch (err) {
    return { error: err.message.slice(0, 200) };
  }
}

/** Скрипт починки: правило на программу и на порты, для всех профилей сети. */
const repairScript = (exePath) => [
  `netsh advfirewall firewall delete rule name="${RULE}"`,
  `netsh advfirewall firewall add rule name="${RULE}" dir=in action=allow program="${exePath}" enable=yes profile=any`,
  `netsh advfirewall firewall delete rule name="${PORT_RULE}"`,
  `netsh advfirewall firewall add rule name="${PORT_RULE}" dir=in action=allow protocol=TCP localport=47800,47880 enable=yes profile=any`,
  `netsh advfirewall firewall delete rule name="${UDP_RULE}"`,
  `netsh advfirewall firewall add rule name="${UDP_RULE}" dir=in action=allow protocol=UDP localport=47801 enable=yes profile=any`,
].join('\r\n');

/** Чинит правила с правами администратора: Windows спросит разрешение или пароль. */
async function repairFirewall(exePath) {
  if (process.platform !== 'win32') throw Object.assign(new Error('not windows'), { code: 'not-windows' });
  const file = path.join(os.tmpdir(), `kerdiis-firewall-${process.pid}.cmd`);
  await fs.writeFile(file, `@echo off\r\n${repairScript(exePath)}\r\n`, 'utf8');
  try {
    await powershell(`$p = Start-Process -FilePath '${file.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`, 120_000);
  } catch (err) {
    // Отказ в окне UAC: «Операция отменена пользователем».
    if (/cancel|отмен/i.test(err.stderr ?? err.message)) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    throw Object.assign(new Error((err.stderr || err.message).slice(0, 200)), { code: 'failed' });
  } finally {
    await fs.rm(file, { force: true });
  }
  return firewallState(exePath);
}

module.exports = { firewallState, repairFirewall, repairScript };
