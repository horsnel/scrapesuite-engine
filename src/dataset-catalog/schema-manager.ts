/**
 * Schema Manager -- ScrapeSuite Engine
 *
 * Manages dataset schemas: creation, validation, migration,
 * type inference from sample data, and schema diffing.
 */

import { createChildLogger } from '../utils/logger';
import { DatasetField, DatasetFieldType, DatasetSchema, SchemaDiff } from './types';

const logger = createChildLogger('dataset-catalog:schema-manager');

// ---------- Schema Manager class ----------------------------------------------

export class SchemaManager {

  /** Create a new schema from a definition. */
  createSchema(name: string, fields: DatasetField[], version = 1): DatasetSchema {
    const validation = this.validateSchema({ name, version, fields });
    if (!validation.valid) {
      throw new Error(`Invalid schema: ${validation.errors.join(', ')}`);
    }
    logger.info({ name, fields: fields.length }, 'Schema created');
    return { name, version, fields };
  }

  /** Validate a schema definition. */
  validateSchema(schema: DatasetSchema): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!schema.name || schema.name.trim().length === 0) {
      errors.push('Schema name is required');
    }
    if (!schema.fields || schema.fields.length === 0) {
      errors.push('Schema must have at least one field');
    }

    const names = new Set<string>();
    for (const field of schema.fields) {
      if (!field.name || field.name.trim().length === 0) {
        errors.push('Field name is required');
      }
      if (names.has(field.name)) {
        errors.push(`Duplicate field name: ${field.name}`);
      }
      names.add(field.name);

      if (!this.isValidFieldType(field.type)) {
        errors.push(`Invalid field type "${field.type}" for field "${field.name}"`);
      }

      if (field.validation_regex) {
        try {
          new RegExp(field.validation_regex);
        } catch {
          errors.push(`Invalid regex for field "${field.name}": ${field.validation_regex}`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /** Validate data entry against a schema. */
  validateEntry(data: Record<string, unknown>, schema: DatasetSchema): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const field of schema.fields) {
      const value = data[field.name];

      if (value === undefined || value === null) {
        if (field.required && !field.nullable) {
          errors.push(`Missing required field: ${field.name}`);
        }
        continue;
      }

      // Type check
      if (!this.checkType(value, field.type)) {
        errors.push(`Field "${field.name}" expected type ${field.type}, got ${typeof value}`);
      }

      // Regex validation
      if (field.validation_regex && typeof value === 'string') {
        const regex = new RegExp(field.validation_regex);
        if (!regex.test(value)) {
          errors.push(`Field "${field.name}" value does not match pattern: ${field.validation_regex}`);
        }
      }

      // Warn about extra fields not in schema
      const schemaFields = new Set(schema.fields.map(f => f.name));
      for (const key of Object.keys(data)) {
        if (!schemaFields.has(key)) {
          warnings.push(`Extra field not in schema: ${key}`);
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /** Diff two schemas. */
  diffSchemas(schema1: DatasetSchema, schema2: DatasetSchema): SchemaDiff {
    const map1 = new Map(schema1.fields.map(f => [f.name, f]));
    const map2 = new Map(schema2.fields.map(f => [f.name, f]));

    const added: DatasetField[] = [];
    const removed: string[] = [];
    const modified: { name: string; old: DatasetField; new: DatasetField }[] = [];

    // Find added and modified
    for (const [name, field2] of map2) {
      const field1 = map1.get(name);
      if (!field1) {
        added.push(field2);
      } else if (JSON.stringify(field1) !== JSON.stringify(field2)) {
        modified.push({ name, old: field1, new: field2 });
      }
    }

    // Find removed
    for (const name of map1.keys()) {
      if (!map2.has(name)) {
        removed.push(name);
      }
    }

    return { added_fields: added, removed_fields: removed, modified_fields: modified };
  }

  /** Migrate a schema from one version to another. */
  migrateSchema(
    oldSchema: DatasetSchema,
    newFields: DatasetField[],
    removeFields: string[] = [],
    modifyFields: DatasetField[] = [],
  ): DatasetSchema {
    const fieldMap = new Map(oldSchema.fields.map(f => [f.name, f]));

    // Apply removals
    for (const name of removeFields) {
      fieldMap.delete(name);
    }

    // Apply modifications
    for (const field of modifyFields) {
      if (fieldMap.has(field.name)) {
        fieldMap.set(field.name, field);
      }
    }

    // Apply additions
    for (const field of newFields) {
      fieldMap.set(field.name, field);
    }

    return {
      name: oldSchema.name,
      version: oldSchema.version + 1,
      fields: [...fieldMap.values()],
    };
  }

  /** Infer a schema from sample data. */
  inferSchema(samples: Record<string, unknown>[], name: string): DatasetSchema {
    if (!samples.length) {
      return { name, version: 1, fields: [] };
    }

    const fieldStats = new Map<string, { types: Map<DatasetFieldType, number>; required: number; sample_values: unknown[] }>();

    for (const sample of samples) {
      for (const [key, value] of Object.entries(sample)) {
        if (!fieldStats.has(key)) {
          fieldStats.set(key, { types: new Map(), required: 0, sample_values: [] });
        }
        const stats = fieldStats.get(key)!;
        const inferredType = this.inferType(value);
        stats.types.set(inferredType, (stats.types.get(inferredType) ?? 0) + 1);
        if (value !== null && value !== undefined) {
          stats.required++;
        }
        if (stats.sample_values.length < 3) {
          stats.sample_values.push(value);
        }
      }
    }

    const fields: DatasetField[] = [];
    for (const [name, stats] of fieldStats) {
      // Pick most common type
      let bestType: DatasetFieldType = 'string';
      let bestCount = 0;
      for (const [type, count] of stats.types) {
        if (count > bestCount) {
          bestCount = count;
          bestType = type;
        }
      }

      const isRequired = stats.required > samples.length * 0.8;

      fields.push({
        name,
        type: bestType,
        description: `Inferred field from ${samples.length} samples`,
        required: isRequired,
        nullable: !isRequired,
      });
    }

    logger.info({ name, fields: fields.length, samples: samples.length }, 'Schema inferred from samples');
    return { name, version: 1, fields };
  }

  // ---------- Internal helpers ------------------------------------------------

  private isValidFieldType(type: string): boolean {
    return ['string', 'number', 'boolean', 'date', 'array', 'object', 'json'].includes(type);
  }

  private checkType(value: unknown, type: DatasetFieldType): boolean {
    switch (type) {
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number';
      case 'boolean': return typeof value === 'boolean';
      case 'date': return typeof value === 'string' && !isNaN(Date.parse(value));
      case 'array': return Array.isArray(value);
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'json': return typeof value === 'string' || typeof value === 'object';
      default: return true;
    }
  }

  private inferType(value: unknown): DatasetFieldType {
    if (value === null || value === undefined) return 'string';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') {
      if (!isNaN(Date.parse(value)) && value.length > 6) return 'date';
      return 'string';
    }
    if (typeof value === 'object') return 'object';
    return 'string';
  }
}
