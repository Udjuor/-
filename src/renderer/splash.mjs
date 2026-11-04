// Панель-визитка при запуске. Окном и временем показа управляет главный процесс.
import { t, translatePage } from './i18n.mjs';
import { petSprite } from './pet.mjs';

translatePage();
document.getElementById('splash-logo').append(petSprite('play'));
document.body.addEventListener('click', () => window.calendar.skipSplash(), { once: true });

const { version } = await window.calendar.getSettings();
document.getElementById('splash-version').textContent = t('Версия {0}', [version]);
