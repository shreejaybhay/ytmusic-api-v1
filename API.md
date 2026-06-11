# YTMusic API Endpoints

Base URL: `https://ytmusic-api-v1.vercel.app` (or `http://localhost:3000` locally)

---

## Health Check

### `GET /`

Returns a simple status message.

**Response:**
```json
{ "message": "YTMusic API is running" }
```

---

## YouTube Music Search

### `GET /api/search?q=<query>&type=<type>`

Search YouTube Music. Returns max ~20 results sorted by views.

**Query Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| `q` | Yes | Search query |
| `type` | No | Filter: `song`, `video`, `artist`, `album`, `playlist` |

**Response:**
```json
{
  "results": [
    {
      "id": "dQw4w9WgXcQ",
      "title": "Rick Astley - Never Gonna Give You Up (Official Music Video)",
      "type": "video",
      "artists": [{ "name": "Rick Astley", "id": "UCuAXFkgsw1L7xaCfnd5JJOw" }],
      "album": { "name": "Whenever You Need Somebody", "id": "MPREb_12345" },
      "duration": "3:32",
      "views": "1.5B views",
      "thumbnail": "https://i.ytimg.com/vi/..."
    }
  ]
}
```

---

## General YouTube Search (Paginated)

### `GET /api/search/all?q=<query>&type=<type>&page=<n>&upload_date=<date>&duration=<dur>`

Regular YouTube search with pagination. Each page returns ~20 results.

**Query Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| `q` | Yes | Search query |
| `type` | No | `video`, `channel`, `playlist`, `movie` |
| `page` | No | Page number (1, 2, 3...) |
| `upload_date` | No | `hour`, `today`, `week`, `month`, `year` |
| `duration` | No | `short` (<4min), `medium` (4-20min), `long` (>20min) |

**Response:**
```json
{
  "results": [
    {
      "id": "dQw4w9WgXcQ",
      "title": "Rick Astley - Never Gonna Give You Up",
      "type": "video",
      "channel": "Rick Astley",
      "views": "1.5B views",
      "duration": "3:32",
      "thumbnail": "https://i.ytimg.com/vi/...",
      "published": "15 years ago",
      "subscribers": null
    }
  ],
  "has_more": true
}
```

---

## Song Details

### `GET /api/song/:id`

Get detailed song info + stream URL.

**Response:**
```json
{
  "basic_info": { "title": "...", "duration": 212, ... },
  "stream_url": "https://rr1---sn-...googlevideo.com/videoplayback?..."
}
```

---

## Stream URL

### `GET /api/stream/:id`

Returns a playable stream URL (360p combined format).

**Response:**
```json
{ "url": "https://rr1---sn-...googlevideo.com/videoplayback?..." }
```

---

## Playlist

### `GET /api/playlist/:id`

Get playlist details (supports YTMusic playlist IDs).

---

## Album

### `GET /api/album/:id`

Get album details.

---

## Artist

### `GET /api/artist/:id`

Get artist details and discography.

---

## Home Feed

### `GET /api/home`

Get YouTube Music home feed (personalized recommendations).

---

## Explore

### `GET /api/explore`

Get trending/explore page content.

---

## Lyrics

### `GET /api/lyrics/:id`

Get song lyrics (if available).

**Response (success):**
```json
{
  "content": "...lyrics text...",
  "type": "MusicLyrics"
}
```

**Response (not found):**
```json
{ "lyrics": null, "message": "No lyrics available for this song" }
```

---

## Up Next

### `GET /api/upnext/:id`

Get the suggested "up next" queue for a song.

---

## Related

### `GET /api/related/:id`

Get related content for a song/video.

---

## Error Format

All endpoints return errors in this format:

```json
{ "error": "Error message description" }
```
