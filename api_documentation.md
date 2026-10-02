# BXP API Reference v2.0

Base URL: `http://localhost:5000/bxp/v2/`
Interactive docs: `http://localhost:5000/docs`

All responses use the standard BXP envelope:
```json
{
  "status": "ok",
  "bxpVersion": "2.0",
  "requestId": "uuid",
  "timestamp": "ISO8601",
  "data": { ... },
  "errors": []
}
```

---

## POST /readings

Submit one or more readings.

**Request body:**
```json
{
  "readings": [
    {
      "deviceUuid": "550e8400-e29b-41d4-a716-446655440000",
      "latitude": 5.6037,
      "longitude": -0.1870,
      "agents": [
        { "agentId": "PM2_5", "value": 47.2, "unit": "ug/m3" },
        { "agentId": "NO2",   "value": 18.3, "unit": "ppb"   }
      ]
    }
  ]
}
```

**Response 201:**
```json
{
  "status": "ok",
  "data": {
    "submitted": 1,
    "readings": [
      {
        "readingId": "uuid",
        "geohash": "s1v0gx4",
        "bxpHri": 61.2,
        "bxpHriLevel": "HIGH",
        "qualityFlag": "UNVALIDATED"
      }
    ]
  }
}
```

---

## GET /readings

Get all readings with optional filters.

**Query parameters:**
- `geohash` — filter by geohash prefix (e.g. `s1v0`); must be valid geohash characters
- `agent` — only readings that include this agent (e.g. `PM2_5`)
- `quality` — filter by quality flag (`VALIDATED`, `UNVALIDATED`, etc.)
- `from_ts`, `to_ts` — observation time range, microseconds
- `limit` — max records (default 50, 1–200; out of range is a 422)
- `offset` — pagination offset (≥ 0)
- `format=binary` — return one native `.bxp` container instead of JSON

`total` in the response counts every match, so `offset`/`limit` paging is consistent with any filter.

**Example:** `GET /bxp/v2/readings?geohash=s1v0&limit=10`

---

## GET /readings/{id}

Get a specific reading by ID.

**Example:** `GET /bxp/v2/readings/550e8400-e29b-41d4-a716-446655440000`

---

## GET /locations/{geohash}/latest

Get the most recent reading for a geohash location.

Minimum geohash precision: 5

**Example:** `GET /bxp/v2/locations/s1v0g/latest`

**Response:**
```json
{
  "data": {
    "geohash": "s1v0g",
    "reading": { ... },
    "bxpHri": 61.2,
    "bxpHriLevel": "HIGH",
    "bxpHriColor": "#CC0000"
  }
}
```

---

## GET /locations/{geohash}/history

Get reading history for a geohash.

**Query:** `limit` (default 50, max 500)

---

## GET /agents

List all supported atmospheric agents.

**Response:**
```json
{
  "data": {
    "agents": [
      {
        "agentId": "PM2_5",
        "name": "Fine Particulate Matter",
        "unit": "μg/m³",
        "whoLimit": 15.0,
        "hriWeight": 0.35
      }
    ],
    "count": 17
  }
}
```

---

## POST /hri/calculate

Calculate BXP_HRI from agent values.

**Query parameters:**
- `duration` — `1h` | `8h` | `24h` (default `1h`)
- `population` — `general` | `sensitive` (default `general`)

**Request body:**
```json
[
  { "agentId": "PM2_5", "value": 67.0, "unit": "ug/m3" },
  { "agentId": "NO2",   "value": 31.0, "unit": "ppb"   }
]
```

**Response:**
```json
{
  "data": {
    "hri": {
      "score": 72.4,
      "level": "HIGH",
      "color": "#CC0000",
      "breakdown": {
        "PM2_5": { "value": 67.0, "normalizedRisk": 1.0, "contribution": 0.35 },
        "NO2":   { "value": 31.0, "normalizedRisk": 0.48, "contribution": 0.072 }
      }
    }
  }
}
```

---

## GET /nearby

The closest *useful* observation for someone with no sensor of their own. Candidates
within `radiusM` and `maxAgeS` are ranked by distance, freshness and quality together,
so a fresh validated reading 400 m away can beat a stale one 50 m away.

**Query parameters:** `lat`, `lon` (required); `radiusM` (default 2000, 1–50000);
`maxAgeS` (default 3600); `agent`; `minQuality` (`SUSPECT`, `UNVALIDATED` (default),
`VALIDATED`; `INVALID` is never returned); `limit` (default 1, max 50).

**Example:** `GET /bxp/v2/nearby?lat=5.6037&lon=-0.187&radiusM=1500&agent=PM2_5`

Each result carries `distanceM` and `relevanceScore`. Anonymous submissions are stored
at geohash-5 precision (about 5 km), so their reported position is a cell centre; only
readings from registered devices resolve to metre-level positions.

---

## DELETE /readings/{id}

Requires `Authorization: Bearer <device token>`. Only the device that submitted the
reading may delete it (403 otherwise). The reading's content is erased and cannot be
recovered; a content-free tombstone remains so the deletion replicates. Returns a
`deletionProof`.

---

## GET /sync

Federation pull: the changes on this node after a cursor, oldest first.

**Query parameters:** `since` (opaque cursor, default `0`), `limit` (default 500, max 2000).

**Response:** `data.readings` plus `nextCursor`. Store `nextCursor` and send it as `since`
next time. The cursor is an ingest sequence, **not** a timestamp: late-arriving readings
are never skipped and a bogus timestamp cannot stall replication.

A deleted reading arrives as `{"readingId": "...", "deleted": true, "deletionProof": "..."}`.
A replica must erase its copy. Every reading carries its origin `nodeId`.

If the node sets `BXP_NODE_SYNC_TOKEN`, send `Authorization: Bearer <token>`.

---

## GET /health

Server health check.

**Response:**
```json
{
  "status": "ok",
  "data": {
    "nodeType": "community",
    "bxpVersion": "2.0",
    "readingCount": 10,
    "uptime": "operational"
  }
}
```

---

## Error Codes

| Code      | HTTP | Meaning                              |
|-----------|------|--------------------------------------|
| BXP_4001  | 400  | No readings provided                 |
| BXP_4002  | 400  | Reading has no agents                |
| BXP_4003  | 400  | Geohash precision too low            |
| BXP_4006  | 400  | Payload hash mismatch                |
| BXP_4010  | 401  | Missing or invalid device token      |
| BXP_4030  | 403  | Device UUID mismatch                 |
| BXP_4040  | 404  | Reading not found                    |
| BXP_4041  | 404  | No readings for location             |
| BXP_5000  | 500  | Internal server error                |
