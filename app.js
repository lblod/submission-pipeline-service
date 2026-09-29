// see https://github.com/mu-semtech/mu-javascript-template for more info

import { app, errorHandler } from 'mu';
import bodyParser from 'body-parser';
import { meldingHandler } from './lib/melding-route.js';
import { statusHandler, statusLimiter } from './lib/status-route.js';
import { startReconciliation } from './lib/reconciliation.js';

// support both application/json and application/ld+json content types
app.use(bodyParser.json({ type: 'application/ld+json' }));
app.use(bodyParser.json());

app.post('/melding', meldingHandler);
app.post('/status', statusLimiter, statusHandler);

startReconciliation().catch((error) => {
  console.error(`Could not start reconciliation: ${error.message}`);
});

// Routes handle their own errors; this catches the rest (e.g. malformed JSON).
// Must be registered last to be reachable.
app.use(errorHandler);
