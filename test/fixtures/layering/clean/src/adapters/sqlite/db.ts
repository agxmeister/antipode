import Database from 'better-sqlite3';
import { schema } from '../../core/domain/errors.ts';
import { open } from './open.ts';
export const db = [Database, schema, open];
