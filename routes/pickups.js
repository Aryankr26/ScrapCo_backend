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

const { createAnonClientWithJwt } = require('../supabase/client');
const { getBearerToken } = require('../supabase/auth');

const router = express.Router();

// Dispatch service: responsible for finding vendors and sending offers
const dispatcher = require('../services/dispatcher');

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

    // RPC returns pickupId (uuid)
    const pickupId = data;

    console.log(`[DISPATCH] pickup_created pickupId=${pickupId}`);

    // Kick off dispatch in background (do not block response)
    try {
      if (pickupId) {
        dispatcher.dispatchPickup(pickupId).catch((e) => console.warn('[DISPATCH] dispatch_error', e));
      }
    } catch (e) {
      console.warn('[DISPATCH] dispatch_schedule_failed', e);
    }

    return res.status(201).json({ success: true, pickupId });
  } catch (err) {
    console.error('Error creating pickup:', err);
    return res.status(500).json({ success: false, error: 'Could not create pickup' });
  }
});

/**
 * GET /api/pickups/:id
 * Fetch a single pickup (status tracking)
 */
router.get('/:id', async (req, res) => {
  try {
    const jwt = getBearerToken(req);
    if (!jwt) return res.status(401).json({ success: false, error: 'Missing Authorization Bearer token' });

    let supabase;
    try {
      supabase = createAnonClientWithJwt(jwt);
    } catch (e) {
      return res.status(500).json({ success: false, error: e?.message || 'Supabase is not configured on server' });
    }

    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const { data, error } = await supabase
      .from('pickups')
      .select(
        'id,status,address,latitude,longitude,time_slot,assigned_vendor_ref,assignment_expires_at,cancelled_at,completed_at,created_at,' +
          'pickup_items(id,estimated_quantity,scrap_type_id,scrap_types(name))'
      )
      .eq('id', id)
      .maybeSingle();

    if (error) return res.status(400).json({ success: false, error: error.message });
    if (!data) return res.status(404).json({ success: false, error: 'pickup not found' });

    return res.json({
      success: true,
      pickup: {
        id: data.id,
        status: data.status,
        address: data.address,
        latitude: data.latitude,
        longitude: data.longitude,
        timeSlot: data.time_slot,
        assignedVendorRef: data.assigned_vendor_ref,
        assignmentExpiresAt: data.assignment_expires_at,
        cancelledAt: data.cancelled_at,
        completedAt: data.completed_at,
        createdAt: data.created_at,
        items: (data.pickup_items || []).map((it) => ({
          id: it.id,
          scrapTypeId: it.scrap_type_id,
          scrapTypeName: it.scrap_types?.name || null,
          estimatedQuantity: it.estimated_quantity,
        })),
      },
    });
  } catch (err) {
    console.error('Error fetching pickup:', err);
    return res.status(500).json({ success: false, error: 'Could not fetch pickup' });
  }
});

// After create we attempt dispatching (non-blocking)
// Note: the RPC above returns the `pickup` row; callers that use this
// route will receive the created pickup immediately while dispatch runs
// in the background.


module.exports = router;

/**
 * POST /api/pickups/accepted
 * Optional vendor notification endpoint: vendor can POST here to notify the customer backend
 * that it has accepted and notified its user. This will attempt to confirm acceptance via dispatcher.
 */
router.post('/accepted', async (req, res) => {
  // vendor should sign this request using same signature scheme
  const { verifyVendorSignature } = require('../vendor/security');
  const sig = verifyVendorSignature(req);
  if (!sig.ok) return res.status(401).json({ success: false, error: sig.error });

  const { pickupId, assignedVendorRef } = req.body || {};
  if (!pickupId) return res.status(400).json({ success: false, error: 'pickupId is required' });

  try {
    const dispatcher = require('../services/dispatcher');
    const result = await dispatcher.confirmVendorAcceptance(pickupId, assignedVendorRef);
    if (!result) return res.status(409).json({ success: false, error: 'Could not confirm acceptance' });
    return res.json({ success: true, pickup: result });
  } catch (e) {
    console.error('Pickup accepted notify failed', e);
    return res.status(500).json({ success: false, error: 'Pickup accepted notify failed' });
  }
});
