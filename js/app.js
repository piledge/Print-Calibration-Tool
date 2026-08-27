/**
 * app.js — wiring of the user interface and switching between the tests.
 *
 * What a test is lives in its own module (`pa/test.js`, `em/test.js`,
 * `tt/test.js`); this is only the frame: file loading, tabs, messages,
 * download, selection.
 */

import { readGcodeFile, downloadLines } from './reader.js';
import { parseDocument, describeDocument } from './settings.js';
import { paTest } from './pa/test.js';
import { emTest } from './em/test.js';
import { ttTest } from './tt/test.js';
import { listHistory, putHistory, touchHistory, getHistoryFile, clearHistory,
         HISTORY_MAX } from './history.js';

const STORAGE_KEY = 'pa_tool_settings';
const STORAGE_VERSION = 4;   // 4: three tests, inputs kept per test
const DEBOUNCE_MS = 120;
const FLASH_MS = 1200;

// Order of the tabs, and the order the tests are meant to be run in.
const TESTS = [ttTest, paTest, emTest];

const el = id => document.getElementById(id);

const ui = {
  dropzone: el('dropzone'), dropPrompt: el('drop-prompt'),
  fileInput: el('file-input'), fileName: el('file-name'),
  historyBox: el('history-box'), historyList: el('history-list'),
  historyClear: el('history-clear'),
  summary: el('summary'), settingsDetails: el('settings-details'), settingsBody: el('settings-body'),
  legend2: el('legend-2'),
  canvas: el('preview-canvas'), previewInfo: el('preview-info'),
  messages: el('messages'),
  step2: el('step-2'), step3: el('step-3'), step4: el('step-4'), step5: el('step-5'),
  downloadBtn: el('download-btn'), downloadName: el('download-name'),
  bestLabel: el('best-label'), bestValue: el('best-value'), bestInfo: el('best-info'),
  bestOut: el('best-out'), copyBtn: el('copy-btn'),
};

/** State of the frame. */
const state = {
  test: ttTest,
  doc: null,        // SourceDocument, built once per file
  plan: null,
  result: null,
  fileName: '',
};

/* ------------------------------------------------------------ Persistence */

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (!s || s.version !== STORAGE_VERSION) return;
    const chosen = TESTS.find(t => t.id === s.test);
    if (chosen) state.test = chosen;
    ui.settingsDetails.open = !!s.settingsOpen;
    for (const t of TESTS) {
      if (t.storage && s[t.id]) t.applyStored(s[t.id]);
    }
  } catch (e) { /* private mode and the like — the defaults stay */ }
}

function saveSettings() {
  try {
    const data = { version: STORAGE_VERSION, test: state.test.id,
                   settingsOpen: ui.settingsDetails.open };
    for (const t of TESTS) if (t.storage) data[t.id] = t.readInput();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) { /* not critical */ }
}

/* ----------------------------------------------------------------- Output */

/**
 * Shape of the list shown last. `#messages` is a live region: every inserted
 * node is read out, even with unchanged text — so rebuilding the list on every
 * keystroke in step 2 would read it out on every keystroke.
 */
let lastMessageKey = null;

function showMessages(issues) {
  const key = issues.map(i => i.level + '\u0000' + i.code + '\u0000' + i.text).join('\n');
  if (key === lastMessageKey) return;
  lastMessageKey = key;
  ui.messages.replaceChildren();
  // Marks come and go with the messages, which is why both live in one place.
  for (const n of document.querySelectorAll('.is-bad')) {
    n.classList.remove('is-bad');
    n.removeAttribute('aria-invalid');
  }
  if (!issues.length) {
    // The box stays visible and says that nothing is pending.
    const li = document.createElement('li');
    li.className = 'msg-none';
    li.textContent = 'no messages';
    ui.messages.appendChild(li);
    return;
  }
  const order = { error: 0, warning: 1 };
  const sorted = issues.slice().sort((a, b) => order[a.level] - order[b.level]);
  for (const i of sorted) {
    const li = document.createElement('li');
    li.className = i.level === 'error' ? 'msg-error' : 'msg-warn';
    li.textContent = '[' + i.code + '] ' + i.text;
    ui.messages.appendChild(li);
    // Errors only: a warning like "no anchor" refers to a deliberate, allowed
    // choice -- a red border on it would be wrong.
    if (i.level !== 'error') continue;
    for (const id of [].concat(i.field || [])) {
      const n = el(id);
      if (n) { n.classList.add('is-bad'); n.setAttribute('aria-invalid', 'true'); }
    }
  }
}

function showSettingsTable(doc) {
  ui.settingsBody.replaceChildren();
  for (const row of describeDocument(doc)) {
    const tr = document.createElement('tr');
    for (const key of ['name', 'value', 'source']) {
      const td = document.createElement('td');
      td.textContent = row[key];
      tr.appendChild(td);
    }
    ui.settingsBody.appendChild(tr);
  }
  const p = doc.printer, g = doc.geometry;
  ui.summary.textContent = [
    p.flavor || 'unknown firmware',
    p.preset || p.model || null,
    p.bed ? p.bed.x + '×' + p.bed.y + ' mm bed' : null,
    Number.isFinite(g.nozzle) ? g.nozzle + ' mm nozzle' : null,
    Number.isFinite(g.firstLayerHeight) ? g.firstLayerHeight + '/' + g.layerHeight + ' mm layers' : null,
    Number.isFinite(doc.material.temperature) ? doc.material.temperature + ' °C' : null,
    doc.material.filamentName || null,
  ].filter(Boolean).join(' · ');
}

/** File name on the download button; an empty name disables it. */
function setDownload(name) {
  ui.downloadName.textContent = name;
  ui.downloadName.title = name;
  ui.downloadBtn.disabled = !name;
}

/** Reset everything that would otherwise linger from a previous file. */
function resetOutputs() {
  state.plan = null;
  state.result = null;
  state.fileName = '';
  ui.previewInfo.textContent = '';
  setDownload('');
  clearSelection();
  state.test.clear(ui.canvas, state.doc);
}

/**
 * Steps 2 and 3 depend on the loaded file. Steps 4 and 5 depend on the result:
 * without an error-free plan there is nothing to download or select, so they
 * stay disabled here and are enabled only by rebuild().
 */
function setEnabled(on) {
  ui.step2.disabled = !on;
  ui.step3.disabled = !on;
  setResultEnabled(false);
}

/**
 * Steps 4 and 5, and with them the selection in the preview. Without a result
 * the canvas is not a control, so its `tabindex` has to go too: a disabled
 * `fieldset` only disables form elements, not a canvas.
 */
function setResultEnabled(on) {
  ui.step4.disabled = !on;
  ui.step5.disabled = !on;
  if (on) ui.canvas.setAttribute('tabindex', '0');
  else ui.canvas.removeAttribute('tabindex');
}

/* ------------------------------------------------------------- Evaluation */

/** Nothing selected: placeholder in the list, empty box. */
function clearSelection() {
  ui.bestValue.selectedIndex = 0;
  ui.bestInfo.textContent = '';
  ui.bestOut.textContent = '';
  ui.copyBtn.disabled = true;
}

/**
 * Fills the selection list. An option's value is the running index, its label
 * the measured value -- that way pick(), advice() and resultCount() stay
 * unchanged. An existing selection is found again by its label: when the range
 * changes, the index differs but the value may still be there.
 */
function fillChoices(plan, n) {
  const keep = ui.bestValue.selectedIndex > 0
    ? ui.bestValue.options[ui.bestValue.selectedIndex].textContent : null;
  const opts = [new Option('—', '')];
  for (let i = 0; i < n; i++) opts.push(new Option(state.test.choiceLabel(plan, i), String(i)));
  ui.bestValue.replaceChildren(...opts);
  if (keep) {
    const found = [...ui.bestValue.options].findIndex(o => o.textContent === keep);
    ui.bestValue.selectedIndex = found > 0 ? found : 0;
  }
}

/** The selected index, 0-based; -1 means "nothing selected yet". */
function currentIndex(n) {
  const v = ui.bestValue.value;
  return v === '' ? -1 : Math.min(n - 1, parseInt(v, 10));
}

/**
 * Turns the selection into the value and the lines to enter. Runs with every
 * rebuild so the selection stays in range when the series of values changes.
 */
function renderResult() {
  const plan = state.plan;
  const n = plan ? state.test.resultCount(plan) : 0;
  if (!n) { clearSelection(); return; }
  fillChoices(plan, n);

  const i = currentIndex(n);
  // The preview only highlights what the user has actually selected.
  if (state.test.selectionInPreview) plan.selected = i;
  if (i < 0) {
    ui.bestInfo.textContent = 'of ' + n;
    ui.bestOut.textContent = '';
    ui.copyBtn.disabled = true;
    return;
  }
  const a = state.test.advice(state.doc, plan, i);
  ui.bestInfo.textContent = a.info;
  ui.bestOut.textContent = a.text || 'No advice for this firmware.';
  ui.copyBtn.disabled = false;
}

/**
 * Redraw the preview only — after a resize or a new selection. Same case
 * distinction as in rebuild(): with a plan the test draws it, even without
 * finished gcode.
 */
function redraw() {
  if (state.plan) state.test.render(ui.canvas, state.doc, state.plan, state.result);
  else state.test.clear(ui.canvas, state.doc);
}

/** After a new selection: only redraw if it is visible in the preview. */
function selectionChanged() {
  renderResult();
  if (state.test.selectionInPreview) redraw();
}

/* ---------------------------------------------------------------- Rebuild */

/** Build the plan, generate the gcode, draw the preview. Never throws. */
function rebuild() {
  if (!state.doc) return;
  const test = state.test;
  let plan = null, result = null;
  const extra = [];

  try {
    plan = test.build(state.doc, test.readInput());
  } catch (e) {
    extra.push({ level: 'error', code: 'E0', text: 'Could not build the test: ' + e.message });
  }

  if (plan && plan.renderable) {
    try {
      result = test.generate(state.doc, plan);
    } catch (e) {
      extra.push({ level: 'error', code: 'E0', text: 'Could not generate gcode: ' + e.message });
    }
  }

  state.plan = plan;
  state.result = result;
  showMessages((plan ? plan.issues : state.doc.issues).concat(extra));
  renderResult();

  // Drawing happens even on error -- downloading and selecting do not.
  setResultEnabled(!!plan && !plan.hasError);

  if (!plan) {
    test.clear(ui.canvas, state.doc);
    ui.previewInfo.textContent = test.emptyInfo;
    setDownload('');
    return;
  }
  // Without gcode the test still draws what it knows from the plan.
  ui.previewInfo.textContent = test.render(ui.canvas, state.doc, plan, result);
  if (!result) { setDownload(''); return; }
  state.fileName = test.fileName(state.doc, plan);
  setDownload(plan.hasError ? '' : state.fileName);
}

let debounceTimer = null;
function scheduleRebuild(immediate) {
  clearTimeout(debounceTimer);
  if (immediate) { saveSettings(); rebuild(); return; }
  debounceTimer = setTimeout(() => { saveSettings(); rebuild(); }, DEBOUNCE_MS);
}

/* ------------------------------------------------------------------- Tabs */

function selectTest(test) {
  state.test = test;
  for (const t of TESTS) {
    const on = t === test;
    const btn = el('tab-' + t.id);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    // Roving tabindex: the group is one tab stop, arrow keys move inside it.
    btn.tabIndex = on ? 0 : -1;
    for (const id of t.panels) el(id).hidden = !on;
  }
  ui.legend2.textContent = test.legend2;
  ui.bestLabel.textContent = test.bestLabel;
  saveSettings();
  resetOutputs();
  if (state.doc) rebuild();
}

/* --------------------------------------------------------- Loading a file */

/** @param {object} [fromHistory]  the history record it came from, if any */
async function loadFile(file, fromHistory) {
  // Dropping the same broken file twice produces the same list, and the
  // lastMessageKey lock would swallow the message although it is new.
  lastMessageKey = null;
  ui.fileName.textContent = 'Reading ' + file.name + ' …';
  setEnabled(false);
  try {
    const read = await readGcodeFile(file);
    const doc = parseDocument(read.text);
    state.doc = doc;
    ui.fileName.textContent = read.fileName + (read.wasBinary ? '  (binary gcode, decoded)' : '');
    showSettingsTable(doc);
    // Open on a hard error, but never close: what the user left open stays
    // open -- that state is persisted.
    if (doc.issues.some(i => i.level === 'error')) ui.settingsDetails.open = true;
    setEnabled(true);
    clearSelection();
    rebuild();
    // Only with a document in hand: an unreadable file does not belong in the
    // history.
    if (fromHistory) await touchHistory(fromHistory, Date.now());
    else await putHistory(file, ui.summary.textContent, Date.now());
    await showHistory();
  } catch (e) {
    state.doc = null;
    ui.fileName.textContent = file.name;
    ui.summary.textContent = '';
    ui.settingsBody.replaceChildren();
    showMessages([{ level: 'error', code: e.code || 'E0', text: e.message }]);
    resetOutputs();
    setEnabled(false);
  }
}

/* ------------------------------------------------------------- File history */

function formatSize(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB'
       : bytes >= 1024 ? Math.round(bytes / 1024) + ' kB'
       : bytes + ' B';
}

/**
 * Draw the list into the dropzone. An empty history leaves the box as it was
 * before there was one; only the rows make it grow.
 */
async function showHistory() {
  const entries = await listHistory();
  ui.historyList.replaceChildren();
  for (const m of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item';
    btn.title = [m.name, m.summary, new Date(m.added).toLocaleString()]
      .filter(Boolean).join('\n');
    const name = document.createElement('span');
    name.className = 'history-name';
    name.textContent = m.name;
    const size = document.createElement('span');
    size.className = 'history-size';
    size.textContent = formatSize(m.size);
    btn.append(name, size);
    btn.addEventListener('click', () => loadFromHistory(m));
    const li = document.createElement('li');
    li.appendChild(btn);
    ui.historyList.appendChild(li);
  }
  // Always five slots. The empty ones hold the box open, so one more file does
  // not push the steps below it down.
  for (let i = entries.length; i < HISTORY_MAX; i++) {
    ui.historyList.appendChild(document.createElement('li'));
  }
  ui.historyBox.hidden = entries.length === 0;
  // The prompt is one line once the list is there, and fills the whole box
  // while it is not (CSS).
  document.body.classList.toggle('has-history', entries.length > 0);
}

/**
 * Back to the state of a freshly opened page: no document, no settings table,
 * no result. What the user left open in the settings block stays open -- that
 * is persisted and belongs to them, not to the file.
 */
function unloadFile() {
  state.doc = null;
  lastMessageKey = null;
  ui.fileName.textContent = '';
  ui.summary.textContent = '';
  ui.settingsBody.replaceChildren();
  setEnabled(false);
  resetOutputs();
  showMessages([]);
}

async function loadFromHistory(meta) {
  const file = await getHistoryFile(meta.id, meta.name);
  if (!file) {
    showMessages([{ level: 'error', code: 'E0',
                    text: 'That file is no longer in the browser store.' }]);
    await showHistory();
    return;
  }
  loadFile(file, meta);
}

function handleFiles(list) {
  const files = Array.from(list || []);
  if (files.length === 0) return;
  if (files.length > 1) {
    showMessages([{ level: 'error', code: 'E0', text: 'Please drop exactly one file.' }]);
    return;
  }
  loadFile(files[0]);
}

/* ----------------------------------------------------------------- Wiring */

/**
 * Briefly show a different label, then fall back. A second click extends the
 * display instead of cutting it short.
 */
function flash(node, text, back) {
  clearTimeout(node.flashTimer);
  node.textContent = text;
  node.flashTimer = setTimeout(() => { node.textContent = back; }, FLASH_MS);
}

/**
 * Freeze the measured width as a minimum width before flash() swaps the label
 * -- otherwise the neighbour in the same row moves along with it.
 */
function freezeWidth(node) {
  node.style.minWidth = node.getBoundingClientRect().width + 'px';
}

function wire() {
  // The labels the feedback falls back to are defined in the HTML.
  const copyLabel = ui.copyBtn.textContent;
  const downloadLabel = ui.downloadBtn.textContent;
  freezeWidth(ui.copyBtn);
  freezeWidth(ui.downloadBtn);

  ui.dropPrompt.addEventListener('click', () => ui.fileInput.click());
  ui.dropPrompt.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ui.fileInput.click(); }
  });
  // Clearing also resets the tool: the settings of a file whose copy was just
  // thrown away have no business standing there.
  ui.historyClear.addEventListener('click', async () => {
    await clearHistory();
    await showHistory();
    unloadFile();
  });
  ui.fileInput.addEventListener('change', ev => {
    handleFiles(ev.target.files);
    ev.target.value = '';        // otherwise the same file cannot be loaded again
  });

  for (const type of ['dragenter', 'dragover']) {
    ui.dropzone.addEventListener(type, ev => {
      ev.preventDefault(); ui.dropzone.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'dragend']) {
    ui.dropzone.addEventListener(type, () => ui.dropzone.classList.remove('is-over'));
  }
  ui.dropzone.addEventListener('drop', ev => {
    ev.preventDefault();
    ui.dropzone.classList.remove('is-over');
    handleFiles(ev.dataTransfer && ev.dataTransfer.files);
  });
  // Dropping next to the zone must not open the file in the browser
  window.addEventListener('dragover', ev => ev.preventDefault());
  window.addEventListener('drop', ev => ev.preventDefault());

  TESTS.forEach((t, i) => {
    t.wire(scheduleRebuild);
    const btn = el('tab-' + t.id);
    btn.addEventListener('click', () => {
      if (state.test !== t) selectTest(t);
    });
    // No wrap-around: a switch rebuilds the plan and costs close to a second
    // on large files. Stopping at the end keeps a held-down key from racing
    // round all three tests; Home and End take the place of the wrap.
    btn.addEventListener('keydown', ev => {
      const j = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? i + 1
              : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? i - 1
              : ev.key === 'Home' ? 0
              : ev.key === 'End' ? TESTS.length - 1 : -1;
      if (j < 0 || j >= TESTS.length) return;
      ev.preventDefault();
      if (TESTS[j] !== state.test) selectTest(TESTS[j]);
      el('tab-' + TESTS[j].id).focus();
    });
  });

  ui.downloadBtn.addEventListener('click', () => {
    if (!state.result || !state.plan) return;
    const warn = (code, text) => showMessages(state.plan.issues.concat([
      { level: 'warning', code, text }]));
    downloadLines(state.test.lines(state.doc, state.plan, state.result, warn), state.fileName);
    flash(ui.downloadBtn, 'Saved', downloadLabel);
  });

  // The template is a real link and stays one: no preventDefault, no simulated
  // click, only a brief label change. Right and middle click download without a
  // click event, so there the feedback rightly stays away.
  for (const a of document.querySelectorAll('.template-line a.fake-btn')) {
    const back = a.textContent;
    freezeWidth(a);
    a.addEventListener('click', () => flash(a, 'Saved', back));
  }

  ui.bestValue.addEventListener('change', selectionChanged);
  ui.canvas.addEventListener('click', ev => {
    if (ui.step5.disabled) return;
    const j = state.plan ? state.test.pick(ui.canvas, ev, state.plan) : -1;
    if (j < 0) return;
    ui.bestValue.value = String(j);
    selectionChanged();
  });

  // navigator.clipboard only exists in secure contexts — on a LAN over
  // http://<ip> it is simply not there. Hence the second path via a short-lived
  // textarea and execCommand; that one works without HTTPS as well, as long as
  // it runs inside the click event.
  const copyViaSelection = text => {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(box);
    box.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    box.remove();
    return ok;
  };

  ui.copyBtn.addEventListener('click', () => {
    const text = ui.bestOut.textContent;
    if (!text) return;
    const say = label => flash(ui.copyBtn, label, copyLabel);
    const fallback = () => say(copyViaSelection(text) ? 'Copied' : 'Copy failed');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => say('Copied'), fallback);
    } else {
      fallback();
    }
  });

  // A second route to the same selection as the field in step 5, for paging on
  // after a click. It follows the order of the series of values: left to right
  // for the pattern, bottom to top for the tower. Not so for the patches --
  // those lie on the bed as the slicer arranged them, where any bed navigation
  // would be guesswork.
  ui.canvas.addEventListener('keydown', ev => {
    if (ui.step5.disabled || !state.plan) return;
    const n = state.test.resultCount(state.plan);
    const cur = currentIndex(n);
    const j = ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? cur + 1
            : ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? cur - 1
            : ev.key === 'Home' ? 0
            : ev.key === 'End' ? n - 1 : null;
    if (j === null) return;
    ev.preventDefault();          // otherwise the page scrolls away under the preview
    if (j < 0 || j >= n) return;
    ui.bestValue.value = String(j);
    selectionChanged();
  });

  ui.settingsDetails.addEventListener('toggle', saveSettings);

  window.addEventListener('resize', redraw);
}

loadSettings();
wire();
selectTest(state.test);
setEnabled(false);
// Once at startup so that the box is not left empty. Not in resetOutputs():
// on an error that runs AFTER showMessages() and would wipe out the message
// just shown.
showMessages([]);
showHistory();
