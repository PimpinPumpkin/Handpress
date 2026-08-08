/**
 * Keeping the work if the tab goes away.
 *
 * Everything here happens in the browser, so there is no account to save to and
 * nothing on a server to come back to. A closed tab, a crash or a stray reload
 * would otherwise take an afternoon's editing with it, and the warning on the
 * way out is only worth anything if there is something behind it.
 *
 * What is kept is the document as it currently stands, not the list of edits
 * that made it. Restoring is then exactly the same as opening a file, which is
 * the best tested path there is. The cost is the undo history, which is an
 * honest trade and is what the interface says.
 */

const DB_NAME = 'handpress';
const STORE = 'session';
const KEY = 'current';

/**
 * The largest document worth keeping, at 80 MB.
 *
 * Past that the browser starts refusing quota, and failing to save silently is
 * worse than not offering. Anything larger says so instead.
 */
export const AUTOSAVE_LIMIT = 80 * 1024 * 1024;

export interface SavedSession {
  name: string;
  bytes: Uint8Array;
  saved: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Keeps the document as it now stands.
 *
 * Failure is swallowed on purpose: private windows, a full disk and a browser
 * with storage turned off all end up here, and none of them is a reason to
 * interrupt somebody who is editing.
 */
export async function keep(name: string, bytes: Uint8Array): Promise<boolean> {
  if (bytes.length > AUTOSAVE_LIMIT) return false;
  try {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    await withStore('readwrite', (store) =>
      store.put({ name, bytes: copy, saved: Date.now() } satisfies SavedSession, KEY),
    );
    return true;
  } catch {
    return false;
  }
}

export async function recover(): Promise<SavedSession | null> {
  try {
    const saved = await withStore<SavedSession | undefined>('readonly', (store) => store.get(KEY));
    return saved?.bytes?.length ? saved : null;
  } catch {
    return null;
  }
}

export async function forget(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(KEY));
  } catch {
    // Nothing to be done about it, and nothing depends on it having worked.
  }
}

/** How long ago, in words, for a sentence offering the document back. */
export function howLongAgo(when: number): string {
  const minutes = Math.round((Date.now() - when) / 60000);
  if (minutes < 1) return 'a moment ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
