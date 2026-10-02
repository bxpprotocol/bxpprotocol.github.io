# BXP Developer Guide

## Getting Started in 5 Minutes

### 1. Start the reference server

```bash
cd bxp-protocol/reference-server
pip install -r requirements.txt
python server.py
```

Server runs at http://localhost:5000
API docs at http://localhost:5000/docs

### 2. Generate your first .bxp file

```bash
cd bxp-protocol/cli
python bxp_cli.py generate --pm25 47.2 --lat 5.6037 --lon -0.1870
```

### 3. Validate the file

```bash
python bxp_cli.py validate reading_20260307_100000.bxp.json
```

### 4. Submit to the server

```bash
python bxp_cli.py submit \
    --server http://localhost:5000 \
    --file reading_20260307_100000.bxp.json
```

### 5. Query the data back

```bash
curl http://localhost:5000/bxp/v2/locations/s1v0g/latest
```

---

## Using the Python SDK

```python
from bxp_sdk import write_bxp, read_bxp, calculate_risk, BXPClient

# Calculate risk from values
risk = calculate_risk(pm25=67.0, no2=31.0, duration="24h")
print(risk["score"])    # 89.6
print(risk["level"])    # VERY_HIGH

# Write a .bxp file
record = write_bxp("my_reading.bxp.json", {
    "latitude":  5.6037,
    "longitude": -0.1870,
    "pm25":      47.2,
    "no2":       18.3,
    "temp":      29.0,
    "humidity":  78.0
})
print(record["bxpHri"])      # 61.2
print(record["bxpHriLevel"]) # HIGH

# Read a .bxp file
data = read_bxp("my_reading.bxp.json")
print(data["_integrityOk"])  # True — hash verified

# Submit to a BXP server
client = BXPClient("http://localhost:5000")
result = client.submit(
    latitude=5.6037, longitude=-0.1870,
    pm25=47.2, no2=18.3
)
print(result["readingId"])  # uuid
print(result["bxpHri"])     # 61.2
```

---

## Submitting Data via curl

```bash
# Submit a reading
curl -X POST http://localhost:5000/bxp/v2/readings \
  -H "Content-Type: application/json" \
  -d '{
    "readings": [{
      "deviceUuid": "550e8400-e29b-41d4-a716-446655440000",
      "latitude": 5.6037,
      "longitude": -0.1870,
      "agents": [
        {"agentId": "PM2_5", "value": 47.2, "unit": "ug/m3"},
        {"agentId": "NO2",   "value": 18.3, "unit": "ppb"}
      ]
    }]
  }'

# Get latest for location
curl http://localhost:5000/bxp/v2/locations/s1v0g/latest

# Get all readings
curl http://localhost:5000/bxp/v2/readings

# Calculate HRI
curl -X POST "http://localhost:5000/bxp/v2/hri/calculate?duration=24h&population=sensitive" \
  -H "Content-Type: application/json" \
  -d '[{"agentId": "PM2_5", "value": 67.0, "unit": "ug/m3"}]'
```

---

## BXP File Format Reference

Minimum valid .bxp.json:
```json
{
  "bxpVersion": "2.0",
  "deviceUuid": "550e8400-e29b-41d4-a716-446655440000",
  "geohash": "s1v0g",
  "timestampUs": 1741342800000000,
  "agents": [
    {"agentId": "PM2_5", "value": 47.2, "unit": "ug/m3"}
  ],
  "quality": {"flag": "UNVALIDATED", "confidence": 0.8}
}
```

Agent IDs:
- Particulates: PM1, PM2_5, PM10, BC
- Gases: CO, CO2, NO2, SO2, O3, H2S, NH3
- VOCs: TVOC, BENZ, FORM, TOLU, XYLE
- Environment: TEMP, RH, PRESS, UV
- Heavy metals: PB, HG, AS
- Derived: BXP_HRI

Quality flags: VALIDATED, UNVALIDATED, SUSPECT, INVALID

---

## Geohash Quick Reference

```python
from bxp_sdk import encode_geohash

# Encode Accra coordinates
gh = encode_geohash(5.6037, -0.1870, precision=7)
print(gh)  # s1v0gx4

# Precision guide:
# 5 chars = ~4.9 km  (district)
# 6 chars = ~1.2 km  (neighborhood)
# 7 chars = ~153 m   (street block)
# 8 chars = ~38 m    (building)
```

---

## CLI Reference

```bash
# Generate a .bxp file
bxp generate --pm25 47.2 --lat 5.60 --lon -0.18
bxp generate --pm25 47.2 --no2 18 --temp 29 --lat 5.60 --lon -0.18 --location "Accra"
bxp generate --pm25 47.2 --gh s1v0g --output my_reading.bxp.json

# Read a .bxp file
bxp read my_reading.bxp.json
bxp read my_reading.bxp.json --raw

# Validate a .bxp file
bxp validate my_reading.bxp.json

# Calculate HRI
bxp hri --pm25 67.0 --no2 31.0
bxp hri --pm25 67.0 --duration 24h --population sensitive

# Submit to server
bxp submit --server http://localhost:5000 --file my_reading.bxp.json

# Check server status
bxp server-status --server http://localhost:5000
```

---

## Contributing

BXP is open source (Apache 2.0).
GitHub: https://github.com/bxpprotocol/bxp-spec

To contribute:
1. Fork the repository
2. Create a feature branch
3. Submit a Pull Request

RFC process: All specification changes require a 30-day
public comment period via GitHub Issues before adoption.
