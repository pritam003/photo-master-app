/**
 * Bundled royalty-free music tracks for the memory video feature.
 *
 * Drop royalty-free MP3 files (≤ 2 MB, 90–120 s) into:
 *   artifacts/api-server/src/assets/music/
 *
 * Good sources:
 *   • https://pixabay.com/music/
 *   • https://freemusicarchive.org/
 *
 * The `filePath` must be an absolute path resolved at runtime using import.meta.url.
 */

import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUSIC_DIR = path.join(__dirname, "..", "assets", "music");

export interface MusicTrack {
  id: string;
  name: string;
  genre: string;
  filePath: string;
}

export const MUSIC_TRACKS: MusicTrack[] = [
  {
    id: "cinematic",
    name: "Cinematic Journey",
    genre: "cinematic",
    filePath: path.join(MUSIC_DIR, "cinematic.mp3"),
  },
  {
    id: "joyful",
    name: "Joyful Moments",
    genre: "joyful",
    filePath: path.join(MUSIC_DIR, "joyful.mp3"),
  },
  {
    id: "nostalgia",
    name: "Sweet Nostalgia",
    genre: "nostalgia",
    filePath: path.join(MUSIC_DIR, "nostalgia.mp3"),
  },
  {
    id: "ambient",
    name: "Calm & Ambient",
    genre: "ambient",
    filePath: path.join(MUSIC_DIR, "ambient.mp3"),
  },
  {
    id: "celebration",
    name: "Celebration",
    genre: "celebration",
    filePath: path.join(MUSIC_DIR, "celebration.mp3"),
  },
];

export function findTrack(id: string): MusicTrack | undefined {
  return MUSIC_TRACKS.find((t) => t.id === id);
}
