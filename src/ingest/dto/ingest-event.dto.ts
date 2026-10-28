import { IsISO8601, IsNotEmpty, IsObject, IsString, MaxLength } from 'class-validator';

/**
 * Strict by construction: whitelist + forbidNonWhitelisted reject unknown fields, and implicit
 * conversion is OFF so a non-string patientId is rejected, never coerced (coercion corrupts the
 * dedup: two objects collapse to "[object Object]"). `data` is validated as an object here; the
 * service still rejects arrays (which @IsObject admits) and runs the hostile-input walk (C13).
 */
export class IngestEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  patientId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  type!: string;

  @IsISO8601({ strict: true })
  ts!: string;

  @IsObject()
  data!: Record<string, unknown>;
}
