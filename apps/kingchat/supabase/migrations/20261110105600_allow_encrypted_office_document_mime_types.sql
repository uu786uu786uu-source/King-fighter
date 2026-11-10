update storage.buckets
set allowed_mime_types = array[
  'image/jpeg','image/png','image/webp','video/mp4','audio/mpeg','audio/mp4',
  'application/pdf','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain','text/csv','application/octet-stream'
]
where id='chat-media';