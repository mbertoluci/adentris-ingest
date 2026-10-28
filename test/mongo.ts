import { Db, MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ensureIndexes } from '../src/records/ensure-indexes';
import { RECORDS_COLLECTION } from '../src/records/record.types';

// Pinned to the major of the compose image (mongo:7). Downloaded to the default cache on
// first run; later runs are offline. Escape hatch: set MONGO_URI to point the suite at an
// already-running mongod (the compose one) and skip the in-memory server entirely.
const BINARY_VERSION = '7.0.14';
const TEST_DB = 'ingest_test';

let server: MongoMemoryServer | undefined;
let client: MongoClient | undefined;
let db: Db | undefined;

export async function getMongo(): Promise<Db> {
  if (db) {
    return db;
  }
  const uri = process.env.MONGO_URI;
  if (uri) {
    client = await MongoClient.connect(uri);
  } else {
    server = await MongoMemoryServer.create({ binary: { version: BINARY_VERSION } });
    client = await MongoClient.connect(server.getUri());
  }
  db = client.db(TEST_DB);
  await ensureIndexes(db);
  return db;
}

/** Clean the records between tests; indexes survive (never a test without them). */
export async function resetRecords(): Promise<void> {
  if (db) {
    await db.collection(RECORDS_COLLECTION).deleteMany({});
  }
}

export async function closeMongo(): Promise<void> {
  await client?.close();
  client = undefined;
  if (server) {
    await server.stop();
    server = undefined;
  }
  db = undefined;
}
