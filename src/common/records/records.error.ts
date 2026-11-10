import { AppException } from '../errors/app-exception';

/** Write did not durably land (Mongo down/timeout). Transient: the sender retries the body. */
export class PersistenceUnavailable extends AppException {
  constructor() {
    super('persistence_unavailable', 503);
  }
}

/** E11000 on an index other than eventId: a permanent bug, never swallowed as a dedup hit. */
export class IndexConflict extends AppException {
  constructor() {
    super('index_conflict', 500);
  }
}
