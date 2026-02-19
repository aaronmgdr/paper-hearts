// ── OPFS helpers ────────────────────────────────────────────

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function getDir(name: string): Promise<FileSystemDirectoryHandle> {
  const root = await getRoot();
  return root.getDirectoryHandle(name, { create: true });
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: string) {
  const handle = await dir.getFileHandle(name, { create: true });
  // Safari doesn't support createWritable() on OPFS — use sync access handle as fallback
  if ("createWritable" in handle) {
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  } else {
    const accessHandle = await (handle as any).createSyncAccessHandle();
    const encoded = new TextEncoder().encode(data);
    accessHandle.truncate(0);
    accessHandle.write(encoded, { at: 0 });
    accessHandle.flush();
    accessHandle.close();
  }
}

async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    const file = await dir.getFileHandle(name);
    const f = await file.getFile();
    return await f.text();
  } catch {
    return null;
  }
}

// ── Identity (keys + pair info) ─────────────────────────────

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
  const dir = await getDir("identity");
  await writeFile(dir, "identity.json", JSON.stringify(identity));
}

export async function loadIdentity(): Promise<StoredIdentity | null> {
  const dir = await getDir("identity");
  const data = await readFile(dir, "identity.json");
  if (!data) return null;
  return JSON.parse(data);
}

// ── Entries (one file per dayId) ────────────────────────────

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
  const dir = await getDir("entries");
  await writeFile(dir, `${dayId}.json`, JSON.stringify(day));
}

export async function loadDay(dayId: string): Promise<DayFile | null> {
  const dir = await getDir("entries");
  const data = await readFile(dir, `${dayId}.json`);
  if (!data) return null;
  return JSON.parse(data);
}

/** Delete all OPFS data — identity and all entries. */
export async function clearAllLocalData(): Promise<void> {
  const root = await getRoot();
  for (const dir of ["identity", "entries"]) {
    try { await root.removeEntry(dir, { recursive: true }); } catch { /* already gone */ }
  }
}

/** List all dayIds that have stored entries, sorted descending. */
export async function listDays(): Promise<string[]> {
  const dir = await getDir("entries");
  const days: string[] = [];
  for await (const [name] of (dir as any).entries()) {
    if (name.endsWith(".json")) {
      days.push(name.replace(".json", ""));
    }
  }
  return days.sort().reverse();
}
