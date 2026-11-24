CREATE TABLE public_outlet_photos (
  file_id TEXT PRIMARY KEY REFERENCES files(id)
);
