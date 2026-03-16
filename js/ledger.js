// BXP Ledger - Stores all exposure records in IndexedDB
// Everything stays on user's device. Nothing sent to server.

const DB_NAME = 'bxp-ledger';
const DB_VERSION = 1;
const STORE_NAME = 'records';

let db = null;

// Open the database (creates it if doesn't exist)
async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => {
      console.error('Database error:', request.error);
      reject(request.error);
    };
    
    request.onsuccess = () => {
      db = request.result;
      console.log('Database opened');
      resolve(db);
    };
    
    // This runs once when database is first created or upgraded
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      // Create a store (like a table) for records
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        
        // Create indexes for fast searching
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('geohash', 'geohash', { unique: false });
        store.createIndex('date', 'date', { unique: false });
        
        console.log('Database structure created');
      }
    };
  });
}

// Add one record to the ledger
async function addRecord(record) {
  if (!db) await openDB();
  
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    // Add date field for easier queries (YYYY-MM-DD)
    record.date = record.timestamp.split('T')[0];
    
    // Generate ID if not present
    if (!record.id) {
      record.id = `${record.timestamp}-${record.geohash}-${Date.now()}`;
    }
    
    const request = store.add(record);
    
    request.onsuccess = () => {
      console.log('Record added:', record.id);
      resolve(record.id);
    };
    
    request.onerror = () => {
      console.error('Error adding record:', request.error);
      reject(request.error);
    };
  });
}

// Get records with optional filters
async function getRecords(options = {}) {
  if (!db) await openDB();
  
  const {
    startDate,      // ISO date string or Date object
    endDate,        // ISO date string or Date object
    geohash,        // string
    limit = 1000,   // number
    recent = false  // if true, get newest first
  } = options;
  
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    
    // Create date range
    let range = null;
    if (startDate || endDate) {
      const start = startDate ? new Date(startDate) : new Date(0);
      const end = endDate ? new Date(endDate) : new Date();
      range = IDBKeyRange.bound(start.toISOString(), end.toISOString());
    }
    
    // Open cursor (newest first if recent=true)
    const cursorRequest = recent
      ? index.openCursor(range, 'prev')
      : index.openCursor(range);
    
    const records = [];
    
    cursorRequest.onsuccess = (event) => {
      const cursor = event.target.result;
      
      if (cursor && records.length < limit) {
        // Filter by geohash if needed
        if (!geohash || cursor.value.geohash === geohash) {
          records.push(cursor.value);
        }
        cursor.continue();
      } else {
        resolve(records);
      }
    };
    
    cursorRequest.onerror = () => {
      reject(cursorRequest.error);
    };
  });
}

// Get today's records
async function getTodaysRecords() {
  const today = new Date().toISOString().split('T')[0];
  
  return getRecords({
    startDate: `${today}T00:00:00Z`,
    endDate: `${today}T23:59:59Z`
  });
}

// Delete old records to save space (keeps last 30 days by default)
async function cleanupOldRecords(daysToKeep = 30) {
  if (!db) await openDB();
  
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysToKeep);
  
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const index = store.index('timestamp');
  
  const range = IDBKeyRange.upperBound(cutoff.toISOString());
  const cursorRequest = index.openCursor(range);
  
  let deletedCount = 0;
  
  cursorRequest.onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      cursor.delete();
      deletedCount++;
      cursor.continue();
    } else {
      console.log(`Cleaned up ${deletedCount} old records`);
    }
  };
}

// Export all records as JSON file
async function exportAll() {
  const records = await getRecords({ limit: 10000 });
  
  const blob = new Blob([JSON.stringify(records, null, 2)], { 
    type: 'application/json' 
  });
  
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bxp-export-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  
  URL.revokeObjectURL(url);
}

// Make functions available globally
window.BXPLedger = {
  openDB,
  addRecord,
  getRecords,
  getTodaysRecords,
  cleanupOldRecords,
  exportAll
};