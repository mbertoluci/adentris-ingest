import type { Config } from 'jest';

// Two projects split by file suffix. Nothing (no globalSetup/setupFiles/testMatch) at
// the ROOT: a root preset would make every spec boot Mongo. maxWorkers:1 keeps the
// single memory-server singleton safe across the integration suite.
const tsTransform: Config['transform'] = {
  '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
};

const config: Config = {
  maxWorkers: 1,
  projects: [
    {
      displayName: 'unit',
      rootDir: '.',
      // pure, Mongo-free specs: the domain plus boundary helpers (e.g. the HTTP exception filter)
      testMatch: ['<rootDir>/src/domain/**/*.spec.ts', '<rootDir>/src/common/**/*.spec.ts'],
      transform: tsTransform,
      moduleFileExtensions: ['ts', 'js', 'json'],
    },
    {
      displayName: 'integration',
      rootDir: '.',
      testMatch: ['<rootDir>/**/*.integration-spec.ts'],
      transform: tsTransform,
      moduleFileExtensions: ['ts', 'js', 'json'],
    },
  ],
};

export default config;
