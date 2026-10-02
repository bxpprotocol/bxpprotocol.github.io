# BXP Protocol Overview

## What is BXP?

BXP (Breathe Exposure Protocol) is an open file format and data exchange
protocol for recording, storing, and transmitting human atmospheric
exposure data over time.

BXP is to air quality data what MP4 is to video — a universal format
that any system can read, write, and exchange, owned by nobody,
usable by everyone.

## The Problem BXP Solves

Air pollution causes 7 million premature deaths annually.
The sensors to measure it exist and are getting cheaper every year.
The barrier is not hardware — it is data fragmentation.

Every sensor manufacturer, every government agency, every research
institution uses a different data format. Data that cannot communicate
with itself cannot be used to coordinate a response.

BXP is the universal language that ends this fragmentation.

## Core Concepts

### The .bxp File

A .bxp file (or .bxp.json) is a JSON document representing one or
more atmospheric exposure readings. Every .bxp file contains:

- When and where the measurement was taken
- What was measured (any combination of 31 atmospheric agents)
- How reliable the measurement is (quality flags)
- A composite health risk score (BXP-HRI, experimental)
- A cryptographic hash for integrity verification

Any device can generate a .bxp file. Any system can read it.

### The BXP-HRI (Experimental)

The BXP Health Risk Index is a composite score from 0-100 representing
overall atmospheric health risk. Unlike single-pollutant indices (US AQI,
European CAQI), BXP-HRI incorporates all available agents simultaneously,
weighted by their actual contribution to global disease burden (WHO DALYs).

**⚠️ Not clinically or epidemiologically validated. Do not use for medical decisions.**

BXP-HRI levels:
- 0-20:   CLEAN      — No restrictions
- 21-40:  MODERATE   — Sensitive groups: limit exertion
- 41-60:  ELEVATED   — Reduce heavy outdoor exertion
- 61-75:  HIGH       — Wear N95, close windows
- 76-90:  VERY_HIGH  — Avoid all outdoor activity
- 91-100: HAZARDOUS  — Emergency conditions

### The Federated Network

BXP is not a platform — it is a protocol. Like HTTP, nobody owns it.
Any organization can run a BXP node on their own infrastructure.
Nodes discover each other through a lightweight registry that maps
geographic areas to node URLs. Data stays with its owner.

## Who BXP is For

**Sensor manufacturers:** Provide a BXP export. Every application
that reads BXP can immediately use your sensor data.

**Environmental agencies:** Deploy a BXP node. Your monitoring
data becomes instantly interoperable with every other BXP source.

**Researchers:** Query any BXP node using the standard REST API.
One query format works for every data source.

**Developers:** Build applications on BXP. Your app works with
any data source that speaks BXP.

**Communities:** Run a community node. Your sensor network
contributes to the global picture without losing data sovereignty.

## License

Apache 2.0. Free forever. No royalties. No restrictions.
No gatekeepers. Ever.
