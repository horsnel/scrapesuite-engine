# Task 8 — Collector/Dataset System

## Agent
Collector

## Task
Implement a Collector/Dataset System — recurring data collection jobs that automatically scrape, parse, and store structured data.

## Implementation Summary

Created `/home/z/my-project/scrapesuite/scrapesuite-engine/src/collector/index.ts` (~580 lines)

### Architecture
- **Storage**: Redis-backed (consistent with session manager pattern). Collector definitions stored at `collector:{id}`, datasets at `dataset:{id}`, user collector sets at `collector:user:{userId}`, dataset lists at `collector:{collectorId}:datasets`.
- **Orchestrator Integration**: Lazy import of orchestrator to avoid circular dependency. Uses `orchestrator.processJob()` directly for synchronous pipeline.
- **Template Integration**: Uses `templateRegistry.getTemplate()` for validation and `templateRegistry.extractWithTemplate()` for data extraction.

### Public API (CollectorManager class)

| Method | Description |
|--------|-------------|
| `createCollector(definition)` | Create a new collector (validates template) |
| `getCollector(collectorId)` | Get collector definition by ID |
| `listCollectors(userId)` | List all collectors for a user |
| `updateCollector(collectorId, updates)` | Update partial collector fields |
| `deleteCollector(collectorId)` | Delete collector and references |
| `runCollector(collectorId)` | Execute a collector run synchronously |
| `getDataset(datasetId)` | Get a specific dataset by ID |
| `getLatestDataset(collectorId)` | Get most recent dataset for a collector |
| `getDelta(collectorId)` | Compare two most recent datasets |
| `listDatasets(collectorId, limit?)` | List datasets for a collector |
| `exportDataset(datasetId, format)` | Export as JSON or CSV |

### Key Design Decisions
1. **Synchronous pipeline** for `runCollector` — processes URLs in batches via `Promise.allSettled`, not async BullMQ jobs
2. **Pagination expansion** at URL resolution time for `url_param` and `offset` types; `next_link` delegates to scraper
3. **Delta detection** uses sorted JSON serialisation for deterministic comparison of nested data objects
4. **CSV export** derives headers from all successful records' data keys (not just first record)
5. **Webhook notifications** with HMAC-SHA256 signature (consistent with webhook dispatcher pattern from Task 5)
6. **10,000 record limit** per dataset to prevent memory issues

### TypeScript
- Zero new compilation errors
- All types exported: `CollectorDefinition`, `DatasetRecord`, `Dataset`, `DatasetDelta`, `CollectorRunResult`
