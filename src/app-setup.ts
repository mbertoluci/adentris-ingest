import { INestApplication, ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import { AppExceptionFilter } from './common/errors/app-exception.filter';

/**
 * The HTTP-boundary wiring shared by main.ts and the HTTP smoke test, so they cannot drift:
 * JSON-only body parsing with an explicit limit (C13), strict validation (whitelist, forbid
 * unknown fields, no implicit conversion), and the single exception filter. Requires the app to
 * be created with `bodyParser: false` so this is the only parser (no urlencoded, one limit).
 */
export function configureApp(app: INestApplication): void {
  app.use(json({ limit: '1mb' }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new AppExceptionFilter());
}
