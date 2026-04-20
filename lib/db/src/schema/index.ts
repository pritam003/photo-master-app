import { pgTable, text, boolean, integer, bigint, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const photosTable = pgTable("photos", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  filename: text("filename").notNull(),
  blobName: text("blob_name").notNull(),
  description: text("description"),
  contentType: text("content_type").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  width: integer("width"),
  height: integer("height"),
  thumbBlobName: text("thumb_blob_name"),     // 600×600 JPEG thumbnail (grid view)
  thumbWebpBlobName: text("thumb_webp_blob_name"), // 600×600 WebP thumbnail (modern browsers)
  previewBlobName: text("preview_blob_name"), // 1920px wide JPEG (lightbox view)
  lqipData: text("lqip_data"),               // base64 data URL of 64×64 blurred LQIP placeholder
  dominantColor: text("dominant_color"),     // hex color extracted from 1×1 resize e.g. "#a3b2c1"
  googleMediaItemId: text("google_media_item_id"), // Google Photos import dedup key
  favorite: boolean("favorite").default(false).notNull(),
  trashed: boolean("trashed").default(false).notNull(),
  trashedAt: timestamp("trashed_at"),
  hidden: boolean("hidden").default(false).notNull(),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  takenAt: timestamp("taken_at"),
  tags: text("tags"),
  locationName: text("location_name"),
}, (t) => [
  index("photos_user_uploaded_idx").on(t.userId, t.uploadedAt),
  index("photos_user_trashed_idx").on(t.userId, t.trashed),
  index("photos_user_hidden_idx").on(t.userId, t.hidden),
  index("photos_user_favorite_idx").on(t.userId, t.favorite),
  uniqueIndex("photos_google_item_idx").on(t.userId, t.googleMediaItemId),
]);

export const albumsTable = pgTable("albums", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  trashed: boolean("trashed").default(false).notNull(),
  trashedAt: timestamp("trashed_at"),
});

export const albumPhotosTable = pgTable("album_photos", {
  albumId: uuid("album_id").notNull().references(() => albumsTable.id, { onDelete: "cascade" }),
  photoId: uuid("photo_id").notNull().references(() => photosTable.id, { onDelete: "cascade" }),
});

export const albumSharesTable = pgTable("album_shares", {
  token: text("token").primaryKey(),
  albumId: uuid("album_id").notNull().references(() => albumsTable.id, { onDelete: "cascade" }),
  createdBy: text("created_by").notNull(),
  name: text("name"),                                        // human-readable label set by owner
  shareType: text("share_type").notNull().default("code"),  // 'code' | 'email'
  allowedEmails: text("allowed_emails"),                    // JSON array: '["a@b.com","c@d.com"]'
  permission: text("permission").notNull().default("view"), // 'view' | 'contribute'
  accessCodeHash: text("access_code_hash").notNull(),       // SHA-256 of the generated access code (empty for email shares)
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const shareLinksTable = pgTable("share_links", {
  token: text("token").primaryKey(),
  photoId: uuid("photo_id").notNull().references(() => photosTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const userSettingsTable = pgTable("user_settings", {
  userId: text("user_id").primaryKey(),
  archiveTotpSecret: text("archive_totp_secret"),
});

// ── Face recognition ──────────────────────────────────────────────────────────

/** A recognised person (cluster of similar faces belonging to one user). */
export const peopleTable = pgTable("people", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name"),
  coverFaceBlob: text("cover_face_blob"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("people_user_idx").on(t.userId),
]);

/** A single detected face within a photo, optionally linked to a person. */
export const photoFacesTable = pgTable("photo_faces", {
  id: uuid("id").defaultRandom().primaryKey(),
  photoId: uuid("photo_id").notNull().references(() => photosTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  personId: uuid("person_id").references(() => peopleTable.id, { onDelete: "set null" }),
  /** The persistedFaceId returned by Azure LargeFaceList addFace. */
  azurePersistedFaceId: text("azure_persisted_face_id"),
  /** Normalised 0-1 bounding box: {top, left, width, height} stored as JSON string. */
  boundingBox: text("bounding_box"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("photo_faces_photo_idx").on(t.photoId),
  index("photo_faces_user_person_idx").on(t.userId, t.personId),
]);

export const insertPhotoSchema = createInsertSchema(photosTable).omit({ id: true, uploadedAt: true });
export const insertAlbumSchema = createInsertSchema(albumsTable).omit({ id: true, createdAt: true });

export type Photo = typeof photosTable.$inferSelect;
export type Album = typeof albumsTable.$inferSelect;
export type AlbumPhoto = typeof albumPhotosTable.$inferSelect;
export type ShareLink = typeof shareLinksTable.$inferSelect;
export type AlbumShare = typeof albumSharesTable.$inferSelect;
export type Person = typeof peopleTable.$inferSelect;
export type PhotoFace = typeof photoFacesTable.$inferSelect;
export type InsertPhoto = z.infer<typeof insertPhotoSchema>;
export type InsertAlbum = z.infer<typeof insertAlbumSchema>;
