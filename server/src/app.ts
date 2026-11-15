import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { loadUser } from './middleware/auth.js';
import { errorHandler, notFoundHandler, requestId } from './middleware/errors.js';
import { buildOpenApiDocument } from './openapi/document.js';
import { api } from './routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          imgSrc: ["'self'", 'data:'],
        },
      },
    }),
  );
  app.use(cors({ origin: env.CORS_ORIGIN.split(','), credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  if (env.NODE_ENV !== 'test') {
    app.use(pinoHttp({ logger, customProps: (req) => ({ requestId: (req as express.Request).requestId }) }));
  }
  app.use(loadUser);

  const openapi = buildOpenApiDocument();
  app.get('/api/openapi.json', (_req, res) => {
    res.json(openapi);
  });
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'Safar API' }));

  app.use('/api/v1', api);
  app.use('/api', notFoundHandler);

  // In production the API also serves the built React app (single free-tier service).
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  const clientDistBuilt = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../client/dist');
  const dist = existsSync(clientDist) ? clientDist : existsSync(clientDistBuilt) ? clientDistBuilt : null;
  if (dist && env.NODE_ENV === 'production') {
    app.use(express.static(dist, { maxAge: '1h', index: false }));
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
