import { OpenAPIHono } from '@hono/zod-openapi';
import { buildOpenApiDocument } from '@linguacast/contract';
import { Scalar } from '@scalar/hono-api-reference';
import { env } from './env';
import { defaultHook } from './http/default-hook';
import { apiRoutes } from './http/routes';
import { createSpaRoutes } from './http/spa.routes';
import { logger } from './lib/log';
import { toProblem } from './lib/problem';
import { SERVER_VERSION } from './version';

export const app = new OpenAPIHono({ defaultHook });

app.onError((err, c) => c.json(toProblem(err), 500));

// Mount order below is load-bearing: Hono composes matching handlers in registration order.
// Invisible from here: src/socket intercepts /api/socket.io/* on the underlying http.Server
// before Hono runs, so that path never reaches the /api/* 404 below.
app.route('/api', apiRoutes);
app.get('/api/openapi.json', (c) => c.json(buildOpenApiDocument(SERVER_VERSION)));
app.get('/api/docs', Scalar({ url: '/api/openapi.json' }));

// Before static serving: otherwise an unmatched /api/typo falls through to the SPA
// catch-all and returns index.html with a 200 to a fetch() caller.
app.all('/api/*', (c) =>
  c.json({ code: 'not_found', message: `No API endpoint for ${c.req.method} ${c.req.path}.` }, 404),
);

// Absent output is dev configuration. A present but malformed build is fatal.
const spaRoutes = createSpaRoutes(env.WEB_ROOT);
if (spaRoutes) {
  app.route('/', spaRoutes);
} else {
  logger('boot').info(`SPA serving disabled (no build output at ${env.WEB_ROOT})`);
}

// Covers the unmatched non-GET case, and the whole server when there is no SPA build.
app.notFound((c) => c.json({ code: 'not_found', message: 'Not found.' }, 404));
