# Raw USB capture and replay

The Node USB transport can record every user-space-visible USB transaction before
semantic decoding. Old sessions can therefore be analysed again when the protocol
model improves.

## Recorded layers

- vendor control-transfer setup/data and responses;
- bulk OUT bytes including USB padding;
- bulk IN bytes exactly as returned by libusb;
- unpadded MCSP frames supplied to / returned from the protocol layer;
- UTC timestamps and monotonic microsecond timestamps;
- VID/PID/interface/endpoint metadata.

USB string descriptors are deliberately not queried by the capture layer.

## Start a read-only capture

    cd node
    npm install
    node cli.js --capture

Default output:

    local-captures/<timestamp>/
      session.json
      events.jsonl

Specific directory:

    node cli.js --capture ../my-private-session

## Replay

    node ../tools/replay-capture.js ../local-captures/<timestamp>

Machine-readable replay:

    node ../tools/replay-capture.js ../local-captures/<timestamp> --json

## Explain one frame

    node ../tools/explain-frame.js --direction=tx "30 07 0e 10 90 85 48 08 04"

The frame inspector intentionally shows both raw wire and logical addresses.

## Privacy

Raw protocol traffic can contain serials, bike identifiers, certificates, names,
or other bike-specific information. Generated capture folders are ignored by Git
and should not be committed to this public repository.

Raw hex is the source of truth. Decoded interpretations are derived and can be
regenerated later with newer protocol knowledge.
