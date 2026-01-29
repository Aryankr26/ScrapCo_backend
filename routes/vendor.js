const express = require('express');

const { verifyVendorSignature } = require('../vendor/security');
const { createServiceClient } = require('../supabase/client');
const dispatcher = require('../services/dispatcher');

const router = express.Router();

// POST /api/vendor/accept
// Vendor backend calls this to accept a pickup.
// Protected by HMAC signature of the raw request body.
router.post('/accept', async (req, res) => {
  const sig = verifyVendorSignature(req);
  if (!sig.ok) return res.status(401).json({ success: false, error: sig.error });

  const { pickupId, assignedVendorRef, vendor_id, vendorId } = req.body || {};
  if (!pickupId) return res.status(400).json({ success: false, error: 'pickupId is required' });

  const vendorRef = assignedVendorRef || vendor_id || vendorId;
  if (!vendorRef) return res.status(400).json({ success: false, error: 'vendor_id (or assignedVendorRef) is required' });

  try {
    // Confirm acceptance through dispatcher which enforces assignment matching and state transitions
    const result = await dispatcher.confirmVendorAcceptance(pickupId, vendorRef);
    if (!result) {
      return res.status(409).json({ success: false, error: 'Pickup not found, not assigned to this vendor, or already assigned' });
    }

    return res.json({ success: true, pickup: result });
  } catch (e) {
    console.error('Vendor accept failed', e);
    return res.status(500).json({ success: false, error: 'Vendor accept failed' });
  }
});

// POST /api/vendor/location
// Vendor backend posts its latest location and endpoint info.
router.post('/location', async (req, res) => {
  const sig = verifyVendorSignature(req);
  if (!sig.ok) return res.status(401).json({ success: false, error: sig.error });

  const { vendorRef, latitude, longitude, active, offerUrl } = req.body || {};
  if (!vendorRef) return res.status(400).json({ success: false, error: 'vendorRef is required' });
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ success: false, error: 'latitude and longitude must be numbers' });
  }

  try {
    const supabase = createServiceClient();

    const row = {
      vendor_ref: vendorRef,
      last_latitude: latitude ?? null,
      last_longitude: longitude ?? null,
      offer_url: offerUrl || null,
      active: active === undefined ? true : !!active,
      updated_at: new Date().toISOString(),
    };

    // Upsert by vendor_ref (requires vendor_backends.vendor_ref to be unique in DB)
    const { data, error } = await supabase.from('vendor_backends').upsert([row], { onConflict: 'vendor_ref' }).select('*').maybeSingle();
    if (error) {
      console.warn('vendor location upsert error', error.message || error);
      return res.status(400).json({ success: false, error: error.message || 'Could not upsert vendor location' });
    }

    return res.json({ success: true, vendor: data });
  } catch (e) {
    console.error('Vendor location failed', e);
    return res.status(500).json({ success: false, error: 'Vendor location failed' });
  }
});

// POST /api/vendor/reject
// Vendor backend calls this to reject an offered pickup.
router.post('/reject', async (req, res) => {
  const sig = verifyVendorSignature(req);
  if (!sig.ok) return res.status(401).json({ success: false, error: sig.error });

  const { pickupId, assignedVendorRef, vendor_id, vendorId } = req.body || {};
  if (!pickupId) return res.status(400).json({ success: false, error: 'pickupId is required' });

  const vendorRef = assignedVendorRef || vendor_id || vendorId;
  if (!vendorRef) return res.status(400).json({ success: false, error: 'vendor_id (or assignedVendorRef) is required' });

  try {
    const result = await dispatcher.handleVendorRejection(pickupId, vendorRef);
    return res.json({ success: true, result: result || { ignored: true } });
  } catch (e) {
    console.error('Vendor reject failed', e);
    return res.status(500).json({ success: false, error: 'Vendor reject failed' });
  }
});

module.exports = router;

