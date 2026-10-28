export interface AppConfig {
  PORT: number;
  MONGO_URL: string;
  MONGO_DB: string;
  /** How long a worker holds a claimed event before the reaper may reclaim it. */
  LEASE_MS: number;
  /** Timeout on the external call; must be < LEASE_MS (C8) or a slow call livelocks. */
  EXTERNAL_TIMEOUT_MS: number;
  /** Simulated duration of the external side-effect (prod ~5s; lowered in tests/chaos). */
  EXTERNAL_MS: number;
  /** Max processing attempts before an event is parked as failed (C14). */
  MAX_ATTEMPTS: number;
  /** Number of concurrent worker loops. */
  CONCURRENCY: number;
  /** Idle backoff when there is no work to claim. */
  IDLE_MS: number;
  /** How often the reaper sweeps for expired leases and orphan ready events. */
  REAPER_MS: number;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

/**
 * Loaded once at boot. Invalid config throws here so the process fails fast before listening
 * (C16): a timeout >= lease (C8) or a non-positive concurrency are bugs, not runtime surprises.
 */
export function loadConfig(): AppConfig {
  const config: AppConfig = {
    PORT: int('PORT', 3000),
    // `||`, not `??`: an empty string (MONGO_URL=) should fall back to the default, not through
    MONGO_URL: process.env.MONGO_URL || 'mongodb://localhost:27017',
    MONGO_DB: process.env.MONGO_DB || 'ingest',
    LEASE_MS: int('LEASE_MS', 30_000),
    EXTERNAL_TIMEOUT_MS: int('EXTERNAL_TIMEOUT_MS', 10_000),
    EXTERNAL_MS: int('EXTERNAL_MS', 5_000),
    MAX_ATTEMPTS: int('MAX_ATTEMPTS', 5),
    CONCURRENCY: int('CONCURRENCY', 100),
    IDLE_MS: int('IDLE_MS', 200),
    REAPER_MS: int('REAPER_MS', 1_000),
  };

  const positive: Array<keyof AppConfig> = [
    'PORT',
    'LEASE_MS',
    'EXTERNAL_TIMEOUT_MS',
    'EXTERNAL_MS',
    'MAX_ATTEMPTS',
    'CONCURRENCY',
    'IDLE_MS',
    'REAPER_MS',
  ];
  for (const key of positive) {
    if ((config[key] as number) <= 0) {
      throw new Error(`${key} must be > 0`);
    }
  }
  if (config.EXTERNAL_TIMEOUT_MS >= config.LEASE_MS) {
    throw new Error('EXTERNAL_TIMEOUT_MS must be < LEASE_MS (C8)');
  }
  if (config.EXTERNAL_MS >= config.EXTERNAL_TIMEOUT_MS) {
    throw new Error('EXTERNAL_MS must be < EXTERNAL_TIMEOUT_MS (the call must fit its timeout)');
  }

  return config;
}
