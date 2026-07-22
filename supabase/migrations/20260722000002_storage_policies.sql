-- Storage bucket and policies for verdix-files
-- Ensures the bucket exists and service_role can always read/write regardless of RLS.

INSERT INTO storage.buckets (id, name, public)
VALUES ('verdix-files', 'verdix-files', false)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'service_role_storage_full_access'
  ) THEN
    CREATE POLICY service_role_storage_full_access
      ON storage.objects FOR ALL TO service_role
      USING (bucket_id = 'verdix-files')
      WITH CHECK (bucket_id = 'verdix-files');
  END IF;
END $$;
