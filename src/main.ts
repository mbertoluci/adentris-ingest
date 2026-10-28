import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './app-setup';

async function bootstrap(): Promise<void> {
  // bodyParser disabled so configureApp registers the only parser (JSON-only, one limit). Mongo
  // connects during init (in MongoService), so a bad boot fails before listen (C16).
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();
  configureApp(app);

  const config = app.get(ConfigService);
  await app.listen(config.getOrThrow<number>('PORT'));
}

void bootstrap();
