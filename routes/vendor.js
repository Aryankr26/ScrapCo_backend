const express = require('express');

const { verifyVendorSignature } = require('../vendor/security');
const { createServiceClient } = require('../supabase/client');

const router = express.Router();

// POST /api/vendor/accept
// Vendor backend calls this to accept a pickup.
// Protected by HMAC signature of the raw request body.
router.post('/accept', async (req, res) => {
  const sig = verifyVendorSignature(req);
  if (!sig.ok) return res.status(401).json({ success: false, error: sig.error });

  const { pickupId, assignedVendorRef, assignmentExpiresAt } = req.body || {};
  if (!pickupId) return res.status(400).json({ success: false, error: 'pickupId is required' });

  try {
    const supabase = createServiceClient();

    const update = {
      status: 'ACCEPTED',
      assigned_vendor_ref: assignedVendorRef || null,
      assignment_expires_at: assignmentExpiresAt || null,
    };

    const { data, error } = await supabase
      .from('pickups')
      .update(update)
      .eq('id', pickupId)
      .eq('status', 'REQUESTED')
      .select('id,status,assigned_vendor_ref,assignment_expires_at')
      .maybeSingle();

    if (error) return res.status(400).json({ success: false, error: error.message });
    if (!data) {
      return res.status(409).json({
        success: false,
        error: 'Pickup not found or not in REQUESTED status',
      });
    }

    return res.json({ success: true, pickup: data });
  } catch (e) {
    console.error('Vendor accept failed', e);
    return res.status(500).json({ success: false, error: 'Vendor accept failed' });
  }
});

module.exports = router;
