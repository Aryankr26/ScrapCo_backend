/**
 * backend/index.js
 *
 * This is the MAIN server file.
 *
 * What this backend does:
 * 1) Starts an Express server on port 3000
 * 2) Enables JSON parsing (express.json)
 * 3) Enables CORS so your mobile app can call this API
 * 4) Provides endpoints:
 *    - GET /               (health check)
 *    - GET /api/pickups    (list pickups)
 *    - POST /api/pickups   (create pickup)
 */

// Load environment variables from .env (if present)
require('dotenv').config();

const express = require('express');
const cors = require('cors');

// Routers
const pickupsRouter = require('./routes/pickups');
const scrapTypesRouter = require('./routes/scrapTypes');
const vendorRouter = require('./routes/vendor');
const ordersRouter = require('./routes/orders');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// -----------------------------
// MIDDLEWARE
// -----------------------------

// Enable CORS (Cross-Origin Resource Sharing)
// This allows your Expo app (running on a different device/port) to call this API.
app.use(cors());

// Parse JSON bodies and keep a copy of raw body for webhook signature verification.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

// Simple request logger (helpful for beginners)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// -----------------------------
// ROUTES
// -----------------------------

// 1) Health check
app.get('/', (req, res) => {
  res.send('ScrapCo backend running');
});

// 2) Pickup routes
// Mounts all routes from pickupsRouter under /api/pickups
app.use('/api/pickups', pickupsRouter);

// 3) Scrap types
app.use('/api/scrap-types', scrapTypesRouter);

// 4) Vendor callback routes (protected)
app.use('/api/vendor', vendorRouter);

// 5) Orders (dev-bypass list/details)
app.use('/api/orders', ordersRouter);

// 6) Admin portal (no-auth, server-enabled)
app.use('/api/admin', adminRouter);

// -----------------------------
// ERROR HANDLING
// -----------------------------

// If code throws an error, this middleware returns a safe JSON response.
// (For learning: Express recognizes this as an error handler because it has 4 args.)
app.use((err, req, res, next) => {
  console.log('Unexpected server error:', err);

  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
  });
});

// -----------------------------
// START SERVER
// -----------------------------

app.listen(PORT, () => {
  console.log(`ScrapCo backend listening on http://localhost:${PORT}`);
});
