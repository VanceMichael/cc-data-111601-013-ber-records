import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    try { await this.listDeliveries(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveDeliveries([]);
    }
    return this;
  }
  async saveIndex(records) {
    await this.saveJson('index.json', records);
  }
  async saveDeliveries(deliveries) {
    await this.saveJson('deliveries.json', deliveries);
  }
  async saveJson(name, value) {
    const temporary = join(this.directory, `${name}-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, join(this.directory, name));
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async listDeliveries() {
    return JSON.parse(await readFile(join(this.directory, 'deliveries.json'), 'utf8'));
  }
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async acceptDelivery(entry, bytes) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const deliveries = await this.listDeliveries();
      const existing = deliveries.find(delivery => delivery.digest === digest
        && delivery.source === entry.source
        && (delivery.schema?.path ?? null) === (entry.schema?.path ?? null));
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const stored = { id: randomUUID(), digest, ...entry };
      deliveries.push(stored);
      await this.saveDeliveries(deliveries);
      return stored;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
}
