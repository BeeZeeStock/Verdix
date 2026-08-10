-- Remembill usage-pull connector.
-- connector NULL (default) = today's generic pull_endpoint_url mechanism, unchanged.
-- connector = 'remembill'  = lib/connectors/usage/remembill.ts handles the pull
--   (hardcoded URL shape, YYYYMMDD dates, multi-metric response) instead of
--   pull_endpoint_url/pull_auth_token/pull_param_name, which are ignored for
--   these meters.
-- response_metric_key: the exact `metric` string this meter reads out of the
--   connector's multi-metric response (e.g. 'INVOICE_SENT'). Falls back to
--   meter_key.toUpperCase() when null.
ALTER TABLE billing_meters
  ADD COLUMN IF NOT EXISTS connector           text,
  ADD COLUMN IF NOT EXISTS response_metric_key text;

-- Platform meters (org_id NULL) for Remembill-billed enterprises. Any org's
-- confirmed contract_meter_mappings can reference these — pricing stays
-- per-job via contract_meter_mappings, same as every other meter.
INSERT INTO billing_meters (org_id, meter_key, display_name, unit_label, description, connector, response_metric_key)
VALUES
  (NULL, 'invoice_sent',  'Invoices Sent',  'invoice',  'A customer invoice sent via Remembill',        'remembill', 'INVOICE_SENT'),
  (NULL, 'email_sent',    'Emails Sent',    'email',    'A payment reminder email sent via Remembill',  'remembill', 'EMAIL_SENT'),
  (NULL, 'sms_sent',      'SMS Sent',       'sms',      'A payment reminder SMS sent via Remembill',    'remembill', 'SMS_SENT'),
  (NULL, 'letter_sent',   'Letters Sent',   'letter',   'A physical collection letter sent via Remembill', 'remembill', 'LETTER_SENT'),
  (NULL, 'reminder_sent', 'Reminders Sent', 'reminder', 'A generic payment reminder sent via Remembill', 'remembill', 'REMINDER_SENT')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
