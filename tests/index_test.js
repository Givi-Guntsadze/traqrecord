const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const VALID_TOKEN = 'a'.repeat(64);
const TEST_API_URL = 'https://script.google.com/macros/s/test-deployment/exec';

function createElement(tagName, innerHTMLWrites, elements) {
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    className: '',
    textContent: '',
    disabled: false,
    hidden: false,
    attributes: {},
    classList: {
      add(...classNames) {
        const classes = new Set(element.className.split(/\s+/).filter(Boolean));
        classNames.forEach(className => classes.add(className));
        element.className = [...classes].join(' ');
      },
      remove(...classNames) {
        element.className = element.className
          .split(/\s+/)
          .filter(value => value && !classNames.includes(value))
          .join(' ');
      },
      contains(className) {
        return element.className.split(/\s+/).filter(Boolean).includes(className);
      }
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    addEventListener(eventName, handler) {
      element.listeners = element.listeners || {};
      element.listeners[eventName] = element.listeners[eventName] || [];
      element.listeners[eventName].push(handler);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    prepend(child) {
      this.children.unshift(child);
    },
    remove() {},
    querySelector(selector) {
      if (!selector.startsWith('.')) return null;
      const className = selector.slice(1);
      const pending = [...this.children];
      while (pending.length > 0) {
        const child = pending.shift();
        if (child.className.split(/\s+/).includes(className)) return child;
        pending.push(...child.children);
      }
      return null;
    }
  };

  let innerHTML = '';
  Object.defineProperty(element, 'innerHTML', {
    get() {
      return innerHTML;
    },
    set(value) {
      innerHTML = value;
      innerHTMLWrites.push({ element, value });
    }
  });

  let idValue = '';
  Object.defineProperty(element, 'id', {
    get() {
      return idValue;
    },
    set(value) {
      idValue = value;
      if (elements && value) {
        elements.set(value, element);
      }
    }
  });

  return element;
}

function createHarness({
  search = '?uni=constructor',
  hash = `#token=${VALID_TOKEN}`,
  initialQueue,
  storage = new Map(),
  online = false,
  apiUrl = TEST_API_URL,
  fetchResponses = []
} = {}) {
  const innerHTMLWrites = [];
  const elements = new Map();
  const fetchCalls = [];
  const consoleMessages = [];
  const responseQueue = [...fetchResponses];
  let scannerStarts = 0;
  let uuidCounter = 0;

  const STORAGE_KEY = ['traqrecord_scan_queue', apiUrl, new URLSearchParams(search).get('uni')].join(':');
  if (initialQueue !== undefined) {
    storage.set(STORAGE_KEY, JSON.stringify(initialQueue));
  }

  const document = {
    body: createElement('body', innerHTMLWrites, elements),
    createElement: tagName => createElement(tagName, innerHTMLWrites, elements),
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, createElement('div', innerHTMLWrites, elements));
      }
      return elements.get(id);
    }
  };

  function Html5Qrcode() {}
  Html5Qrcode.prototype.start = function start() {
    scannerStarts += 1;
    return Promise.resolve();
  };

  // Each queued response corresponds to one *scan* (in request order), not
  // one HTTP request, since a request can now carry a batch. A response is
  // wrapped into the { client_id, ... } shape automatically using the
  // client_id the code under test actually sent, so most tests can keep
  // supplying the same plain { result, code } shapes as before batching.
  async function fetch(url, options) {
    fetchCalls.push({ url, options });
    const body = JSON.parse(options.body);
    const scans = Array.isArray(body.scans) ? body.scans : [];

    const results = [];
    for (const scan of scans) {
      const queued = responseQueue.shift() ?? { result: 'success', duplicate: false };

      if (queued instanceof Error) {
        throw queued;
      }

      if (queued.hangUntilAbort) {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted.');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        });
      }

      if (queued.ok === false) {
        return { ok: false, async json() { return null; } };
      }

      if (queued.omit) {
        // Simulates a malformed/buggy server response that is missing this
        // particular scan's result entirely, to verify the client never
        // treats "no result" as an implicit success or silently drops it.
        continue;
      }

      const payload = queued.body ?? queued;
      results.push(Object.assign({ client_id: scan.client_id }, payload));
    }

    return {
      ok: true,
      async json() {
        return { results };
      }
    };
  }

  const timers = new Map();
  let nextTimerId = 1;

  const context = {
    console: {
      error(...values) { consoleMessages.push(['error', ...values.map(String)]); },
      log(...values) { consoleMessages.push(['log', ...values.map(String)]); },
      warn(...values) { consoleMessages.push(['warn', ...values.map(String)]); }
    },
    AbortController,
    Date,
    document,
    fetch,
    Html5Qrcode,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    },
    navigator: { onLine: online },
    setInterval: () => 0,
    setTimeout: (callback, delay) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: id => {
      timers.delete(id);
    },
    URL,
    URLSearchParams,
    window: {
      listeners: {},
      addEventListener(eventName, handler) {
        (this.listeners[eventName] = this.listeners[eventName] || []).push(handler);
      },
      crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}` },
      location: { search, hash }
    }
  };

  const html = fs.readFileSync('index.html', 'utf8');
  const scriptStart = html.lastIndexOf('<script>');
  const sourceStart = html.indexOf('>', scriptStart) + 1;
  const sourceEnd = html.indexOf('</script>', sourceStart);
  let source = html.slice(sourceStart, sourceEnd);

  if (apiUrl !== undefined) {
    source = source.replace(
      /const API_URL\s*=\s*[^;]+;/,
      `const API_URL = ${JSON.stringify(apiUrl)};`
    );
  }

  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'index.html' });

  return {
    context,
    consoleMessages,
    elements,
    fetchCalls,
    innerHTMLWrites,
    queue: () => JSON.parse(storage.get(STORAGE_KEY) ?? '[]'),
    scannerStarts: () => scannerStarts,
    storage,
    triggerAllTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    goOnline() {
      // Mirrors the real browser 'online' event index.html listens for,
      // which is what actually flips the module-local isOnline variable
      // (a plain vm context property assignment does not reach it).
      context.navigator.onLine = true;
      for (const handler of context.window.listeners.online || []) handler();
    },
    async flushPromises() {
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}


test('requires a credential and a configured event receiver before opening the camera', () => {
  assert.throws(() => createHarness({ hash: '' }), /Invalid participant link/);
  assert.throws(() => createHarness({ apiUrl: null }), /Invalid participant link/);
});

test('loads the pinned same-origin QR decoder', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /<script src="vendor\/html5-qrcode\.min\.js"><\/script>/);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//i);
  const digest = crypto.createHash('sha256')
    .update(fs.readFileSync('vendor/html5-qrcode.min.js')).digest('hex');
  assert.equal(digest, '660b12437b1d747e3e68b8be0685c08cb728140110ad213f167b14b66f8b1d8e');
});

test('queues offline without persisting the credential and retries on reconnection', async () => {
  const scan = createHarness({ fetchResponses: [{ result: 'error', code: 'server_busy' }] });
  assert.equal(scan.scannerStarts(), 1);
  scan.context.onScanSuccess('00001234');
  assert.equal(scan.fetchCalls.length, 0);
  assert.equal(scan.queue()[0].uuid, '00001234');
  assert.ok(!JSON.stringify(scan.queue()).includes(VALID_TOKEN));
  assert.equal(createHarness({ search: '?uni=OTHER', storage: scan.storage }).queue().length, 0);
  assert.equal(createHarness({
    apiUrl: 'https://script.google.com/macros/s/another-event/exec',
    storage: scan.storage
  }).queue().length, 0);

  const reloaded = createHarness({ storage: scan.storage, fetchResponses: [{ result: 'error', code: 'server_busy' }] });
  reloaded.goOnline();
  await reloaded.flushPromises();
  assert.equal(reloaded.queue()[0].status, 'pending');
  await reloaded.context.sync();
  assert.equal(reloaded.queue()[0].status, 'synced');
  const [request] = reloaded.fetchCalls;
  assert.equal(request.url, TEST_API_URL);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'text/plain;charset=UTF-8');
  assert.equal(JSON.parse(request.options.body).scans[0].token, VALID_TOKEN);
});

test('shows a rejected ticket and reserves synced state for server acknowledgments', async () => {
  const scan = createHarness({
    fetchResponses: [{ result: 'error', code: 'invalid_ticket' }, { omit: true }]
  });
  scan.context.onScanSuccess('BADTICK1');
  scan.context.onScanSuccess('ABCD0002');
  scan.goOnline();
  await scan.flushPromises();
  assert.deepEqual(scan.queue().map(item => item.status), ['rejected', 'pending']);
});

test('sends more than ten offline scans as consecutive bounded batches', async () => {
  const scan = createHarness();
  for (let number = 0; number < 12; number++) {
    scan.context.onScanSuccess('TICK' + String(number).padStart(4, '0'));
  }
  scan.goOnline();
  await scan.flushPromises();
  assert.deepEqual(scan.fetchCalls.map(request => JSON.parse(request.options.body).scans.length), [10, 2]);
  assert.equal(scan.queue().filter(item => item.status === 'synced').length, 12);
});
