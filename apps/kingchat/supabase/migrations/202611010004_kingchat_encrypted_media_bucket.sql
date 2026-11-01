-- Encrypted media blobs are stored as opaque bytes in the private chat-media bucket.
update storage.buckets
set allowed_mime_types = (
  select array_agg(distinct allowed_type)
  from unnest(
    coalesce(allowed_mime_types, array[]::text[]) || array['application/octet-stream']
  ) as allowed(allowed_type)
)
where name = 'chat-media';
