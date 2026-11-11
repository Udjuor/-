'use strict';
// Страница студента. Ключ телефона хранится только в этом браузере.
(() => {
  const KEY = 'kerdiis-phone-key';
  const app = document.getElementById('app');
  const hello = document.getElementById('hello');

  const store = {
    get() {
      try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
    },
    set(value) {
      try { if (value) localStorage.setItem(KEY, value); else localStorage.removeItem(KEY); } catch { /* приватный режим */ }
    },
  };

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value === false || value == null) continue;
      if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
      else el.setAttribute(name, value === true ? '' : value);
    }
    el.append(...children.flat(Infinity).filter((c) => c != null && c !== false && c !== ''));
    return el;
  }

  const dateText = (iso, options = { day: 'numeric', month: 'long' }) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('ru-RU', options);
  };
  const deadlineText = (moment) => `${dateText(moment.slice(0, 10))}, ${moment.slice(11, 16)}`;

  async function post(path, body, token) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  }

  const BIND_ERRORS = {
    'bad-code': 'Код не подошёл. Проверьте цифры или попросите у куратора новый код.',
    'bad-nick': 'Ник: от 3 до 20 букв или цифр, можно также _ . и -.',
    'nick-taken': 'Этот ник уже занят. Придумайте другой.',
    'too-many': 'Слишком много попыток. Подождите 10 минут.',
  };

  function showBind(note = '') {
    hello.textContent = '';
    const error = h('p', { class: 'error', role: 'alert' });
    const code = h('input', { id: 'code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 9, required: true, placeholder: '1234 5678' });
    const nick = h('input', { id: 'nick', name: 'nick', autocomplete: 'nickname', maxlength: 20, placeholder: 'Например, Nyurgun' });
    const button = h('button', { type: 'submit', class: 'primary' }, 'Привязать телефон');
    const form = h('form', {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        button.disabled = true;
        try {
          const { status, data } = await post('/api/bind', { code: code.value, nick: nick.value.trim() });
          if (status === 200 && data.token) {
            store.set(data.token);
            await showMine();
            return;
          }
          error.textContent = BIND_ERRORS[data.error] ?? 'Не получилось. Попробуйте ещё раз.';
        } catch {
          error.textContent = 'Нет связи с Kerdiis. Подключитесь к Wi-Fi колледжа.';
        } finally {
          button.disabled = false;
        }
      },
    },
    h('h1', {}, 'Привяжите телефон'),
    note && h('p', { class: 'note' }, note),
    h('p', { class: 'muted' }, 'Код выдаёт куратор. Ник придумайте сами: его подтвердит куратор. На телефоне и в сети не будет вашего имени, только ник.'),
    h('label', { for: 'code' }, 'Код от куратора'), code,
    h('label', { for: 'nick' }, 'Ник'), nick,
    h('p', { class: 'muted small' }, 'Если куратор уже дал вам ник, это поле можно не заполнять.'),
    error,
    button);
    app.replaceChildren(form);
    code.focus();
  }

  const STATUS_CLASS = { present: 'ok', late: 'warn', absent: 'bad', sick: 'info', order: 'info', excused: 'info', pending: 'muted' };

  function lessonItem(item) {
    return h('li', { class: `item state-${item.state}` },
      h('div', { class: 'time' }, `${item.start}–${item.end}`),
      h('div', { class: 'what' },
        h('strong', {}, item.title),
        h('span', { class: 'muted small' }, [item.typeName, item.place, item.offsite && 'вне колледжа'].filter(Boolean).join(', ')),
        item.state === 'now' && h('span', { class: 'chip now' }, 'идёт сейчас')),
      item.status && h('span', { class: `chip ${STATUS_CLASS[item.status.code] ?? 'muted'}` }, item.status.text));
  }

  function section(title, children, empty) {
    const list = children.filter(Boolean);
    return h('section', { class: 'card' }, h('h2', {}, title), list.length ? list : h('p', { class: 'muted' }, empty));
  }

  function render(data) {
    hello.textContent = `Привет, ${data.nick || 'студент'}!`;
    const month = data.month;
    app.replaceChildren(...[
      h('div', { class: 'here' },
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', {}, `Вы в колледже с ${data.here}`),
        !data.nickOk && data.nick && h('span', { class: 'muted small' }, 'Ник на проверке у куратора')),
      data.certificate && h('section', { class: 'card alert' },
        h('h2', {}, 'Принесите справку'),
        h('p', {}, `Болезнь отмечена с ${dateText(data.certificate.from)}, занятий: ${data.certificate.classes}. Пока справки нет, статус предварительный.`)),
      section(`Сегодня, ${dateText(data.date, { weekday: 'long', day: 'numeric', month: 'long' })}`,
        [h('ul', { class: 'list' }, data.today.map(lessonItem))].filter(() => data.today.length), 'Сегодня у вас ничего нет.'),
      section('Сроки сдачи', data.deadlines.length ? [h('ul', { class: 'list' }, data.deadlines.map((item) => h('li', { class: 'item' },
        h('div', { class: 'what' }, h('strong', {}, item.title), h('span', { class: 'muted small' }, item.typeName)),
        h('span', { class: `chip ${item.state === 'overdue' ? 'bad' : item.state === 'soon' ? 'warn' : 'muted'}` },
          item.state === 'overdue' ? `Срок прошёл ${deadlineText(item.deadline)}` : `До ${deadlineText(item.deadline)}`))))] : [], 'Сроков сдачи нет.'),
      section('Задания и мероприятия на две недели', data.upcoming.length ? [h('ul', { class: 'list' }, data.upcoming.map((item) => h('li', { class: 'item' },
        h('div', { class: 'time' }, dateText(item.date), h('br'), `${item.start}–${item.end}`),
        h('div', { class: 'what' }, h('strong', {}, item.title), h('span', { class: 'muted small' }, [item.typeName, item.place, item.responsible].filter(Boolean).join(', '))))))] : [], 'Ближайших заданий и мероприятий нет.'),
      portfolioCard(data.portfolio),
      h('section', { class: 'card' },
        h('h2', {}, 'Этот месяц'),
        h('div', { class: 'stats' },
          stat('Занятий с отметкой', month.lessons),
          stat('Опозданий', month.late, month.lateMinutes ? `${month.lateMinutes} мин` : ''),
          stat('Без причины', month.absent),
          stat('По уважительной', month.valid))),
      h('button', { type: 'button', class: 'plain', onclick: () => showMine() }, 'Обновить'),
    ].filter(Boolean));
  }

  /** Моё портфолио: достижения и где участвовал. */
  function portfolioCard(p) {
    if (!p) return null;
    const total = p.items.length + p.awards.length;
    return h('section', { class: 'card' },
      h('h2', {}, 'Моё портфолио'),
      total
        ? [
          h('p', { class: 'muted small' }, `Мероприятий: ${p.counts.event}, заданий: ${p.counts.task}, практик: ${p.counts.practice}, достижений: ${p.awards.length}`),
          p.awards.length > 0 && h('ul', { class: 'list' }, p.awards.map((item) => h('li', { class: 'item' },
            h('div', { class: 'time' }, dateText(item.date)),
            h('div', { class: 'what' }, h('strong', {}, item.title), item.result && h('span', { class: 'chip ok' }, item.result))))),
          h('details', {},
            h('summary', {}, `Участие: ${p.items.length}`),
            h('ul', { class: 'list' }, p.items.map((item) => h('li', { class: 'item' },
              h('div', { class: 'time' }, dateText(item.date)),
              h('div', { class: 'what' }, h('strong', {}, item.title), h('span', { class: 'muted small' }, item.typeName)))))),
        ]
        : h('p', { class: 'muted' }, 'Здесь появятся мероприятия, задания и практика, где вы участвовали, и ваши дипломы.'));
  }

  const stat = (label, value, extra = '') => h('div', { class: 'stat' }, h('b', {}, String(value)), h('span', {}, label), extra && h('span', { class: 'muted small' }, extra));

  async function showMine() {
    const token = store.get();
    if (!token) {
      showBind();
      return;
    }
    try {
      const { status, data } = await post('/api/open', {}, token);
      if (status === 401) {
        store.set('');
        showBind('Телефон отвязан. Попросите у куратора новый код.');
        return;
      }
      if (status !== 200) throw new Error(String(status));
      render(data);
    } catch {
      app.replaceChildren(h('section', { class: 'card' },
        h('h2', {}, 'Нет связи с Kerdiis'),
        h('p', {}, 'Страница работает только в Wi-Fi колледжа. Подключитесь к нему и нажмите «Обновить».'),
        h('button', { type: 'button', class: 'primary', onclick: () => showMine() }, 'Обновить')));
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store.get()) showMine();
  });
  showMine();
})();
