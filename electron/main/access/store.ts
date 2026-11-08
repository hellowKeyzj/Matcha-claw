import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyChange, initialFacts } from './domain';
import { AccessError, type Mutation, type State } from './model';
import { parseFacts } from './validation';
import { acquireWriterLock } from './writer-lock';

export class AccessStore {
  private status: 'open' | 'unavailable' | 'closed' = 'open';

  private constructor(
    private readonly database: DatabaseSync,
    private readonly writer: Awaited<ReturnType<typeof acquireWriterLock>>,
  ) {}

  static async open(root: string): Promise<AccessStore> {
    let writer: Awaited<ReturnType<typeof acquireWriterLock>> | undefined;
    let database: DatabaseSync | undefined;
    try {
      writer = await acquireWriterLock(root);
      // node:sqlite has no SQLITE_OPEN_NOFOLLOW: check fixed files around opening inside the private directory,
      // without claiming openat/NtCreateFile protection against concurrent replacement by the same user.
      // The OS writer lock excludes business contention; never stall Electron Main for Rust's old 5s busy timeout.
      database = new DatabaseSync(join(root, 'access.sqlite'), { timeout: 0 });
      const store = new AccessStore(database, writer);
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      if (database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal'
        || database.prepare('PRAGMA synchronous').get()?.synchronous !== 2) throw new AccessError('unavailable');
      writer.verifyFiles();
      database.exec(`CREATE TABLE IF NOT EXISTS access_facts (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        revision INTEGER NOT NULL CHECK(revision>=0 AND revision<=9007199254740991),
        facts TEXT NOT NULL
      );`);
      database.exec('BEGIN IMMEDIATE');
      try {
        if (!database.prepare('SELECT 1 FROM access_facts WHERE singleton=1').get()) {
          database.prepare('INSERT INTO access_facts(singleton,revision,facts) VALUES(1,0,?)').run(JSON.stringify(initialFacts()));
        }
      } catch (error) { store.rollback(); throw error; }
      store.commit();
      writer.verifyFiles();
      store.read();
      return store;
    } catch (error) {
      // A failed close must retain writer.lock; a second owner cannot inherit uncertain custody.
      try { if (database?.isOpen) database.close(); writer?.close(); }
      catch { throw error instanceof AccessError && error.code === 'outcome-unknown' ? error : new AccessError('unavailable'); }
      throw error instanceof AccessError ? error : new AccessError('unavailable');
    }
  }

  read(): State {
    this.assertAvailable();
    try {
      const row = this.database.prepare('SELECT revision,facts FROM access_facts WHERE singleton=1').get();
      if (!row || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision)
        || row.revision < 0 || typeof row.facts !== 'string') throw new AccessError('unavailable');
      return { revision: row.revision, facts: parseFacts(JSON.parse(row.facts)) };
    } catch { throw new AccessError('unavailable'); }
  }

  mutate(command: Mutation): State {
    this.assertAvailable();
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) throw new AccessError('invalid-request');
    try { this.database.exec('BEGIN IMMEDIATE'); }
    catch { throw new AccessError('unavailable'); }
    let state: State;
    try {
      state = this.read();
      if (state.revision !== command.expectedRevision) throw new AccessError('conflict');
      applyChange(state.facts, command.change);
      if (state.revision === Number.MAX_SAFE_INTEGER) throw new AccessError('unavailable');
      state.revision += 1;
      const facts = JSON.stringify(state.facts);
      try {
        const updated = this.database.prepare('UPDATE access_facts SET revision=?,facts=? WHERE singleton=1').run(state.revision, facts);
        if (updated.changes !== 1) throw new AccessError('unavailable');
      } catch { this.status = 'unavailable'; throw new AccessError('unavailable'); }
    } catch (error) {
      this.rollback();
      throw error instanceof AccessError ? error : new AccessError('unavailable');
    }
    this.commit();
    return state;
  }

  close(): void {
    if (this.status === 'closed') return;
    this.status = 'unavailable';
    try {
      if (this.database.isOpen) this.database.close();
      this.writer.close();
      this.status = 'closed';
    } catch { throw new AccessError('unavailable'); }
  }

  private assertAvailable(): void {
    if (this.status !== 'open') throw new AccessError('unavailable');
  }

  private rollback(): void {
    try { if (this.database.isTransaction) this.database.exec('ROLLBACK'); }
    catch { this.status = 'unavailable'; throw new AccessError('unavailable'); }
  }

  private commit(): void {
    try { this.database.exec('COMMIT'); }
    catch {
      // COMMIT failure does not prove rollback. No reads or further mutations until explicit close/reopen.
      this.status = 'unavailable';
      throw new AccessError('outcome-unknown');
    }
  }
}
