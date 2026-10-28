import type { Config } from 'jest';

// The pure domain has no Mongo and no Nest, so it runs as a single fast unit project. The
// integration project (real in-memory Mongo) is added once there is infrastructure to test.
const tsTransform: Config['transform'] = {
  '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
};

const config: Config = {
  maxWorkers: 1,
  projects: [
    {
      displayName: 'unit',
      rootDir: '.',
      testMatch: ['<rootDir>/src/domain/**/*.spec.ts'],
      transform: tsTransform,
      moduleFileExtensions: ['ts', 'js', 'json'],
    },
  ],
};

export default config;
