/* Панель мен телефондар арасындағы байланыс. Екі жол бар:

   1) ЖЕРГІЛІКТІ СЕРВЕР (server.py, start.bat арқылы) — ойын компьютерден ашылса.
      Интернет керек емес, телефондар сол Wi-Fi желісінде болса болды.
      Хабар жіберу: POST /relay/send, тыңдау: /relay/events (Server-Sent Events).

   2) ИНТЕРНЕТ (Netlify сияқты хостингте) — өз сервері жоқ, сондықтан тегін ашық
      MQTT-серверлер қолданылады. Панель БАРЛЫҒЫНА бірден қосылады; телефон қайсысына
      қосыла алса, сол арқылы сөйлеседі. Бірінші тұрған shiftr.io — 443-порт.

   Қайсысы екенін ойын өзі анықтайды: алдымен /relay/ping сұрайды. */
(function () {
  const BROKERS = [
    { name: 'shiftr.io', url: 'wss://public.cloud.shiftr.io:443', user: 'public', pass: 'public' },
    { name: 'emqx.io', url: 'wss://broker.emqx.io:8084/mqtt' },
    { name: 'mosquitto', url: 'wss://test.mosquitto.org:8081/mqtt' },
    { name: 'hivemq', url: 'wss://broker.hivemq.com:8884/mqtt' }
  ];
  const ROOT = 'qrkvest3d/v2/';
  const parse = t => { try { return JSON.parse(t); } catch (e) { return null; } };

  /* ---------- жергілікті сервер бар ма? ---------- */
  let localInfo;
  function detectLocal() {
    if (localInfo !== undefined) return Promise.resolve(localInfo);
    if (location.protocol === 'file:') return Promise.resolve(localInfo = null);
    const ctl = window.AbortController ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), 2500);
    return fetch('/relay/ping', { cache: 'no-store', signal: ctl && ctl.signal })
      .then(r => r.ok ? r.json() : null)
      .then(j => (localInfo = j && j.relay ? j : null))
      .catch(() => (localInfo = null))
      .finally(() => clearTimeout(t));
  }

  /* жергілікті: бір «жәшікті» тыңдау + жіберу */
  function localListen(box, onMsg, onState) {
    const es = new EventSource('/relay/events?box=' + encodeURIComponent(box));
    es.onopen = () => onState(true);
    es.onerror = () => onState(false);          // EventSource өзі қайта қосылады
    es.onmessage = e => { const m = parse(e.data); if (m) onMsg(m); };
    return es;
  }
  function localSend(box, msg) {
    return fetch('/relay/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ box, msg }), keepalive: true
    }).catch(() => {});
  }

  /* интернет: MQTT */
  function mqttConnect(b, onState) {
    const opt = { clientId: 'qk_' + Math.random().toString(16).slice(2, 12), clean: true, keepalive: 20, connectTimeout: 7000, reconnectPeriod: 2500 };
    if (b.user) { opt.username = b.user; opt.password = b.pass; }
    const c = mqtt.connect(b.url, opt);
    c.on('connect', () => onState(true));
    c.on('close', () => onState(false));
    c.on('offline', () => onState(false));
    c.on('error', () => {});
    return c;
  }

  /* ====================== ПАНЕЛЬ ======================
     opts {room, onMsg(m), onStatus(list), onReady(info)}
     info: {local: true, host, port} немесе {local: false} */
  function openPanel(opts) {
    const base = ROOT + opts.room + '/';
    let impl = null;
    const api = { send(pid, m) { impl && impl.send(pid, m); }, info: null };

    detectLocal().then(loc => {
      if (loc) {
        const st = [{ name: 'компьютердегі сервер (' + loc.host + ')', on: false }];
        localListen(base + 'up', m => { if (m && m.pid) opts.onMsg(m); }, on => { st[0].on = on; opts.onStatus && opts.onStatus(st); });
        impl = { send: (pid, m) => localSend(base + 'dn/' + pid, m) };
        api.info = { local: true, host: loc.host, port: loc.port };
        opts.onStatus && opts.onStatus(st);
      } else {
        const route = {};                        // pid → қай сервер арқылы келді
        const st = BROKERS.map(b => ({ name: b.name, on: false }));
        const report = () => opts.onStatus && opts.onStatus(st);
        const clients = BROKERS.map((b, i) => {
          const c = mqttConnect(b, on => { st[i].on = on; if (on) c.subscribe(base + 'up'); report(); });
          c.on('message', (t, buf) => { const m = parse(buf.toString()); if (!m || !m.pid) return; route[m.pid] = i; opts.onMsg(m); });
          return c;
        });
        impl = { send(pid, m) { const c = clients[route[pid]]; if (c && c.connected) c.publish(base + 'dn/' + pid, JSON.stringify(m)); } };
        api.info = { local: false };
        report();
      }
      opts.onReady && opts.onReady(api.info);
    });
    return api;
  }

  /* ====================== ТЕЛЕФОН ======================
     opts {room, pid, onMsg(m), onStatus('on'|'off'|'try', name)} */
  function openPad(opts) {
    const base = ROOT + opts.room + '/';
    let online = false, name = '', send = () => {}, next = () => {};
    const api = {
      send(m) { send(Object.assign({ pid: opts.pid }, m)); },
      get online() { return online; },
      get name() { return name; },
      next() { next(); }
    };
    const status = (s, n) => opts.onStatus && opts.onStatus(s, n);

    detectLocal().then(loc => {
      if (loc) {
        name = 'компьютердегі сервер';
        status('try', name);
        localListen(base + 'dn/' + opts.pid, opts.onMsg, on => { online = on; status(on ? 'on' : 'off', name); });
        send = m => localSend(base + 'up', m);
        return;
      }
      /* интернет: серверлерді кезекпен байқаймыз */
      let cur = null, idx = -1, alive = false;
      send = m => { if (cur && cur.connected) cur.publish(base + 'up', JSON.stringify(m)); };
      next = function tryNext() {
        if (cur) { try { cur.end(true); } catch (e) {} }
        idx = (idx + 1) % BROKERS.length; alive = false; online = false;
        const b = BROKERS[idx], myIdx = idx; name = b.name;
        status('try', b.name);
        const c = mqttConnect(b, on => {
          if (cur !== c) return;
          online = on;
          if (on) { alive = true; c.subscribe(base + 'dn/' + opts.pid); status('on', b.name); }
          else status('off', b.name);
        });
        c.on('message', (t, buf) => { const m = parse(buf.toString()); if (m) opts.onMsg(m); });
        cur = c;
        setTimeout(() => { if (cur === c && !alive && myIdx === idx) tryNext(); }, 8000);
      };
      next();
    });
    return api;
  }

  window.NET = { openPanel, openPad, BROKERS, detectLocal };
})();
