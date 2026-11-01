-- Encrypted media is uploaded as opaque application/octet-stream bytes.
update storage.buckets
set allowed_mime_types = array[
  'image/jpeg','image/png','image/webp','video/mp4',
  'audio/mpeg','audio/mp4','application/pdf','application/octet-stream'
]
where id='chat-media';
