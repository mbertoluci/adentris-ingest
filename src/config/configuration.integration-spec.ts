import { loadConfig } from './configuration';

// Pure (no Mongo), but named *.integration-spec so it runs outside the domain-only unit project.
describe('loadConfig (C16 boot validation)', () => {
  const saved = { ...process.env };

  const clear = () => {
    for (const key of [
      'PORT',
      'MONGO_URL',
      'MONGO_DB',
      'LEASE_MS',
      'EXTERNAL_TIMEOUT_MS',
      'EXTERNAL_MS',
      'MAX_ATTEMPTS',
      'CONCURRENCY',
      'IDLE_MS',
      'REAPER_MS',
    ]) {
      delete process.env[key];
    }
  };

  beforeEach(clear);
  afterEach(() => {
    process.env = { ...saved };
  });

  it('applies sane defaults', () => {
    const config = loadConfig();
    expect(config.PORT).toBe(3000);
    expect(config.MONGO_DB).toBe('ingest');
    expect(config.EXTERNAL_MS).toBeLessThan(config.EXTERNAL_TIMEOUT_MS);
    expect(config.EXTERNAL_TIMEOUT_MS).toBeLessThan(config.LEASE_MS);
  });

  it('treats an empty MONGO_URL as the default, not an empty string', () => {
    process.env.MONGO_URL = '';
    expect(loadConfig().MONGO_URL).toContain('mongodb://');
  });

  it('fails fast when the external timeout is not under the lease (C8)', () => {
    process.env.EXTERNAL_TIMEOUT_MS = '30000';
    process.env.LEASE_MS = '30000';
    expect(() => loadConfig()).toThrow();
  });

  it('fails fast when the external call cannot fit its timeout', () => {
    process.env.EXTERNAL_MS = '10000';
    process.env.EXTERNAL_TIMEOUT_MS = '10000';
    expect(() => loadConfig()).toThrow();
  });

  it('fails fast on a non-positive duration', () => {
    process.env.REAPER_MS = '0';
    expect(() => loadConfig()).toThrow();
  });
});
