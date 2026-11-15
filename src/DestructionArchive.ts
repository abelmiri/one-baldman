import type { LaserSolid, SolidConnections } from './LaserGeometry'

export type ArchivedChunk = {
  solids: LaserSolid[]
  edges: Uint32Array
  colliderCells: Uint32Array
}

type StoredChunk = ArchivedChunk & { savedAt: number }

const DATABASE = 'one-baldman-destruction'
const STORE = 'chunks'
const VERSION = 1
const MAX_ORPHAN_AGE = 24 * 60 * 60 * 1000

/** IndexedDB-backed cold storage for CSG data that is not needed every frame. */
export class DestructionArchive {
  private database?: Promise<IDBDatabase | null>
  private keys = new Set<string>()

  constructor(private session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`) {}

  key(index: number) { return `${this.session}:${index}` }

  async store(key: string, solids: LaserSolid[], connections: SolidConnections,
    colliderCells: Map<LaserSolid, number>) {
    const indices = new Map(solids.map((cell, index) => [cell, index]))
    const edges: number[] = []
    for (const [cell, neighbors] of connections) {
      const a = indices.get(cell)
      if (a === undefined) continue
      for (const neighbor of neighbors) {
        const b = indices.get(neighbor)
        if (b !== undefined && a < b) edges.push(a, b)
      }
    }
    const cellPairs: number[] = []
    for (const [cell, colliderIndex] of colliderCells) {
      const cellIndex = indices.get(cell)
      if (cellIndex !== undefined) cellPairs.push(cellIndex, colliderIndex)
    }
    const value: StoredChunk = {
      savedAt: Date.now(), solids,
      edges: new Uint32Array(edges), colliderCells: new Uint32Array(cellPairs),
    }
    const stored = await this.request('readwrite', store => store.put(value, key))
    if (stored) this.keys.add(key)
    return stored
  }

  async load(key: string) {
    const value = await this.request<StoredChunk>('readonly', store => store.get(key))
    return value ?? null
  }

  async remove(key: string) {
    this.keys.delete(key)
    await this.request('readwrite', store => store.delete(key))
  }

  dispose() {
    const keys = [...this.keys]
    this.keys.clear()
    void this.open().then(database => {
      if (!database || !keys.length) return
      const transaction = database.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      keys.forEach(key => store.delete(key))
    })
  }

  private request<T = IDBValidKey>(mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>) {
    return this.open().then(database => new Promise<T | null>(resolve => {
      if (!database) { resolve(null); return }
      const transaction = database.transaction(STORE, mode)
      let result: T | null = null
      const request = operation(transaction.objectStore(STORE))
      request.onsuccess = () => {
        result = request.result
        if (mode === 'readonly') resolve(result)
      }
      request.onerror = () => resolve(null)
      transaction.onabort = () => resolve(null)
      // A successful put request can still belong to an aborted transaction. Do not
      // release the in-memory topology until IndexedDB has durably committed it.
      if (mode === 'readwrite') transaction.oncomplete = () => resolve(result)
    }))
  }

  private open() {
    this.database ??= new Promise(resolve => {
      if (typeof indexedDB === 'undefined') { resolve(null); return }
      const request = indexedDB.open(DATABASE, VERSION)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onerror = () => resolve(null)
      request.onsuccess = () => {
        const database = request.result
        database.onversionchange = () => database.close()
        resolve(database)
        this.removeOrphans(database)
      }
    })
    return this.database
  }

  private removeOrphans(database: IDBDatabase) {
    const transaction = database.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    const request = store.openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const value = cursor.value as Partial<StoredChunk>
      if (!value.savedAt || Date.now() - value.savedAt > MAX_ORPHAN_AGE) cursor.delete()
      cursor.continue()
    }
  }
}
