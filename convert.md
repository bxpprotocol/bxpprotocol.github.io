# Convert your air quality data into BXP

BXP is the open standard for atmospheric exposure data. If your data is in
OpenAQ, a vendor format, or raw sensor output, these examples show how to put
it into BXP in minutes. The code is real and runs.

## 1. OpenAQ

OpenAQ publishes air quality data as an open API. Convert it to BXP with the
importer shipped in the repository.

```bash
pip install bxp-sdk
python integrations/openaq_import.py
```

```python
from bxp_sdk import write_bxp

# OpenAQ measurement -> BXP record, source provenance preserved
write_bxp("accra.bxp.json", {
    "latitude": 5.6037,
    "longitude": -0.1870,
    "pm25": 47.2,
    "no2": 18.3,
    "source": "imported",   # provenance travels with the data
})
```

## 2. A sensor or device

If you run a BXP node, any client can query it. The REST API is the same for
every node.

```bash
curl "http://localhost:5000/bxp/v2/nearby?lat=5.6037&lon=-0.1870&radiusKm=25"
```

## 3. Any other format

BXP normalises units, applies quality control, and records corrections
separately from raw values. Feed it a JSON object and get a valid record back.

```python
from bxp_sdk import write_bxp

write_bxp("reading.bxp.json", {
    "latitude": 5.6037,
    "longitude": -0.1870,
    "pm25": 47.2,
    "no2": 18.3,
    "temp": 29.0,
    "source": "native",
})
```

## Validate your output

```bash
python cli/bxp_cli.py validate reading.bxp.json
```

Or use the browser validator: https://bxpprotocol.github.io/validator.html

## Cite it

doi:10.5281/zenodo.18906812

## Have a format we do not cover?

Open an issue or a discussion and we will add it.