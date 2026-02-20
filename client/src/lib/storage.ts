// ── Backend detection ─────────────────────────────────────────
// OPFS reads work everywhere. OPFS writes require createWritable, which
// landed in Safari 17.4. Older Safari falls back to IDB for all reads + writes.

let _useOpfs: boolean | null = null;

async function useOpfs(): Promise<boolean> {
  if (_useOpfs !== null) return _useOpfs;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("_probe", { create: true });
    const fh = await dir.getFileHandle("_probe", { create: true });
    _useOpfs = "createWritable" in fh;
    dir.removeEntry("_probe").catch(() => {});
    root.removeEntry("_probe", { recursive: true }).catch(() => {});
  } catch {
    _useOpfs = false;
  }
  return _useOpfs;
}

// ── OPFS helpers ──────────────────────────────────────────────

async function getDir(name: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

async function opfsWrite(dir: FileSystemDirectoryHandle, name: string, data: string): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await (handle as any).createWritable();
  await writable.write(data);
  await writable.close();
}

async function opfsRead(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    const fh = await dir.getFileHandle(name);
    return await fh.getFile().then((f) => f.text());
  } catch {
    return null;
  }
}

async function opfsClear(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  for (const name of ["identity", "entries"]) {
    try { await root.removeEntry(name, { recursive: true }); } catch { /* already gone */ }
  }
}

async function opfsListDays(): Promise<string[]> {
  const dir = await getDir("entries");
  const days: string[] = [];
  for await (const [name] of (dir as any).entries()) {
    if (name.endsWith(".json")) days.push(name.replace(".json", ""));
  }
  return days.sort().reverse();
}

// ── IDB fallback (Safari < 17.4) ─────────────────────────────

const IDB_NAME = "paper-hearts-fallback";
let _idb: IDBDatabase | null = null;

function openIdb(): Promise<IDBDatabase> {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => { _idb = req.result; resolve(_idb!); };
    req.onerror = () => reject(req.error);
  });
}

async function idbRead(key: string): Promise<string | null> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("files", "readonly").objectStore("files").get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbWrite(key: string, value: string): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("files", "readwrite").objectStore("files").put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbListDays(): Promise<string[]> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("files", "readonly").objectStore("files").getAllKeys();
    req.onsuccess = () => {
      const days = (req.result as string[])
        .filter((k) => k.startsWith("entries/") && k.endsWith(".json"))
        .map((k) => k.slice("entries/".length).replace(".json", ""))
        .sort()
        .reverse();
      resolve(days);
    };
    req.onerror = () => reject(req.error);
  });
}

async function idbClear(): Promise<void> {
  if (_idb) { _idb.close(); _idb = null; }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(IDB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
}

// ── Unified read / write / list / clear ───────────────────────

async function read(dirName: string, fileName: string): Promise<string | null> {
  if (await useOpfs()) {
    return opfsRead(await getDir(dirName), fileName);
  }
  return idbRead(`${dirName}/${fileName}`);
}

async function write(dirName: string, fileName: string, data: string): Promise<void> {
  if (await useOpfs()) {
    return opfsWrite(await getDir(dirName), fileName, data);
  }
  return idbWrite(`${dirName}/${fileName}`, data);
}

// ── Identity (keys + pair info) ──────────────────────────────

export interface StoredIdentity {
  publicKey: string; // base64
  encryptedKey: {
    salt: string;
    nonce: string;
    ciphertext: string;
  };
  prfEncryptedKey?: {
    credentialId: string; // base64
    nonce: string;        // base64
    ciphertext: string;   // base64
  };
  unlockMethod?: "passphrase" | "biometrics"; // undefined = passphrase (legacy)
  pairId: string | null;
  partnerPublicKey: string | null;
}

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  await write("identity", "identity.json", JSON.stringify(identity));
}

export async function loadIdentity(): Promise<StoredIdentity | null> {
  const data = await read("identity", "identity.json");
  if (!data) return null;
  return JSON.parse(data);
}

// ── Entries (one file per dayId) ─────────────────────────────

export interface StoredEntry {
  dayId: string;
  author: "me" | "partner";
  payload: string; // decrypted plaintext
  timestamp: string; // ISO 8601
}

export interface DayFile {
  entries: StoredEntry[];
}

export async function saveDay(dayId: string, day: DayFile): Promise<void> {
  await write("entries", `${dayId}.json`, JSON.stringify(day));
}

export async function loadDay(dayId: string): Promise<DayFile | null> {
  const data = await read("entries", `${dayId}.json`);
  if (!data) return null;
  return JSON.parse(data);
}

/** List all dayIds with stored entries, sorted descending. */
export async function listDays(): Promise<string[]> {
  if (await useOpfs()) return opfsListDays();
  return idbListDays();
}

/** Delete all local data. */
export async function clearAllLocalData(): Promise<void> {
  await opfsClear();
  await idbClear();
}
