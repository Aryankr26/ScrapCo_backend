/**
 * backend/routes/pickups.js
 *
 * This file defines pickup-related API routes.
 *
 * Routes in this file will be mounted at:
 *   /api/pickups
 *
 * So inside this router:
 * - GET /      means GET /api/pickups
 * - POST /     means POST /api/pickups
 */

const express = require('express');

const { createAnonClientWithJwt, createServiceClient } = require('../supabase/client');
const { getBearerToken } = require('../supabase/auth');
const { ensureDevProfile, isDevBypassAllowed, pickOrCreateDevCustomerId } = require('../supabase/devBypass');

const router = express.Router();

/**
 * Helper: Validate the incoming request body.
 * We return an error message string if invalid, or null if valid.
 */
function validatePickupBody(body) {
  // Basic checks for required fields.
  if (!body) return 'Request body is missing.';

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return 'items is required (array of { scrapTypeId, estimatedQuantity }).';
  }

  if (!body.address || String(body.address).trim() === '') {
    return 'address is required.';
  }

  if (!body.timeSlot || String(body.timeSlot).trim() === '') {
    return 'timeSlot is required.';
  }

  // latitude/longitude are optional but if provided must be numbers
  if (body.latitude != null && typeof body.latitude !== 'number') return 'latitude must be a number.';
  if (body.longitude != null && typeof body.longitude !== 'number') return 'longitude must be a number.';

  return null;
}

/**
 * GET /api/pickups
 * Returns all pickup requests.
 */
router.get('/', async (req, res) => {
  try {
    const jwt = getBearerToken(req);
    if (!jwt) return res.status(401).json({ success: false, error: 'Missing Authorization Bearer token' });

    let supabase;
    try {
      supabase = createAnonClientWithJwt(jwt);
    } catch (e) {
      return res.status(500).json({ success: false, error: e?.message || 'Supabase is not configured on server' });
    }

    // RLS should ensure customer only sees their rows.
    const { data, error } = await supabase
      .from('pickups')
      .select(
        'id,status,address,latitude,longitude,time_slot,assigned_vendor_ref,assignment_expires_at,cancelled_at,created_at,' +
          'pickup_items(id,estimated_quantity,scrap_type_id,scrap_types(name))'
      )
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ success: false, error: error.message });

    const pickups = (data || []).map((p) => ({
      id: p.id,
      status: p.status,
      address: p.address,
      latitude: p.latitude,
      longitude: p.longitude,
      timeSlot: p.time_slot,
      assignedVendorRef: p.assigned_vendor_ref,
      assignmentExpiresAt: p.assignment_expires_at,
      cancelledAt: p.cancelled_at,
      createdAt: p.created_at,
      items: (p.pickup_items || []).map((it) => ({
        id: it.id,
        scrapTypeId: it.scrap_type_id,
        scrapTypeName: it.scrap_types?.name || null,
        estimatedQuantity: it.estimated_quantity,
      })),
    }));

    res.json({ success: true, count: pickups.length, pickups });
  } catch (err) {
    console.error('Error fetching pickups:', err);
    res.status(500).json({ success: false, error: 'Could not fetch pickups' });
  }
});

/**
 * POST /api/pickups
 * Accepts JSON body, validates it, creates a pickup object, stores it, returns it.
 */
router.post('/', async (req, res) => {
  // req.body exists because we use express.json() middleware in index.js
  const errorMessage = validatePickupBody(req.body);

  if (errorMessage) {
    // 400 = Bad Request (client sent invalid data)
    return res.status(400).json({
      success: false,
      error: errorMessage,
    });
  }

  // Create pickup
  try {
    const jwt = getBearerToken(req);
    if (!jwt) return res.status(401).json({ success: false, error: 'Missing Authorization Bearer token' });

    let supabase;
    try {
      supabase = createAnonClientWithJwt(jwt);
    } catch (e) {
      return res.status(500).json({ success: false, error: e?.message || 'Supabase is not configured on server' });
    }

    // Recommended: use RPC so Postgres sets customer_id = auth.uid() and inserts items transactionally.
    const { data, error } = await supabase.rpc('create_pickup', {
      p_address: String(req.body.address).trim(),
      p_latitude: req.body.latitude ?? null,
      p_longitude: req.body.longitude ?? null,
      p_time_slot: String(req.body.timeSlot).trim(),
      p_items: req.body.items,
    });

    if (error) {
      const msg = error.message || 'Could not create pickup';
      // When the RPC doesn't exist yet, guide setup.
      if (/function create_pickup/i.test(msg) || /schema cache/i.test(msg)) {
        return res.status(501).json({
          success: false,
          error: 'Missing RPC create_pickup. Apply the Supabase SQL migration for RLS + RPC, then retry.',
        });
      }
      return res.status(400).json({ success: false, error: msg });
    }

    return res.status(201).json({ success: true, pickup: data });
  } catch (err) {
    console.error('Error creating pickup:', err);
    return res.status(500).json({ success: false, error: 'Could not create pickup' });
  }
});

/**
 * POST /api/pickups/dev
 * Dev-only: inserts a pickup using the service role (bypasses RLS).
 * Useful when the mobile app auth is temporarily bypassed.
 */
router.post('/dev', async (req, res) => {
  if (!isDevBypassAllowed()) {
    return res.status(403).json({
      success: false,
      error: 'Dev bypass is disabled on server. Set ALLOW_DEV_BYPASS=true to enable /api/pickups/dev.',
    });
  }

  const errorMessage = validatePickupBody(req.body);
  if (errorMessage) {
    return res.status(400).json({ success: false, error: errorMessage });
  }

  try {
    let supabase;
    try {
      supabase = createServiceClient();
    } catch (e) {
      return res.status(500).json({ success: false, error: e?.message || 'Supabase is not configured on server' });
    }

    let devCustomerId;
    try {
      devCustomerId = await pickOrCreateDevCustomerId(supabase);
    } catch (e) {
      return res.status(400).json({ success: false, error: e?.message || 'Could not select a dev customer.' });
    }

    try {
      await ensureDevProfile(supabase, devCustomerId);
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: e?.message || 'Could not ensure profile exists. Set DEV_CUSTOMER_ID to a valid auth.users id in backend/.env.',
      });
    }

    const pickupRow = {
      customer_id: devCustomerId,
      address: String(req.body.address).trim(),
      latitude: req.body.latitude ?? null,
      longitude: req.body.longitude ?? null,
      time_slot: String(req.body.timeSlot).trim(),
    };

    const { data: pickup, error: pickupErr } = await supabase
      .from('pickups')
      .insert([pickupRow])
      .select('id')
      .single();

    if (pickupErr) {
      return res.status(400).json({ success: false, error: pickupErr.message || 'Could not insert pickup' });
    }

    const pickupId = pickup.id;
    const itemRows = req.body.items.map((it) => ({
      pickup_id: pickupId,
      scrap_type_id: it.scrapTypeId,
      estimated_quantity: it.estimatedQuantity,
    }));

    const { error: itemsErr } = await supabase.from('pickup_items').insert(itemRows);
    if (itemsErr) {
      return res.status(400).json({ success: false, error: itemsErr.message });
    }

    return res.status(201).json({ success: true, pickupId });
  } catch (err) {
    console.error('Error creating pickup (dev):', err);
    return res.status(500).json({ success: false, error: 'Could not create pickup (dev)' });
  }
});

module.exports = router;
