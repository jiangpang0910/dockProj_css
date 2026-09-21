-- 0004: an auto-resolve can place one conflict as several bookings (a stay split across berths), so a conflict
-- remembers all of them. booking_id stays as the first one. No FK on array elements: a booking deleted later just
-- leaves a dangling id, which the API filters out on read.
ALTER TABLE conflict ADD COLUMN booking_ids uuid[] NOT NULL DEFAULT '{}';
UPDATE conflict SET booking_ids = ARRAY[booking_id] WHERE booking_id IS NOT NULL;
