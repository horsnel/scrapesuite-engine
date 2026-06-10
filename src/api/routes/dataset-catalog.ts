/**
 * Dataset Catalog API Routes -- ScrapeSuite Engine
 *
 * REST API endpoints for dataset management including CRUD,
 * querying, versioning, and export.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { datasetCatalogManager } from '../../dataset-catalog';
import { DatasetExportFormat, DatasetQuery, DatasetVisibility, QueryFilter } from '../../dataset-catalog/types';

interface CreateDatasetBody {
  name: string;
  description: string;
  schema: { name: string; version: number; fields: any[] };
  category?: string;
  tags?: string[];
  visibility?: DatasetVisibility;
  owner_id?: string;
}

interface AddEntriesBody {
  entries: { data: Record<string, unknown>; source_url: string; scraped_at?: number }[];
  dataset_id?: string;
}

interface QueryDatasetBody {
  filters?: QueryFilter[];
  sort?: { field: string; direction: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
  fields?: string[];
}

interface ExportQuery {
  format?: DatasetExportFormat;
}

interface ListDatasetsQuery {
  category?: string;
  visibility?: DatasetVisibility;
  owner_id?: string;
}

interface InferSchemaBody {
  samples: Record<string, unknown>[];
  name: string;
}

export async function datasetCatalogRoutes(app: FastifyInstance): Promise<void> {

  // Create a new dataset
  app.post('/v1/datasets', async (req: FastifyRequest<{ Body: CreateDatasetBody }>, reply: FastifyReply) => {
    const { name, description, schema, category, tags, visibility, owner_id } = req.body;
    if (!name || !description || !schema) {
      return reply.status(400).send({ error: 'name, description, and schema are required' });
    }
    const dataset = await datasetCatalogManager.createDataset(name, description, schema, { category, tags, visibility, owner_id });
    return reply.status(201).send(dataset);
  });

  // List datasets
  app.get('/v1/datasets', async (req: FastifyRequest<{ Querystring: ListDatasetsQuery }>, reply) => {
    const { category, visibility, owner_id } = req.query;
    const datasets = await datasetCatalogManager.listDatasets({ category, visibility, owner_id } as any);
    return reply.send({ datasets });
  });

  // Get a dataset
  app.get('/v1/datasets/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const dataset = await datasetCatalogManager.getDataset(req.params.id);
    if (!dataset) return reply.status(404).send({ error: 'Dataset not found' });
    return reply.send(dataset);
  });

  // Delete a dataset
  app.delete('/v1/datasets/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    await datasetCatalogManager.deleteDataset(req.params.id);
    return reply.status(204).send();
  });

  // Add entries to a dataset
  app.post('/v1/datasets/:id/entries', async (req: FastifyRequest<{ Params: { id: string }; Body: AddEntriesBody }>, reply) => {
    const { entries } = req.body;
    if (!entries?.length) {
      return reply.status(400).send({ error: 'entries array is required' });
    }
    const result = await datasetCatalogManager.addEntries(req.params.id, entries.map(e => ({ ...e, dataset_id: req.params.id, scraped_at: e.scraped_at ?? Date.now() })));
    return reply.status(201).send(result);
  });

  // Query a dataset
  app.post('/v1/datasets/:id/query', async (req: FastifyRequest<{ Params: { id: string }; Body: QueryDatasetBody }>, reply) => {
    const { filters, sort, limit, offset, fields } = req.body;
    const query: DatasetQuery = {
      dataset_id: req.params.id,
      filters: filters ?? [],
      sort,
      limit: limit ?? 100,
      offset: offset ?? 0,
      fields,
    };
    const result = await datasetCatalogManager.queryDataset(query);
    return reply.send(result);
  });

  // Export a dataset
  app.get('/v1/datasets/:id/export', async (req: FastifyRequest<{ Params: { id: string }; Querystring: ExportQuery }>, reply) => {
    const format: DatasetExportFormat = req.query.format ?? 'JSON';
    const buffer = await datasetCatalogManager.exportDataset(req.params.id, format);
    const contentTypes: Record<string, string> = {
      JSON: 'application/json',
      CSV: 'text/csv',
      NDJSON: 'application/x-ndjson',
      SQL: 'text/plain',
      PARQUET: 'application/octet-stream',
    };
    reply.header('Content-Type', contentTypes[format] ?? 'application/json');
    reply.header('Content-Disposition', `attachment; filename="dataset-${req.params.id}.${format.toLowerCase()}"`);
    return reply.send(buffer);
  });

  // List dataset versions
  app.get('/v1/datasets/:id/versions', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const versions = await datasetCatalogManager.getVersionManager().listVersions(req.params.id);
    return reply.send({ versions });
  });

  // Get catalog stats
  app.get('/v1/datasets/stats', async (_req, reply) => {
    const stats = await datasetCatalogManager.getStats();
    return reply.send(stats);
  });

  // Infer schema from sample data
  app.post('/v1/datasets/infer-schema', async (req: FastifyRequest<{ Body: InferSchemaBody }>, reply) => {
    const { samples, name } = req.body;
    if (!samples?.length || !name) {
      return reply.status(400).send({ error: 'samples array and name are required' });
    }
    const schema = datasetCatalogManager.inferSchema(samples, name);
    return reply.send(schema);
  });
}
