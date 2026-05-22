/* === Yoohome Shared Utilities === */
const Y = (() => {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, ctx) => (ctx || document).querySelectorAll(sel);
  const $1 = (sel, ctx) => (ctx || document).querySelector(sel);

  // === Toast ===
  let _toastEl, _toastTimer;
  function toast(msg, dur = 2000) {
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.className = 'yh-toast';
      document.body.appendChild(_toastEl);
    }
    _toastEl.textContent = msg;
    _toastEl.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => _toastEl.classList.remove('show'), dur);
  }

  // === Keyboard Shortcuts ===
  const shortcuts = {};
  function bindShortcut(key, handler, desc) {
    shortcuts[key.toLowerCase()] = { handler, desc };
  }
  document.addEventListener('keydown', (e) => {
    let chord = '';
    if (e.ctrlKey || e.metaKey) chord += 'ctrl+';
    if (e.altKey) chord += 'alt+';
    if (e.shiftKey) chord += 'shift+';
    chord += e.key.toLowerCase();
    const s = shortcuts[chord];
    if (s && !e.target.closest('input,textarea,[contenteditable="true"]')) {
      e.preventDefault(); s.handler(e);
    }
  });

  // === Escape helper ===
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // === Debounce ===
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // === API helpers ===
  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const data = await res.json();
    if (!res.ok && !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  const apiGet = (p) => api('GET', p);
  const apiPost = (p, b) => api('POST', p, b);
  const apiPatch = (p, b) => api('PATCH', p, b);
  const apiDelete = (p) => api('DELETE', p);

  // === Format bytes ===
  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  // === Format date ===
  function fmtDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return d.toLocaleDateString();
  }

  // === Detect dark mode ===
  function isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ||
           window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // === Copy to clipboard ===
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
      return true;
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      toast('Copied');
      return true;
    }
  }

  // === Diff generator (simple line-based) ===
  function diffLines(oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const result = [];
    // Simple LCS-based diff
    const m = oldLines.length, n = newLines.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = oldLines[i-1] === newLines[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);

    function backtrack(i, j) {
      if (i === 0 && j === 0) return;
      if (i > 0 && j > 0 && oldLines[i-1] === newLines[j-1]) {
        backtrack(i-1, j-1);
        result.push({ type: 'same', text: oldLines[i-1] });
      } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
        backtrack(i, j-1);
        result.push({ type: 'add', text: newLines[j-1] });
      } else {
        backtrack(i-1, j);
        result.push({ type: 'rem', text: oldLines[i-1] });
      }
    }
    backtrack(m, n);
    return result;
  }

  function renderDiff(oldText, newText) {
    const lines = diffLines(oldText, newText);
    let html = '<div class="yh-diff">';
    let adds = 0, rems = 0;
    for (const l of lines) {
      if (l.type === 'add') { html += `<div class="diff-add">+ ${esc(l.text)}</div>`; adds++; }
      else if (l.type === 'rem') { html += `<div class="diff-rem">- ${esc(l.text)}</div>`; rems++; }
      else html += `<div>  ${esc(l.text)}</div>`;
    }
    html += `</div><div style="font-size:10px;color:var(--yh-text3);margin-top:4px">${adds} additions, ${rems} deletions</div>`;
    return html;
  }

  return { $, $$, $1, toast, bindShortcut, esc, debounce, apiGet, apiPost, apiPatch, apiDelete, fmtBytes, fmtDate, isDark, copy, diffLines, renderDiff };
})();
