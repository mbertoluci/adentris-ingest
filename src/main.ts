import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './app-setup';
import { PipelineService } from './pipeline/pipeline.service';

async function bootstrap(): Promise<void> {
  // bodyParser disabled so configureApp registers the only parser (JSON-only, one limit). Mongo
  // connects and ensures indexes during init (in MongoService), so a bad boot fails before
  // listen (C16).
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();
  configureApp(app);

  const config = app.get(ConfigService);
  await app.listen(config.getOrThrow<number>('PORT'));

  // Start the worker pool only after the server is listening, so the loop never runs inside a
  // test module and never races the boot (C16).
  app.get(PipelineService).start();
}

void bootstrap();
