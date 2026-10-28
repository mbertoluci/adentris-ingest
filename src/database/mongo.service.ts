import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Db, MongoClient } from 'mongodb';

/**
 * Owns the single MongoClient. Connects on init, so a bad connection fails the boot fast (C16),
 * and closes cleanly on SIGTERM. `j: true` so an acknowledged write is journaled - the basis for
 * answering 202 only after the event is durable.
 */
@Injectable()
export class MongoService implements OnModuleInit, OnApplicationShutdown {
  private client!: MongoClient;
  private database!: Db;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.client = new MongoClient(this.config.getOrThrow<string>('MONGO_URL'), {
      writeConcern: { j: true },
    });
    await this.client.connect();
    this.database = this.client.db(this.config.getOrThrow<string>('MONGO_DB'));
  }

  get db(): Db {
    return this.database;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client?.close();
  }
}
