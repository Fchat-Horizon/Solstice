// Shim for 'learn/store/worker.ts' in mobile context.
// Replaces the Worker-based profile store with a direct IndexedDB store,
// since Android WebView blocks Workers loaded from file:// URLs.
// The IndexedStore has the same interface; WorkerStore.open() just ignores
// the jsEndpointFile argument that points to the electron-only storeWorkerEndpoint.js.
const { IndexedStore } = require('../../learn/store/indexed');

class WorkerStore extends IndexedStore {
    constructor(db, dbName) {
        super(db, dbName);
    }

    static async open(jsEndpointFile, dbName) {
        return IndexedStore.open(dbName);
    }
}

module.exports = { WorkerStore };
