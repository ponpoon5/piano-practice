// iPad の中だけに保存する(IndexedDB)。動画もここに入れる。

const DB_NAME = 'piano-practice';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('songs', { keyPath: 'id' });
      db.createObjectStore('videos');
      db.createObjectStore('kv');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let out;
    Promise.resolve(fn(t.objectStore(store))).then((v) => (out = v), reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('保存できませんでした(容量不足かもしれません)'));
  });
}

export const store = {
  async songs() {
    return tx('songs', 'readonly', (s) => req(s.getAll()));
  },
  async putSong(song) {
    return tx('songs', 'readwrite', (s) => req(s.put(song)));
  },
  async deleteSong(id) {
    await tx('songs', 'readwrite', (s) => req(s.delete(id)));
    await tx('videos', 'readwrite', (s) => req(s.delete(id)));
  },
  async video(id) {
    return tx('videos', 'readonly', (s) => req(s.get(id)));
  },
  async putVideo(id, blob) {
    return tx('videos', 'readwrite', (s) => req(s.put(blob, id)));
  },
  async get(key, def) {
    const v = await tx('kv', 'readonly', (s) => req(s.get(key)));
    return v === undefined ? def : v;
  },
  async set(key, value) {
    return tx('kv', 'readwrite', (s) => req(s.put(value, key)));
  },
  async persist() {
    try {
      if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
    } catch (e) {}
    return false;
  },
  async usage() {
    try {
      if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
    } catch (e) {}
    return null;
  },
};
