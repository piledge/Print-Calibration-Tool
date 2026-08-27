/**
 * history.js — the last few loaded files, kept in the browser.
 *
 * IndexedDB, not localStorage: a sliced tower is 5 MB and localStorage tops out
 * at about 5 MB for everything together. Stored are the raw bytes, not the
 * decoded text — for `.bgcode` a third of the size, and a stored entry goes
 * back in through `new File([blob], name)`, so reading it takes exactly the
 * path an upload takes.
 *
 * Metadata lives in its own store: blobs are only materialised when read
 * anyway, but keeping the list in separate records makes that independent of
 * the engine.
 *
 * Every call resolves; a browser that refuses the database (private mode
 * settings, no quota) turns the history off instead of breaking the upload.
 */

const DB_NAME = 'print_calibration_tool';
const DB_VERSION = 1;
const FILES = 'files';
const META = 'meta';

export const HISTORY_MAX = 5;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB refused to open'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  }).catch(e => { dbPromise = null; throw e; });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

function ask(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Same file twice is one entry: it moves back to the top instead of doubling. */
function idOf(file) {
  return [file.name, file.size, file.lastModified || 0].join('|');
}

/** Newest first. Returns [] whenever the database is not available. */
export async function listHistory() {
  try {
    const db = await openDb();
    const all = await ask(db.transaction(META).objectStore(META).getAll());
    return all.sort((a, b) => b.added - a.added).slice(0, HISTORY_MAX);
  } catch (e) {
    return [];
  }
}

/**
 * @param {File} file     the file as it came in
 * @param {string} summary  the line step 1 shows below the name
 * @returns {Promise<boolean>} false when nothing was stored
 */
export async function putHistory(file, summary, added) {
  try {
    const db = await openDb();
    const id = idOf(file);
    const meta = {
      id, added,
      name: file.name,
      size: file.size,
      summary: summary || '',
    };
    const tx = db.transaction([FILES, META], 'readwrite');
    tx.objectStore(FILES).put({ id, blob: new Blob([file]) });
    tx.objectStore(META).put(meta);
    await done(tx);
    await trim(db);
    return true;
  } catch (e) {
    return false;
  }
}

/** Everything past HISTORY_MAX goes, oldest first. */
async function trim(db) {
  const all = await ask(db.transaction(META).objectStore(META).getAll());
  if (all.length <= HISTORY_MAX) return;
  const drop = all.sort((a, b) => b.added - a.added).slice(HISTORY_MAX);
  const tx = db.transaction([FILES, META], 'readwrite');
  for (const m of drop) {
    tx.objectStore(FILES).delete(m.id);
    tx.objectStore(META).delete(m.id);
  }
  await done(tx);
}

/**
 * The stored file, ready to be read like an uploaded one.
 * @returns {Promise<File|null>}
 */
export async function getHistoryFile(id, name) {
  try {
    const db = await openDb();
    const rec = await ask(db.transaction(FILES).objectStore(FILES).get(id));
    if (!rec || !rec.blob) return null;
    return new File([rec.blob], name, { lastModified: Date.now() });
  } catch (e) {
    return null;
  }
}

/**
 * Loading an entry again makes it the most recent one, so it is not the next to
 * be dropped. Only the timestamp is written; the blob stays where it is.
 *
 * The caller hands the record back rather than its key: a read followed by a
 * write in one transaction would rely on the transaction still being alive
 * after the await, which is not guaranteed.
 */
export async function touchHistory(meta, added) {
  try {
    const db = await openDb();
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).put(Object.assign({}, meta, { added }));
    await done(tx);
    return true;
  } catch (e) {
    return false;
  }
}

export async function clearHistory() {
  try {
    const db = await openDb();
    const tx = db.transaction([FILES, META], 'readwrite');
    tx.objectStore(FILES).clear();
    tx.objectStore(META).clear();
    await done(tx);
    return true;
  } catch (e) {
    return false;
  }
}
