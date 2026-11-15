import { writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from './document.js';

const out = process.argv[2] ?? '../docs/openapi.json';
writeFileSync(out, JSON.stringify(buildOpenApiDocument(), null, 2) + '\n');
console.log(`OpenAPI written to ${out}`);
